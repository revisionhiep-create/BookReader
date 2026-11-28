//! VAD silence trimming, smooth fades, clause pause insertion, and research-backed boundary pauses.

use crate::models::{PauseSettings, SentenceItem};

/// Trims excessive leading/trailing silence beyond safe acoustic padding and applies
/// 10 ms raised-cosine fades to prevent clicks at boundaries.
pub fn trim_and_fade(pcm: &[f32], sample_rate: u32) -> Vec<f32> {
    if pcm.is_empty() {
        return Vec::new();
    }
    let sr = sample_rate.max(8000) as usize;
    let win = (sr / 100).max(1); // 10 ms window
    let threshold = 0.005_f32; // ~ -46 dBFS

    let mut first_active = None;
    let mut last_active = 0usize;

    let mut pos = 0;
    while pos < pcm.len() {
        let end = (pos + win).min(pcm.len());
        let rms = window_rms(&pcm[pos..end]);
        if rms >= threshold {
            if first_active.is_none() {
                first_active = Some(pos);
            }
            last_active = end;
        }
        pos = end;
    }

    let Some(first) = first_active else {
        // Pure silence or near-zero utterance
        return Vec::new();
    };

    let lead_pad = (sr * 25) / 1000;
    let trail_pad = (sr * 35) / 1000;
    let start = first.saturating_sub(lead_pad);
    let end = (last_active + trail_pad).min(pcm.len());

    let mut out = pcm[start..end].to_vec();
    apply_edge_fades(&mut out, (sr * 10) / 1000);
    out
}

/// Inserts subtle extra silence near `,` and `;`/`:` acoustic micro-pauses when configured.
pub fn apply_clause_pause_boost(
    mut pcm: Vec<f32>,
    spoken_text: &str,
    comma_extra_ms: u32,
    semicolon_extra_ms: u32,
    sample_rate: u32,
) -> Vec<f32> {
    if pcm.is_empty() || (comma_extra_ms == 0 && semicolon_extra_ms == 0) {
        return pcm;
    }

    let total_chars = spoken_text.chars().count().max(1);
    let sr = sample_rate.max(8000) as usize;
    let search_radius = (sr * 220) / 1000;
    let rms_win = (sr * 15) / 1000;
    let fade_len = (sr * 8) / 1000;

    // Collect internal punctuation markers (ignore trailing sentence punctuation)
    let mut targets: Vec<(usize, usize)> = Vec::new();
    for (char_idx, ch) in spoken_text.chars().enumerate() {
        if char_idx < 2 || char_idx + 2 >= total_chars {
            continue;
        }
        let extra_ms = match ch {
            ',' if comma_extra_ms > 0 => comma_extra_ms,
            ';' | ':' if semicolon_extra_ms > 0 => semicolon_extra_ms,
            _ => continue,
        };
        let approx_sample = (char_idx * pcm.len()) / total_chars;
        let split_sample = find_lowest_energy_center(&pcm, approx_sample, search_radius, rms_win);
        let extra_samples = (sr * extra_ms as usize) / 1000;
        if extra_samples > 0 && split_sample > fade_len && split_sample + fade_len < pcm.len() {
            targets.push((split_sample, extra_samples));
        }
    }

    if targets.is_empty() {
        return pcm;
    }

    // Deduplicate nearby targets and splice in reverse order so earlier indices stay valid
    targets.sort_by_key(|t| t.0);
    let min_gap = (sr * 150) / 1000;
    let mut filtered: Vec<(usize, usize)> = Vec::new();
    for (pos, extra) in targets {
        if let Some(prev) = filtered.last()
            && pos.saturating_sub(prev.0) < min_gap
        {
            continue;
        }
        filtered.push((pos, extra));
    }

    for (pos, extra) in filtered.into_iter().rev() {
        let lo = pos.saturating_sub(fade_len);
        for (i, sample) in pcm[lo..pos].iter_mut().enumerate() {
            let t = i as f32 / (pos - lo).max(1) as f32;
            *sample *= 0.5 * (1.0 + (std::f32::consts::PI * t).cos());
        }
        let hi = (pos + fade_len).min(pcm.len());
        for (i, sample) in pcm[pos..hi].iter_mut().enumerate() {
            let t = i as f32 / (hi - pos).max(1) as f32;
            *sample *= 0.5 * (1.0 - (std::f32::consts::PI * t).cos());
        }
        pcm.splice(pos..pos, std::iter::repeat_n(0.0_f32, extra));
    }

    pcm
}

