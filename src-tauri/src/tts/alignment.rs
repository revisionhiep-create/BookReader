//! Hybrid acoustic-weighted word aligner for CC highlighting.
//!
//! Splits the display sentence using whitespace (matching the frontend word spans 1:1),
//! assigns relative speaking weights (syllable count + character length + punctuation pause),
//! and snaps predicted boundaries to nearby 10 ms RMS energy valleys in the 24 kHz waveform.

/// Sample span (in 24 kHz source PCM samples) assigned to a single display word.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WordTiming {
    pub word_index: usize,
    pub start_sample: usize,
    pub end_sample: usize,
}

/// Computes monotonic word timings covering `0..speech_pcm.len()`.
pub fn align_words(display_text: &str, speech_pcm: &[f32], sample_rate: u32) -> Vec<WordTiming> {
    let words: Vec<&str> = display_text.split_whitespace().collect();
    let total_samples = speech_pcm.len();
    if words.is_empty() || total_samples == 0 {
        return Vec::new();
    }
    let n = words.len();
    if n == 1 {
        return vec![WordTiming {
            word_index: 0,
            start_sample: 0,
            end_sample: total_samples,
        }];
    }

    let weights: Vec<f64> = words
        .iter()
        .enumerate()
        .map(|(i, w)| word_weight(w, i + 1 == n))
        .collect();
    let total_weight: f64 = weights.iter().sum::<f64>().max(1.0);

    // 10 ms RMS envelope for detecting active speech bounds and snapping word boundaries
    let sr = sample_rate.max(8000) as usize;
    let win = (sr / 100).max(1);
    let mut rms_frames = Vec::with_capacity(total_samples / win + 1);
    let mut peak_rms = 0.0_f32;
    let mut pos = 0;
    while pos < total_samples {
        let end = (pos + win).min(total_samples);
        let sum_sq: f32 = speech_pcm[pos..end].iter().map(|&s| s * s).sum();
        let rms = (sum_sq / (end - pos) as f32).sqrt();
        peak_rms = peak_rms.max(rms);
        rms_frames.push(rms);
        pos = end;
    }

    // Locate the active speech region so leading/trailing room tone doesn't skew all timings
    let (speech_start, speech_end) = if peak_rms >= 1e-6 && !rms_frames.is_empty() {
        let speech_thresh = (peak_rms * 0.08).max(0.006);
        let first_f = rms_frames.iter().position(|&e| e >= speech_thresh);
        let last_f = rms_frames.iter().rposition(|&e| e >= speech_thresh);
        if let (Some(f0), Some(f1)) = (first_f, last_f) {
            let s0 = f0 * win;
            let s1 = ((f1 + 1) * win).min(total_samples);
            if s1 > s0 && (s1 - s0) * 10 >= total_samples * 3 {
                (s0, s1)
            } else {
                (0, total_samples)
            }
        } else {
            (0, total_samples)
        }
    } else {
        (0, total_samples)
    };

    let speech_len = speech_end.saturating_sub(speech_start);
    if total_samples < n || speech_len < n {
        let mut boundaries = Vec::with_capacity(n + 1);
        boundaries.push(0usize);
        let mut acc_w = 0.0_f64;
        for w in weights.iter().take(n - 1) {
            acc_w += *w;
            let ideal = ((acc_w / total_weight) * total_samples as f64).round() as usize;
            let prev = *boundaries.last().unwrap_or(&0);
            boundaries.push(ideal.clamp(prev, total_samples));
        }
        boundaries.push(total_samples);
        return (0..n)
            .map(|i| WordTiming {
                word_index: i,
                start_sample: boundaries[i],
                end_sample: boundaries[i + 1].max(boundaries[i]),
            })
            .collect();
    }

    // Strictly increasing ideal boundary points across [speech_start, speech_end]
    let mut ideal = Vec::with_capacity(n + 1);
    ideal.push(speech_start);
    let mut acc_w = 0.0_f64;
    for (idx, w) in weights.iter().enumerate().take(n - 1) {
        acc_w += *w;
        let raw = speech_start + ((acc_w / total_weight) * speech_len as f64).round() as usize;
        let min_pos = *ideal.last().unwrap() + 1;
        let max_pos = speech_end.saturating_sub(n - 1 - idx).max(min_pos);
        ideal.push(raw.clamp(min_pos, max_pos));
    }
    ideal.push(speech_end);

    let max_cap = (sr * 75) / 1000;
    let mut boundaries = Vec::with_capacity(n + 1);
    boundaries.push(0usize);

    for k in 1..n {
        let left_span = ideal[k].saturating_sub(ideal[k - 1]);
        let right_span = ideal[k + 1].saturating_sub(ideal[k]);
        let max_left = (left_span * 25 / 100).min(max_cap);
        let max_right = (right_span * 25 / 100).min(max_cap);
        let win_lo = ideal[k].saturating_sub(max_left);
        let win_hi = (ideal[k] + max_right).min(total_samples);

        let snapped_center = if peak_rms >= 1e-6 && !rms_frames.is_empty() {
            let f_hi = (win_hi / win).min(rms_frames.len() - 1);
            let f_lo = (win_lo.saturating_sub(1) / win).min(f_hi);
            let radius = max_left.max(max_right).max(1) as f32;
            let mut best_pos = ideal[k];
            let mut best_cost = f32::MAX;

            for (offset, &energy) in rms_frames[f_lo..=f_hi].iter().enumerate() {
                let f = f_lo + offset;
                let center = (f * win + win / 2).min(total_samples).clamp(win_lo, win_hi);
                let norm_e = energy / peak_rms;
                let dist = center.abs_diff(ideal[k]) as f32 / radius;
                let cost = norm_e + 0.35 * dist * dist;
                if cost < best_cost {
                    best_cost = cost;
                    best_pos = center;
                }
            }
            best_pos
        } else {
            ideal[k]
        };

        let prev_boundary = *boundaries.last().unwrap_or(&0);
        let remaining_words = n - k;
        let min_sample = prev_boundary + 1;
        let max_sample = total_samples.saturating_sub(remaining_words).max(min_sample);
        boundaries.push(snapped_center.clamp(min_sample, max_sample));
    }
    boundaries.push(total_samples);

    (0..n)
        .map(|i| WordTiming {
            word_index: i,
            start_sample: boundaries[i],
            end_sample: boundaries[i + 1].max(boundaries[i]),
        })
        .collect()
}

