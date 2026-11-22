//! Plain `.txt` document parser producing HTML + sentence index + chapter TOC.

use crate::documents::sentence_split::split_sentences;
use crate::models::{BookMeta, ChapterHtml, DocumentPayload, SentenceItem, TocEntry};
use std::path::Path;

pub fn parse_txt(path: &Path, mut book: BookMeta) -> Result<DocumentPayload, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("Failed reading TXT: {e}"))?;
    let raw = String::from_utf8_lossy(&bytes).replace("\r\n", "\n").replace('\r', "\n");

    let mut sentences: Vec<SentenceItem> = Vec::new();
    let mut toc: Vec<TocEntry> = Vec::new();
    let mut html = String::with_capacity(raw.len() + 4096);
    let mut paragraph_idx = 0usize;
    let mut current_chapter_idx: Option<usize> = None;

    for block in raw.split("\n\n") {
        let cleaned = block
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        if cleaned.is_empty() {
            continue;
        }

        let is_heading = is_txt_chapter_heading(&cleaned);
        if is_heading {
            let chap_idx = toc.len();
            toc.push(TocEntry {
                title: cleaned.clone(),
                sentence_idx: sentences.len(),
                page: None,
                level: 1,
            });
            current_chapter_idx = Some(chap_idx);
        }

        let parts = split_sentences(&cleaned);
        if parts.is_empty() {
            continue;
        }

        let tag = if is_heading { "h2" } else { "p" };
        html.push('<');
        html.push_str(tag);
        html.push('>');

        let last_i = parts.len() - 1;
        for (idx, sent) in parts.into_iter().enumerate() {
            let sid = sentences.len();
            let is_para_end = idx == last_i;
            sentences.push(SentenceItem {
                id: sid,
                text: sent.clone(),
                page: None,
                paragraph_idx,
                is_paragraph_end: is_para_end,
                is_section_break: is_heading && is_para_end,
                chapter_idx: current_chapter_idx,
            });

            if idx > 0 {
                html.push(' ');
            }
            html.push_str(&format!(
                r#"<span class="br-sent" data-sid="{sid}">{}</span>"#,
                escape_html(&sent)
            ));
        }

        html.push_str("</");
        html.push_str(tag);
        html.push_str(">\n");
        paragraph_idx += 1;
    }

    book.total_sentences = sentences.len();
    book.total_words = sentences
        .iter()
        .map(|s| s.text.split_whitespace().count())
        .sum();

    Ok(DocumentPayload {
        book: book.clone(),
        sentences,
        toc,
        html_chapters: vec![ChapterHtml {
            title: book.title,
            html,
        }],
    })
}

fn is_txt_chapter_heading(line: &str) -> bool {
    if line.len() > 90 {
        return false;
    }
    let lower = line.to_ascii_lowercase();
    lower.starts_with("chapter ")
        || lower.starts_with("prologue")
        || lower.starts_with("epilogue")
        || lower.starts_with("part ")
        || lower.starts_with("book ")
}

pub fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}
