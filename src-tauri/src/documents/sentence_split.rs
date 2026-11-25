//! English and CJK sentence segmentation preserving abbreviations, numbers, and dialogue quotes,
//! with clause-aware fallback chunking for oversized run-on sentences.

/// Maximum character length of a single emitted sentence chunk so downstream TTS engines
/// (especially Qwen3-TTS with its token cap) never truncate or stall on huge run-on prose.
pub const MAX_SENTENCE_CHARS: usize = 320;

const CLOSING_DELIMS: &[char] = &[
    '"', '\'', '”', '’', ')', ']', '}', '»', '」', '』', '】', '》', '）',
];

/// Splits a paragraph of text into clean individual sentences while keeping
/// trailing closing quotes/brackets attached to the sentence, and splitting
/// any oversized sentence (`> MAX_SENTENCE_CHARS`) on clause or word boundaries.
pub fn split_sentences(paragraph: &str) -> Vec<String> {
    split_sentences_with_max_chars(paragraph, MAX_SENTENCE_CHARS)
}

/// Splits a paragraph into sentences and subdivides any sentence longer than `max_chars`
/// characters using clause punctuation before falling back to word or character boundaries.
pub fn split_sentences_with_max_chars(paragraph: &str, max_chars: usize) -> Vec<String> {
    let trimmed = paragraph.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }

    let chars: Vec<(usize, char)> = trimmed.char_indices().collect();
    let len = chars.len();
    let mut raw_sentences = Vec::new();
    let mut start_byte = 0usize;
    let mut i = 0usize;

    while i < len {
        let (byte_idx, ch) = chars[i];
        if is_sentence_terminator(ch) {
            // Skip repeated punctuation runs like "..." or "?!"
            let mut end_punct = i;
            while end_punct + 1 < len && is_sentence_terminator(chars[end_punct + 1].1) {
                end_punct += 1;
            }

            // Include trailing closing quotes/brackets attached to the sentence
            let mut end_close = end_punct;
            while end_close + 1 < len && CLOSING_DELIMS.contains(&chars[end_close + 1].1) {
                end_close += 1;
            }

            let is_cjk_end = is_cjk_terminator(chars[end_punct].1);
            let is_single_dot = ch == '.' && end_punct == i;
            let is_decimal = is_single_dot
                && i > 0
                && i + 1 < len
                && chars[i - 1].1.is_ascii_digit()
                && chars[i + 1].1.is_ascii_digit();

            let is_abbrev = is_single_dot && is_known_abbreviation(&trimmed[start_byte..byte_idx]);

            let next_is_ws_or_eof = if end_close + 1 >= len {
                true
            } else {
                is_cjk_end || chars[end_close + 1].1.is_whitespace()
            };

            if !is_decimal && !is_abbrev && next_is_ws_or_eof {
                let end_byte = if end_close + 1 < len {
                    chars[end_close + 1].0
                } else {
                    trimmed.len()
                };
                let piece = trimmed[start_byte..end_byte].trim();
                if !piece.is_empty() {
                    raw_sentences.push(piece.to_string());
                }
                i = end_close + 1;
                while i < len && chars[i].1.is_whitespace() {
                    i += 1;
                }
                start_byte = if i < len { chars[i].0 } else { trimmed.len() };
                continue;
            }

            i = end_punct + 1;
            continue;
        }
        i += 1;
    }

    if start_byte < trimmed.len() {
        let tail = trimmed[start_byte..].trim();
        if !tail.is_empty() {
            raw_sentences.push(tail.to_string());
        }
    }

    let mut out = Vec::with_capacity(raw_sentences.len());
    for sent in raw_sentences {
        out.extend(split_oversized_sentence(&sent, max_chars));
    }
    out
}