/// Finds the active word index at a given 24 kHz source sample position.
pub fn word_index_at_sample(timings: &[WordTiming], sample: usize) -> usize {
    if timings.is_empty() {
        return 0;
    }
    match timings.binary_search_by(|t| {
        if sample < t.start_sample {
            std::cmp::Ordering::Greater
        } else if sample >= t.end_sample {
            std::cmp::Ordering::Less
        } else {
            std::cmp::Ordering::Equal
        }
    }) {
        Ok(i) => i,
        Err(i) => i.min(timings.len() - 1),
    }
}

fn word_weight(word: &str, is_last: bool) -> f64 {
    let letters: String = word.chars().filter(|c| c.is_alphanumeric()).collect();
    let syllables = estimate_syllables(&letters) as f64;
    let char_bonus = (letters.chars().count() as f64) * 0.14;
    let stripped = word.trim_end_matches(|c: char| matches!(c, '"' | '\'' | '”' | '’' | ')' | ']'));
    let punct_bonus = match stripped.chars().last() {
        Some(',') => 1.1,
        Some(';') | Some(':') => 1.7,
        Some('—') | Some('-') => 0.7,
        Some('.') | Some('!') | Some('?') if !is_last => 0.8,
        _ => 0.0,
    };
    (syllables + char_bonus + punct_bonus).max(0.9)
}

