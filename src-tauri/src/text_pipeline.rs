//! Pre-TTS text sanitization, Ignore rules, and Pronunciation replacement pipeline.
//!
//! Order of operations per sentence:
//! 1. User Ignore rules (`match_case`, `ignore_word_boundary`, `is_regex`)
//! 2. User Pronunciation replacement rules (`match_case`, `ignore_word_boundary`, `is_regex`)
//! 3. Built-in Sanitizer (decorative dividers, kaomoji/foreign emotes, citations,
//!    bracket handling, emojis & unreadable foreign symbols)
//! 4. Normalization & emptiness check -> `Speak(text)` or `Skip { is_section_break }`

use crate::models::{BracketMode, IgnoreRule, PronunciationRule, SanitizerSettings};
use regex::{NoExpand, Regex, RegexBuilder};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProcessedSentence {
    Speak(String),
    Skip { is_section_break: bool },
}

#[derive(Clone)]
struct CompiledIgnore {
    regex: Regex,
}

#[derive(Clone)]
struct CompiledPronunciation {
    regex: Regex,
    replace: String,
    is_regex: bool,
}

/// Compiled reusable text processor applied to both playback and audio export.
#[derive(Clone)]
pub struct TextPipeline {
    sanitizer: SanitizerSettings,
    ignores: Vec<CompiledIgnore>,
    pronunciations: Vec<CompiledPronunciation>,
    re_divider: Regex,
    re_kaomoji_parens: Regex,
    re_kaomoji_shrug: Regex,
    re_kaomoji_glyphs: Regex,
    re_citations: Regex,
    re_brackets_paired: Regex,
    re_whitespace: Regex,
}

impl TextPipeline {
    /// Compiles all enabled Ignore & Pronunciation rules alongside Sanitizer settings.
    pub fn compile(
        sanitizer: &SanitizerSettings,
        ignore_rules: &[IgnoreRule],
        pronunciation_rules: &[PronunciationRule],
    ) -> Self {
        let mut ignores = Vec::new();
        for rule in ignore_rules.iter().filter(|r| r.enabled && !r.pattern.is_empty()) {
            match compile_user_regex(
                &rule.pattern,
                rule.match_case,
                rule.ignore_word_boundary,
                rule.is_regex,
            ) {
                Ok(regex) => ignores.push(CompiledIgnore { regex }),
                Err(err) => tracing::warn!(pattern = %rule.pattern, error = %err, "Skipping invalid ignore rule"),
            }
        }

        let mut pronunciations = Vec::new();
        for rule in pronunciation_rules
            .iter()
            .filter(|r| r.enabled && !r.source.is_empty())
        {
            match compile_user_regex(
                &rule.source,
                rule.match_case,
                rule.ignore_word_boundary,
                rule.is_regex,
            ) {
                Ok(regex) => pronunciations.push(CompiledPronunciation {
                    regex,
                    replace: rule.replace.clone(),
                    is_regex: rule.is_regex,
                }),
                Err(err) => tracing::warn!(source = %rule.source, error = %err, "Skipping invalid pronunciation rule"),
            }
        }

        Self {
            sanitizer: sanitizer.clone(),
            ignores,
            pronunciations,
            // Ornamental dividers like "***", "=== === ===", "-0-", "~~~", "───"
            re_divider: Regex::new(
                r"^[\s\-=*~_─━═│┃·•◆◇◈★☆✦✧❖✿❀❁❂❄❅❆0oO<>+|\\/\[\]()]{2,}$",
            )
            .unwrap(),
            // Parenthesized or bracketed kaomoji containing non-Latin glyphs or classic emote faces
            re_kaomoji_parens: Regex::new(
                r"[(\[（【][^)\]）】\r\n]{1,42}[ノﾉ╯╰つづ⊂⊃っっಠ益ಥツ≧≦∀▽ﾟ•̀•́｡◕ωд･ᴥ＾￣＼／┻┬︵彡✿☆♡♥♫♪][^) \]）】\r\n]{0,42}[)\]）】]",
            )
            .unwrap(),
            // Classic shrug / text-art faces
            re_kaomoji_shrug: Regex::new(
                r"(?:¯\\_\([^)]*\)_/¯|ಠ_ಠ|ಥ_ಥ|ʕ•ᴥ•ʔ|┬─┬ノ\( º _ ºノ\)|\(╯°□°\)╯︵ ┻━┻)",
            )
            .unwrap(),
            // Standalone emote glyphs (Kannada ಠ, Ethiopic ಥ, box drawing, katakana ツ/ノ emote tails)
            re_kaomoji_glyphs: Regex::new(
                r"[\u{0C80}-\u{0CFF}\u{1200}-\u{137F}\u{2500}-\u{257F}\u{2580}-\u{259F}\u{2600}-\u{27BF}\u{1F000}-\u{1FAFF}]+",
            )
            .unwrap(),
            // Numeric citations like [1], [12-15], (p. 23), (Fig. 4)
            re_citations: Regex::new(
                r"(?:\[\s*\d+(?:\s*[-,–—]\s*\d+)*\s*\]|\(\s*(?:pp?\.|Figs?\.|Tables?|Chapters?|Ch\.|see|cf\.)\s*[^)\r\n]{1,28}\))",
            )
            .unwrap(),
            re_whitespace: Regex::new(r"\s+").unwrap(),
            // Paired brackets for SkipBracketedContent mode
            re_brackets_paired: Regex::new(
                r"(?:\[[^\[\]\r\n]*\]|\([^()\r\n]*\)|\{[^{}\r\n]*\}|<[^<>\r\n]*>|「[^「」\r\n]*」|『[^『』\r\n]*』|【[^【】\r\n]*】|《[^《》\r\n]*》|〈[^〈〉\r\n]*〉|（[^（）\r\n]*）)",
            )
            .unwrap(),
        }
    }