/// Subdivides a single sentence if it exceeds `max_chars` characters, preferring balanced
/// splits near the midpoint in strict priority: strong clause punctuation (`;`, `:`, `—`, `–`,
/// `…`), then commas, then whitespace, then a midpoint UTF-8 character boundary.
pub fn split_oversized_sentence(sentence: &str, max_chars: usize) -> Vec<String> {
    let trimmed = sentence.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }

    let limit = max_chars.max(1);
    if trimmed.len() <= limit || trimmed.chars().count() <= limit {
        return vec![trimmed.to_string()];
    }

    let mut stack = vec![trimmed.to_string()];
    let mut out = Vec::new();

    while let Some(piece) = stack.pop() {
        let piece_trimmed = piece.trim();
        if piece_trimmed.is_empty() {
            continue;
        }
        let chars: Vec<(usize, char)> = piece_trimmed.char_indices().collect();
        let n = chars.len();
        if n <= limit {
            out.push(piece_trimmed.to_string());
            continue;
        }

        let mid = n / 2;
        let min_side = (n / 4).max(1).min(mid);
        let max_split = n - min_side;
        let split_char_idx =
            find_best_clause_split(&chars, min_side, max_split, mid).unwrap_or(mid);

        let split_byte = chars[split_char_idx].0;
        let left = piece_trimmed[..split_byte].trim();
        let right = piece_trimmed[split_byte..].trim();

        let (final_left, final_right) = if !left.is_empty()
            && !right.is_empty()
            && left.chars().count() < n
            && right.chars().count() < n
        {
            (left, right)
        } else {
            let mid_byte = chars[mid].0;
            let ml = piece_trimmed[..mid_byte].trim();
            let mr = piece_trimmed[mid_byte..].trim();
            if !ml.is_empty() && !mr.is_empty() && ml.chars().count() < n && mr.chars().count() < n
            {
                (ml, mr)
            } else {
                (&piece_trimmed[..mid_byte], &piece_trimmed[mid_byte..])
            }
        };

        stack.push(final_right.to_string());
        stack.push(final_left.to_string());
    }

    out
}

fn is_sentence_terminator(ch: char) -> bool {
    matches!(ch, '.' | '!' | '?' | '。' | '！' | '？')
}

fn is_cjk_terminator(ch: char) -> bool {
    matches!(ch, '。' | '！' | '？')
}

fn find_best_clause_split(
    chars: &[(usize, char)],
    min_side: usize,
    max_split: usize,
    mid: usize,
) -> Option<usize> {
    let n = chars.len();
    let mut best_strong: Option<(usize, usize)> = None;
    let mut best_comma: Option<(usize, usize)> = None;
    let mut best_ws: Option<(usize, usize)> = None;

    let update_best = |slot: &mut Option<(usize, usize)>, cand: usize| {
        if cand >= min_side && cand <= max_split && cand > 0 && cand < n {
            let dist = cand.abs_diff(mid);
            if slot.is_none_or(|(best_dist, _)| dist < best_dist) {
                *slot = Some((dist, cand));
            }
        }
    };

    for i in 0..n {
        let ch = chars[i].1;

        if matches!(ch, ';' | ':') {
            let end_close = skip_closing_delims(chars, i);
            if end_close + 1 < n && chars[end_close + 1].1.is_whitespace() {
                update_best(&mut best_strong, end_close + 1);
            }
        } else if matches!(ch, '—' | '–' | '…') {
            let mut end_mark = i;
            while end_mark + 1 < n && matches!(chars[end_mark + 1].1, '—' | '–' | '…') {
                end_mark += 1;
            }
            let end_close = skip_closing_delims(chars, end_mark);
            update_best(&mut best_strong, end_close + 1);
        } else if matches!(ch, '；' | '：') {
            let end_close = skip_closing_delims(chars, i);
            update_best(&mut best_strong, end_close + 1);
        } else if ch == ',' {
            let end_close = skip_closing_delims(chars, i);
            if end_close + 1 < n && chars[end_close + 1].1.is_whitespace() {
                update_best(&mut best_comma, end_close + 1);
            }
        } else if matches!(ch, '，' | '、') {
            let end_close = skip_closing_delims(chars, i);
            update_best(&mut best_comma, end_close + 1);
        } else if ch.is_whitespace() {
            update_best(&mut best_ws, i);
        }
    }

    best_strong
        .or(best_comma)
        .or(best_ws)
        .map(|(_, cand)| cand)
}

fn skip_closing_delims(chars: &[(usize, char)], start: usize) -> usize {
    let mut end = start;
    while end + 1 < chars.len() && CLOSING_DELIMS.contains(&chars[end + 1].1) {
        end += 1;
    }
    end
}