fn estimate_syllables(alpha_word: &str) -> usize {
    if alpha_word.is_empty() {
        return 1;
    }
    let mut count = 0usize;
    let mut prev_vowel = false;
    for ch in alpha_word.chars() {
        let is_v = matches!(
            ch.to_ascii_lowercase(),
            'a' | 'e' | 'i' | 'o' | 'u' | 'y'
        );
        if is_v && !prev_vowel {
            count += 1;
        }
        prev_vowel = is_v;
    }
    if alpha_word.to_ascii_lowercase().ends_with('e') && count > 1 {
        count -= 1;
    }
    count.max(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn produces_monotonic_timings_snapped_to_silence_valleys() {
        let sr = 24_000_usize;
        let mut pcm = vec![0.3_f32; sr / 2]; // word 1
        pcm.extend(std::iter::repeat_n(0.001_f32, sr / 10)); // quiet valley
        pcm.extend(std::iter::repeat_n(0.3_f32, sr / 2)); // word 2

        let timings = align_words("Hello world", &pcm, sr as u32);
        assert_eq!(timings.len(), 2);
        assert_eq!(timings[0].start_sample, 0);
        assert_eq!(timings[1].end_sample, pcm.len());
        assert!(timings[0].end_sample == timings[1].start_sample);
        // Snapped inside or very near the quiet valley around 12000..14400
        assert!(timings[0].end_sample >= 11_000 && timings[0].end_sample <= 15_000);
    }

    #[test]
    fn short_word_clusters_near_comma_pause_never_collapse() {
        let sr = 24_000_usize;
        let text = "Plant it in an earth vein through which spiritual energy flows, and a Spirit Stone Mine will form around that point.";
        let words: Vec<&str> = text.split_whitespace().collect();
        let n = words.len();

        // 5 seconds of active speech with a deep 220 ms pause after "flows,"
        let total = sr * 5;
        let mut pcm = vec![0.25_f32; total];
        let pause_start = sr * 22 / 10;
        let pause_end = pause_start + (sr * 220) / 1000;
        pcm[pause_start..pause_end].fill(0.0005);

        let timings = align_words(text, &pcm, sr as u32);
        assert_eq!(timings.len(), n);
        assert_eq!(timings[0].start_sample, 0);
        assert_eq!(timings[n - 1].end_sample, total);

        let weights: Vec<f64> = words
            .iter()
            .enumerate()
            .map(|(i, w)| word_weight(w, i + 1 == n))
            .collect();
        let total_w: f64 = weights.iter().sum();

        for (i, t) in timings.iter().enumerate() {
            assert!(t.end_sample > t.start_sample);
            if i > 0 {
                assert_eq!(t.start_sample, timings[i - 1].end_sample);
            }
            let ideal_span = (weights[i] / total_w) * total as f64;
            let actual_span = (t.end_sample - t.start_sample) as f64;
            assert!(
                actual_span >= ideal_span * 0.45,
                "word '{}' collapsed: actual={} vs ideal={:.1}",
                words[i],
                actual_span,
                ideal_span
            );
        }
    }

    #[test]
    fn final_word_punctuation_does_not_steal_time_from_earlier_words() {
        assert!((word_weight("point.", true) - word_weight("point", true)).abs() < 1e-9);
        assert!((word_weight("\"Master!\"", true) - word_weight("Master", true)).abs() < 1e-9);
        assert!(word_weight("scream,\"", false) > word_weight("scream", false));
    }

    #[test]
    fn ignores_leading_and_trailing_room_tone_hiss() {
        let sr = 24_000_usize;
        let mut pcm = vec![0.015_f32; sr * 4 / 10]; // 400 ms leading room tone
        let speech_start = pcm.len();
        pcm.extend(std::iter::repeat_n(0.3_f32, sr)); // 1000 ms speech
        let speech_end = pcm.len();
        pcm.extend(std::iter::repeat_n(0.015_f32, sr * 4 / 10)); // 400 ms trailing room tone

        let timings = align_words("One two three four", &pcm, sr as u32);
        assert_eq!(timings.len(), 4);
        for t in &timings[..3] {
            assert!(
                t.end_sample > speech_start && t.end_sample < speech_end,
                "boundary {} escaped active speech ({speech_start}..{speech_end})",
                t.end_sample
            );
        }
    }
}
