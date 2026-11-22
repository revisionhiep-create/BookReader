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
    if words.len() == 1 {
        return vec![WordTiming {
            word_index: 0,
            start_sample: 0,
            end_sample: total_samples,
        }];
    }

    let weights: Vec<f64> = words.iter().map(|w| word_weight(w)).collect();
    let total_weight: f64 = weights.iter().sum::<f64>().max(1.0);

    // 10 ms RMS envelope for snapping word boundaries to acoustic dips
    let win = (sample_rate as usize / 100).max(1);
    let mut rms_frames = Vec::with_capacity(total_samples / win + 1);
    let mut pos = 0;
    while pos < total_samples {
        let end = (pos + win).min(total_samples);
        let sum_sq: f32 = speech_pcm[pos..end].iter().map(|&s| s * s).sum();
        rms_frames.push((sum_sq / (end - pos) as f32).sqrt());
        pos = end;
    }

    let search_frames = 12usize; // ±120 ms snapping window
    let mut boundaries = Vec::with_capacity(words.len() + 1);
    boundaries.push(0usize);

    let mut acc_w = 0.0_f64;
    for (idx, w) in weights.iter().enumerate().take(words.len() - 1) {
        acc_w += *w;
        let ideal = ((acc_w / total_weight) * total_samples as f64).round() as usize;
        let ideal_frame = ideal / win;

        let prev_boundary = *boundaries.last().unwrap_or(&0);
        let remaining_words = words.len() - 1 - idx;
        let min_sample = prev_boundary + (total_samples / (words.len() * 4)).max(1);
        let max_sample = total_samples.saturating_sub(remaining_words * 64);

        let snapped = if !rms_frames.is_empty() && max_sample > min_sample {
            let lo = ideal_frame.saturating_sub(search_frames);
            let hi = (ideal_frame + search_frames).min(rms_frames.len() - 1);
            let mut best_f = ideal_frame.clamp(lo, hi);
            let mut best_e = f32::MAX;
            for (offset, &energy) in rms_frames[lo..=hi].iter().enumerate() {
                if energy < best_e {
                    best_e = energy;
                    best_f = lo + offset;
                }
            }
            (best_f * win + win / 2).clamp(min_sample, max_sample)
        } else {
            ideal.clamp(min_sample.min(total_samples), total_samples)
        };
        boundaries.push(snapped);
    }
    boundaries.push(total_samples);

    (0..words.len())
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

fn word_weight(word: &str) -> f64 {
    let letters: String = word.chars().filter(|c| c.is_alphanumeric()).collect();
    let syllables = estimate_syllables(&letters) as f64;
    let char_bonus = (letters.chars().count() as f64) * 0.14;
    let punct_bonus = match word.chars().last() {
        Some(',') => 1.1,
        Some(';') | Some(':') => 1.7,
        Some('.') | Some('!') | Some('?') => 0.8,
        Some('—') | Some('-') => 0.7,
        _ => 0.0,
    };
    (syllables + char_bonus + punct_bonus).max(0.6)
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
}