fn is_known_abbreviation(prefix_before_dot: &str) -> bool {
    let token = prefix_before_dot
        .rsplit(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | '(' | '[' | '“' | '‘'))
        .next()
        .unwrap_or("");
    if token.is_empty() {
        return false;
    }
    let lower = token.to_ascii_lowercase();
    // Single uppercase initial like "J." or "A." or dotted acronym like "U.S"
    if (token.len() == 1 && token.chars().all(|c| c.is_ascii_uppercase()))
        || (lower.contains('.') && lower.len() <= 7)
    {
        return true;
    }
    matches!(
        lower.as_str(),
        "mr" | "mrs"
            | "ms"
            | "dr"
            | "prof"
            | "sr"
            | "jr"
            | "st"
            | "rev"
            | "gen"
            | "col"
            | "lt"
            | "sgt"
            | "capt"
            | "vs"
            | "etc"
            | "e.g"
            | "i.e"
            | "a.m"
            | "p.m"
            | "fig"
            | "no"
            | "vol"
            | "ch"
            | "pp"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_cleanly_across_abbreviations_quotes_and_decimals() {
        let s = split_sentences(
            r#"Dr. Vance checked the 3.14 ratio. "Are you sure?!" she asked. Then U.S. forces arrived."#,
        );
        assert_eq!(
            s,
            vec![
                r#"Dr. Vance checked the 3.14 ratio."#,
                r#""Are you sure?!""#,
                r#"she asked."#,
                r#"Then U.S. forces arrived."#
            ]
        );
    }

    #[test]
    fn splits_oversized_sentence_at_strong_clause_boundaries() {
        let long = format!(
            "{}; {} — {}",
            "alpha ".repeat(35).trim(),
            "beta ".repeat(35).trim(),
            "gamma ".repeat(35).trim()
        );
        assert!(long.chars().count() > MAX_SENTENCE_CHARS * 1);

        let parts = split_sentences(&long);
        assert!(parts.len() >= 3, "got parts={parts:?}");
        assert!(parts.iter().all(|p| p.chars().count() <= MAX_SENTENCE_CHARS));
        assert!(parts[0].ends_with(';'));
        assert!(parts[1].ends_with('—'));
        assert_eq!(parts.join(" "), long);
    }

    #[test]
    fn splits_oversized_sentence_at_commas_without_breaking_numbers() {
        let long = format!(
            "{}, {}, {}, {}, {}",
            "The treasury held 1,000,000 gold coins from the northern vaults before winter fell",
            "while the eastern guilds shipped 2,500,000 silver ingots across the frozen bay",
            "and the southern merchants guarded 3,750,000 copper pieces inside deep granite cellars",
            "while the western caravans delivered 4,125,000 bronze medallions through the pass",
            "until the royal auditors counted every single ledger entry before sunrise."
        );
        assert!(long.chars().count() > MAX_SENTENCE_CHARS);
        let parts = split_sentences(&long);
        assert!(parts.len() >= 2, "got parts={parts:?}");
        assert!(parts.iter().all(|p| p.chars().count() <= MAX_SENTENCE_CHARS));
        let joined = parts.join(" ");
        assert!(joined.contains("1,000,000"));
        assert!(joined.contains("2,500,000"));
        assert!(joined.contains("3,750,000"));
        assert!(joined.contains("4,125,000"));
    }

    #[test]
    fn splits_unpunctuated_wall_of_words_on_whitespace() {
        let long = std::iter::repeat_n("word", 110).collect::<Vec<_>>().join(" ");
        let parts = split_sentences(&long);
        assert!(parts.len() >= 2);
        assert!(parts.iter().all(|p| p.chars().count() <= MAX_SENTENCE_CHARS));
        assert_eq!(parts.join(" "), long);
    }

    #[test]
    fn splits_unbroken_multibyte_string_safely() {
        let long = "😀é中".repeat(160); // 480 chars, multi-byte UTF-8
        let parts = split_sentences(&long);
        assert!(parts.len() >= 2);
        assert!(parts.iter().all(|p| p.chars().count() <= MAX_SENTENCE_CHARS));
        assert_eq!(parts.concat(), long);
    }

    #[test]
    fn splits_cjk_sentence_terminators() {
        let parts = split_sentences("第一句话。第二句话！第三句话？");
        assert_eq!(parts, vec!["第一句话。", "第二句话！", "第三句话？"]);
    }
}