    /// Processes raw sentence text into speakable clean English or a Skip marker.
    pub fn process(&self, raw: &str) -> ProcessedSentence {
        let trimmed_raw = raw.trim();
        if trimmed_raw.is_empty() {
            return ProcessedSentence::Skip {
                is_section_break: false,
            };
        }

        let mut text = trimmed_raw.to_string();

        // 1. User Ignore rules
        for ign in &self.ignores {
            text = ign.regex.replace_all(&text, " ").into_owned();
        }

        // 2. User Pronunciation replacements
        for pron in &self.pronunciations {
            text = if pron.is_regex {
                pron.regex.replace_all(&text, pron.replace.as_str()).into_owned()
            } else {
                pron.regex
                    .replace_all(&text, NoExpand(pron.replace.as_str()))
                    .into_owned()
            };
        }

        // 3. Decorative divider check (after ignore/pronunciation so explicit rules win if wanted)
        let after_rules_trimmed = text.trim();
        if after_rules_trimmed.is_empty() {
            return ProcessedSentence::Skip {
                is_section_break: false,
            };
        }
        if self.sanitizer.strip_decorative_dividers
            && is_decorative_line(after_rules_trimmed, &self.re_divider)
        {
            return ProcessedSentence::Skip {
                is_section_break: true,
            };
        }

        // 4. Kaomoji & foreign-symbol emotes
        if self.sanitizer.strip_kaomoji_emotes {
            text = self.re_kaomoji_shrug.replace_all(&text, " ").into_owned();
            text = self.re_kaomoji_parens.replace_all(&text, " ").into_owned();
            text = self.re_kaomoji_glyphs.replace_all(&text, " ").into_owned();
        }

        // 5. Citation brackets
        if self.sanitizer.skip_citation_brackets {
            text = self.re_citations.replace_all(&text, " ").into_owned();
        }

        // 6. Brackets handling
        match self.sanitizer.bracket_mode {
            BracketMode::Keep => {}
            BracketMode::SkipBracketedContent => {
                // Repeat up to 3 passes to handle shallow nested brackets cleanly
                for _ in 0..3 {
                    let next = self.re_brackets_paired.replace_all(&text, " ").into_owned();
                    if next == text {
                        break;
                    }
                    text = next;
                }
                text = strip_bracket_chars(&text);
            }
            BracketMode::StripBracketsReadInner => {
                text = strip_bracket_chars(&text);
            }
        }

        // 7. Normalize smart typography & filter stray emojis / unreadable foreign scripts
        text = normalize_and_filter_chars(&text, self.sanitizer.strip_emojis_symbols);

        // 8. Collapse whitespace & verify speakable alphanumeric content remains
        text = self.re_whitespace.replace_all(text.trim(), " ").into_owned();
        text = clean_orphan_punctuation(&text);

        if !text.chars().any(|c| c.is_alphanumeric()) {
            return ProcessedSentence::Skip {
                is_section_break: false,
            };
        }

        ProcessedSentence::Speak(text)
    }
}