/// Computes trailing silence duration (in milliseconds) after a sentence or break,
/// applying gentle adaptive speed compression at elevated playback speeds.
pub fn compute_trailing_pause_ms(
    sentence: &SentenceItem,
    pauses: &PauseSettings,
    speed: f32,
) -> u32 {
    let base = if sentence.is_section_break {
        pauses.section_ms
    } else if sentence.is_paragraph_end {
        pauses.paragraph_ms
    } else {
        pauses.sentence_ms
    };

    if base == 0 {
        return 0;
    }

    if !pauses.adaptive_speed_scaling || !speed.is_finite() || speed <= 0.01 {
        return base;
    }

    let scaled = (base as f32) / speed.powf(0.75);
    let min_floor = base.min(180) as f32;
    let max_cap = (base as f32) * 1.45;
    scaled.clamp(min_floor, max_cap).round() as u32
}

fn find_lowest_energy_center(
    pcm: &[f32],
    approx: usize,
    radius: usize,
    win: usize,
) -> usize {
    let win = win.max(1);
    let lo = approx.saturating_sub(radius);
    let hi = (approx + radius).min(pcm.len());
    if hi <= lo + win {
        return approx.min(pcm.len());
    }

    let mut best_pos = approx.clamp(lo, hi);
    let mut best_rms = f32::MAX;
    let step = (win / 3).max(1);
    let mut pos = lo;
    while pos + win <= hi {
        let rms = window_rms(&pcm[pos..pos + win]);
        if rms < best_rms {
            best_rms = rms;
            best_pos = pos + win / 2;
        }
        pos += step;
    }
    best_pos
}

fn apply_edge_fades(pcm: &mut [f32], fade_samples: usize) {
    let n = pcm.len();
    let f = fade_samples.min(n / 2);
    if f == 0 {
        return;
    }
    for (i, sample) in pcm[..f].iter_mut().enumerate() {
        let t = i as f32 / f as f32;
        *sample *= 0.5 * (1.0 - (std::f32::consts::PI * t).cos());
    }
    for (i, sample) in pcm[n - f..].iter_mut().enumerate() {
        let t = i as f32 / f as f32;
        *sample *= 0.5 * (1.0 + (std::f32::consts::PI * t).cos());
    }
}

fn window_rms(slice: &[f32]) -> f32 {
    if slice.is_empty() {
        return 0.0;
    }
    let sum_sq: f32 = slice.iter().map(|&s| s * s).sum();
    (sum_sq / slice.len() as f32).sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trims_silence_and_preserves_speech_core() {
        let sr = 24_000_usize;
        let mut buf = vec![0.0_f32; sr / 2];
        buf.extend(std::iter::repeat_n(0.2_f32, sr / 4));
        buf.extend(std::iter::repeat_n(0.0_f32, sr / 2));

        let trimmed = trim_and_fade(&buf, sr as u32);
        assert!(trimmed.len() < buf.len());
        assert!(trimmed.len() >= sr / 4);
    }

    #[test]
    fn computes_adaptive_pauses_cleanly() {
        let p = PauseSettings::default();
        let normal = SentenceItem::default();
        let mut para = SentenceItem::default();
        para.is_paragraph_end = true;
        let mut sec = SentenceItem::default();
        sec.is_section_break = true;

        assert_eq!(compute_trailing_pause_ms(&normal, &p, 1.0), 450);
        assert_eq!(compute_trailing_pause_ms(&para, &p, 1.0), 850);
        assert_eq!(compute_trailing_pause_ms(&sec, &p, 1.0), 1300);

        // At 1.38x, sentence pause scales down smoothly without dropping below floor
        let fast = compute_trailing_pause_ms(&normal, &p, 1.38);
        assert!(fast < 450 && fast >= 250);
    }
}
