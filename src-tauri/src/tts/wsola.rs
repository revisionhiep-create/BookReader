//! Pure-Rust pitch-preserving WSOLA time-stretcher for 24 kHz mono speech.

/// Waveform Similarity Overlap-Add (WSOLA) time-stretcher.
///
/// Works frame-by-frame or over complete sentence buffers while reporting the
/// exact source-sample position corresponding to output playback for CC word sync.
pub struct WsolaStretcher {
    win_len: usize,
    syn_hop: usize,
    tolerance: usize,
    hann: Vec<f32>,
}

impl WsolaStretcher {
    /// Creates a stretcher tuned for 24 kHz speech (30 ms window, 15 ms hop, ±10 ms search).
    pub fn new(sample_rate: u32) -> Self {
        let sr = sample_rate.max(8000) as usize;
        let win_len = ((sr * 30) / 1000).max(64);
        let win_len = if win_len % 2 == 1 { win_len + 1 } else { win_len };
        let syn_hop = win_len / 2;
        let tolerance = (sr * 10) / 1000;

        let hann: Vec<f32> = (0..win_len)
            .map(|i| {
                let phase = (2.0 * std::f32::consts::PI * i as f32) / (win_len as f32);
                0.5 * (1.0 - phase.cos())
            })
            .collect();

        Self {
            win_len,
            syn_hop,
            tolerance,
            hann,
        }
    }

    /// Time-stretches `input` by `speed` (`0.5..=3.0`) preserving vocal pitch,
    /// returning `(stretched_pcm, source_sample_map)` where `source_sample_map[i]`
    /// is the 24 kHz source sample index corresponding to `stretched_pcm[i]`.
    pub fn stretch(&self, input: &[f32], speed: f32) -> (Vec<f32>, Vec<usize>) {
        let speed = speed.clamp(0.5, 3.0);
        if input.is_empty() {
            return (Vec::new(), Vec::new());
        }
        if (speed - 1.0).abs() < 0.015 || input.len() < self.win_len * 2 {
            let map = (0..input.len()).collect();
            return (input.to_vec(), map);
        }

        let est_out_len = ((input.len() as f32 / speed).ceil() as usize) + self.win_len;
        let mut out = vec![0.0_f32; est_out_len];
        let mut norm = vec![0.0_f32; est_out_len];
        let mut src_pos_acc = vec![0.0_f64; est_out_len];
        let mut src_weight_acc = vec![0.0_f64; est_out_len];

        let mut out_pos = 0usize;
        let mut prev_ana_pos = 0usize;
        let mut first_frame = true;

        loop {
            let ana_pos = if first_frame {
                first_frame = false;
                0usize
            } else {
                let ideal = (prev_ana_pos as f32 + (self.syn_hop as f32 * speed)).round() as isize;
                if ideal as usize + self.win_len >= input.len() {
                    break;
                }
                let ref_start = (prev_ana_pos + self.syn_hop).min(input.len().saturating_sub(self.syn_hop));
                let search_lo = (ideal - self.tolerance as isize).max(0) as usize;
                let search_hi = ((ideal + self.tolerance as isize) as usize)
                    .min(input.len().saturating_sub(self.win_len));
                if search_lo <= search_hi {
                    self.best_match(input, ref_start, ideal.max(0) as usize, search_lo, search_hi)
                } else {
                    (ideal.max(0) as usize).min(input.len().saturating_sub(self.win_len))
                }
            };

            if out_pos + self.win_len > out.len() {
                let extra = self.win_len * 2;
                out.resize(out.len() + extra, 0.0);
                norm.resize(norm.len() + extra, 0.0);
                src_pos_acc.resize(src_pos_acc.len() + extra, 0.0);
                src_weight_acc.resize(src_weight_acc.len() + extra, 0.0);
            }

            for i in 0..self.win_len {
                let w = self.hann[i];
                let s = input[ana_pos + i];
                out[out_pos + i] += s * w;
                norm[out_pos + i] += w;
                src_pos_acc[out_pos + i] += (ana_pos + i) as f64 * w as f64;
                src_weight_acc[out_pos + i] += w as f64;
            }

            prev_ana_pos = ana_pos;
            out_pos += self.syn_hop;

            if ana_pos + self.win_len >= input.len() {
                break;
            }
        }

        let final_len = (out_pos + self.syn_hop).min(out.len());
        out.truncate(final_len);
        let mut src_map = Vec::with_capacity(final_len);
        for i in 0..final_len {
            if norm[i] > 1e-4 {
                out[i] = (out[i] / norm[i]).clamp(-1.0, 1.0);
                let mapped = (src_pos_acc[i] / src_weight_acc[i]).round() as usize;
                src_map.push(mapped.min(input.len() - 1));
            } else {
                out[i] = 0.0;
                let fallback = src_map.last().copied().unwrap_or(0);
                src_map.push(fallback);
            }
        }

        (out, src_map)
    }

    fn best_match(
        &self,
        input: &[f32],
        ref_start: usize,
        ideal: usize,
        lo: usize,
        hi: usize,
    ) -> usize {
        let len = self.syn_hop.min(input.len().saturating_sub(ref_start));
        if len == 0 {
            return lo;
        }
        let target = &input[ref_start..ref_start + len];
        let mut best_pos = ideal.clamp(lo, hi);
        let mut best_score = f32::NEG_INFINITY;
        let tol = self.tolerance.max(1) as f32;

        for cand in lo..=hi {
            let slice = &input[cand..cand + len];
            let mut dot = 0.0_f32;
            let mut energy = 1e-6_f32;
            for j in 0..len {
                dot += target[j] * slice[j];
                energy += slice[j] * slice[j];
            }
            let corr = dot / energy.sqrt();
            // Gentle tiebreaker toward `ideal` prevents locking onto `ref_start` across pitch periods
            let dist_penalty = 0.04 * (cand.abs_diff(ideal) as f32 / tol);
            let score = corr - dist_penalty;
            if score > best_score {
                best_score = score;
                best_pos = cand;
            }
        }
        best_pos
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stretches_audio_accurately_without_nan_or_clipping() {
        let sr = 24_000;
        // 1 second 220 Hz sine wave
        let input: Vec<f32> = (0..sr)
            .map(|i| 0.5 * (2.0 * std::f32::consts::PI * 220.0 * i as f32 / sr as f32).sin())
            .collect();
        let stretcher = WsolaStretcher::new(sr);

        for speed in [0.75_f32, 1.0, 1.38, 2.0] {
            let (out, map) = stretcher.stretch(&input, speed);
            assert_eq!(out.len(), map.len());
            assert!(out.iter().all(|s| s.is_finite() && s.abs() <= 1.0));
            let ratio = input.len() as f32 / out.len() as f32;
            assert!(
                (ratio - speed).abs() < 0.12,
                "speed {speed} yielded ratio {ratio}"
            );
        }
    }
}