/// Validates a user regex or literal pattern so the UI can flag syntax errors live.
pub fn validate_rule_pattern(
    pattern: &str,
    match_case: bool,
    ignore_word_boundary: bool,
    is_regex: bool,
) -> Result<(), String> {
    if pattern.is_empty() {
        return Err("Pattern cannot be empty".to_string());
    }
    compile_user_regex(pattern, match_case, ignore_word_boundary, is_regex).map(|_| ())
}

fn compile_user_regex(
    raw: &str,
    match_case: bool,
    ignore_word_boundary: bool,
    is_regex: bool,
) -> Result<Regex, String> {
    let base = if is_regex {
        raw.to_string()
    } else {
        regex::escape(raw)
    };

    let final_pat = if ignore_word_boundary || is_regex {
        base
    } else {
        let starts_word = raw.chars().next().is_some_and(is_word_char);
        let ends_word = raw.chars().last().is_some_and(is_word_char);
        format!(
            "{}{}{}",
            if starts_word { r"\b" } else { "" },
            base,
            if ends_word { r"\b" } else { "" }
        )
    };

    RegexBuilder::new(&final_pat)
        .case_insensitive(!match_case)
        .build()
        .map_err(|e| format!("Invalid regex: {e}"))
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

fn is_decorative_line(s: &str, re_divider: &Regex) -> bool {
    // Pure digits like "85" or valid words should not be treated as dividers unless "-0-" or punctuation-heavy
    if s.chars().all(|c| c.is_ascii_digit()) {
        return false;
    }
    if s.eq_ignore_ascii_case("o") || s.eq_ignore_ascii_case("0") {
        return false;
    }
    if re_divider.is_match(s) && s.chars().any(|c| !c.is_alphanumeric() && !c.is_whitespace()) {
        return true;
    }
    false
}

fn strip_bracket_chars(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '[' | ']' | '(' | ')' | '{' | '}' | '<' | '>' | '「' | '」' | '『' | '』'
            | '【' | '】' | '《' | '》' | '〈' | '〉' | '（' | '）' => {
                if !out.ends_with(' ') {
                    out.push(' ');
                }
            }
            _ => out.push(c),
        }
    }
    out
}

fn normalize_and_filter_chars(s: &str, strip_non_english_symbols: bool) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '“' | '”' | '„' | '‟' => out.push('"'),
            '‘' | '’' | '‚' | '‛' => out.push('\''),
            '—' | '–' | '―' => out.push_str(", "),
            '…' => out.push_str("..."),
            '\u{00A0}' | '\u{200B}' | '\u{200C}' | '\u{200D}' | '\u{FEFF}' => {
                if !out.ends_with(' ') {
                    out.push(' ');
                }
            }
            _ if !strip_non_english_symbols => out.push(c),
            // Keep standard ASCII printable & accented Latin characters + common currency
            _ if c.is_ascii()
                || ('\u{00C0}'..='\u{024F}').contains(&c)
                || matches!(c, '£' | '€' | '¥' | '¢' | '°' | '§' | '©' | '®' | '™') =>
            {
                out.push(c);
            }
            _ => {
                if !out.ends_with(' ') {
                    out.push(' ');
                }
            }
        }
    }
    out
}

fn clean_orphan_punctuation(s: &str) -> String {
    // Collapse accidental space before punctuation introduced by stripped tokens/brackets,
    // then normalize expressive punctuation runs (`!!!!`, `?!`, `...!`, stray `~`) for TTS.
    let strip_punct_spaces = |input: &str| {
        input
            .replace(" ,", ",")
            .replace(" .", ".")
            .replace(" !", "!")
            .replace(" ?", "?")
            .replace(" ;", ";")
            .replace(" :", ":")
    };
    let mut out = strip_punct_spaces(s);
    out = collapse_expressive_punctuation(&out);
    out = strip_punct_spaces(&out);
    while out.contains("  ") {
        out = out.replace("  ", " ");
    }
    out.trim().to_string()
}

