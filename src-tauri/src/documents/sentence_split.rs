//! English sentence segmentation preserving abbreviations, numbers, and dialogue quotes.

/// Splits a paragraph of text into clean individual sentences while keeping
/// trailing closing quotes/brackets attached to the sentence.
pub fn split_sentences(paragraph: &str) -> Vec<String> {
    let trimmed = paragraph.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }

    let chars: Vec<(usize, char)> = trimmed.char_indices().collect();
    let len = chars.len();
    let mut sentences = Vec::new();
    let mut start_byte = 0usize;
    let mut i = 0usize;

    while i < len {
        let (byte_idx, ch) = chars[i];
        if matches!(ch, '.' | '!' | '?') {
            // Skip repeated punctuation runs like "..." or "?!"
            let mut end_punct = i;
            while end_punct + 1 < len && matches!(chars[end_punct + 1].1, '.' | '!' | '?') {
                end_punct += 1;
            }

            // Include trailing closing quotes/brackets attached to the sentence
            let mut end_close = end_punct;
            while end_close + 1 < len
                && matches!(
                    chars[end_close + 1].1,
                    '"' | '\'' | '”' | '’' | ')' | ']' | '}' | '»'
                )
            {
                end_close += 1;
            }

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
                chars[end_close + 1].1.is_whitespace()
            };

            if !is_decimal && !is_abbrev && next_is_ws_or_eof {
                let end_byte = if end_close + 1 < len {
                    chars[end_close + 1].0
                } else {
                    trimmed.len()
                };
                let piece = trimmed[start_byte..end_byte].trim();
                if !piece.is_empty() {
                    sentences.push(piece.to_string());
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
            sentences.push(tail.to_string());
        }
    }

    sentences
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
}