fn collapse_expressive_punctuation(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '.' | '!' | '?' => {
                let mut len = 1usize;
                let mut has_q = c == '?';
                let mut has_excl = c == '!';
                while let Some(&next) = chars.peek() {
                    if matches!(next, '.' | '!' | '?') {
                        len += 1;
                        has_q |= next == '?';
                        has_excl |= next == '!';
                        chars.next();
                    } else {
                        break;
                    }
                }
                if len == 1 {
                    out.push(c);
                } else if has_q {
                    out.push('?');
                } else if has_excl {
                    out.push('!');
                } else {
                    out.push_str("...");
                }
            }
            '~' => {
                if chars.peek().is_some_and(|n| n.is_ascii_digit()) {
                    out.push('~');
                } else {
                    while chars.peek() == Some(&'~') {
                        chars.next();
                    }
                    if chars.peek().is_some_and(|n| n.is_ascii_digit()) {
                        out.push('~');
                    } else if out.chars().last().is_some_and(char::is_alphanumeric)
                        && chars.peek().is_some_and(|n| n.is_alphanumeric())
                    {
                        out.push(' ');
                    }
                }
            }
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_kaomoji_dividers_and_keeps_inner_brackets_by_default() {
        let pipe = TextPipeline::compile(&SanitizerSettings::default(), &[], &[]);

        assert_eq!(
            pipe.process("***"),
            ProcessedSentence::Skip {
                is_section_break: true
            }
        );
        assert_eq!(
            pipe.process("-0-"),
            ProcessedSentence::Skip {
                is_section_break: true
            }
        );
        assert_eq!(
            pipe.process("Look at him go (ノಠ益ಠ)ノ right now!"),
            ProcessedSentence::Speak("Look at him go right now!".to_string())
        );
        assert_eq!(
            pipe.process("[System] Level up [1] confirmed."),
            ProcessedSentence::Speak("System Level up confirmed.".to_string())
        );
    }

    #[test]
    fn bracket_skip_mode_drops_bracket_blocks() {
        let mut san = SanitizerSettings::default();
        san.bracket_mode = BracketMode::SkipBracketedContent;
        let pipe = TextPipeline::compile(&san, &[], &[]);
        assert_eq!(
            pipe.process("He nodded (silently) and left."),
            ProcessedSentence::Speak("He nodded and left.".to_string())
        );
    }

    #[test]
    fn ignore_and_pronunciation_respect_case_and_word_boundary() {
        let ignores = vec![IgnoreRule {
            id: "i1".into(),
            pattern: "TL".into(),
            match_case: true,
            ignore_word_boundary: false,
            is_regex: false,
            enabled: true,
        }];
        let prons = vec![
            PronunciationRule {
                id: "p1".into(),
                source: "F*ck".into(),
                replace: "Fuck".into(),
                match_case: false,
                ignore_word_boundary: false,
                is_regex: false,
                enabled: true,
            },
            PronunciationRule {
                id: "p2".into(),
                source: "Dr.".into(),
                replace: "Doctor".into(),
                match_case: true,
                ignore_word_boundary: false,
                is_regex: false,
                enabled: true,
            },
            PronunciationRule {
                id: "p3".into(),
                source: r"HP\s*([0-9]+)".into(),
                replace: "health $1".into(),
                match_case: false,
                ignore_word_boundary: true,
                is_regex: true,
                enabled: true,
            },
        ];
        let pipe = TextPipeline::compile(&SanitizerSettings::default(), &ignores, &prons);

        // "TL" removed as whole uppercase word, "title" untouched, F*ck -> Fuck, Dr. -> Doctor, regex capture works
        let out = pipe.process("TL Dr. Smith had 100 title and HP 50, F*ck!");
        assert_eq!(
            out,
            ProcessedSentence::Speak("Doctor Smith had 100 title and health 50, Fuck!".to_string())
        );
    }

    #[test]
    fn collapses_repeated_punctuation_and_stray_tildes_for_tts() {
        let pipe = TextPipeline::compile(&SanitizerSettings::default(), &[], &[]);
        assert_eq!(
            pipe.process(r#""Give me my five points back, you bastard!!!!!""#),
            ProcessedSentence::Speak(r#""Give me my five points back, you bastard!""#.to_string())
        );
        assert_eq!(
            pipe.process("Run!!!! What???? Did I win?! The results were...! Wait......"),
            ProcessedSentence::Speak("Run! What? Did I win? The results were! Wait...".to_string())
        );
        assert_eq!(
            pipe.process("Bbaam~ No~~~! Wait ~10 minutes."),
            ProcessedSentence::Speak("Bbaam No! Wait ~10 minutes.".to_string())
        );
        assert_eq!(
            pipe.process("Wait ! ! !"),
            ProcessedSentence::Speak("Wait!".to_string())
        );
        assert_eq!(
            pipe.process("Dr. Vance checked 3.14."),
            ProcessedSentence::Speak("Dr. Vance checked 3.14.".to_string())
        );
    }
}
