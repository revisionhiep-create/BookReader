//! `.docx` Word document parser preserving inline images, headings TOC, and tables.

use crate::documents::media_url;
use crate::documents::sentence_split::split_sentences;
use crate::documents::txt::escape_html;
use crate::models::{BookMeta, ChapterHtml, DocumentPayload, SentenceItem, TocEntry};
use roxmltree::{Document, Node};
use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::Path;
use zip::ZipArchive;

pub fn parse_docx(path: &Path, mut book: BookMeta) -> Result<DocumentPayload, String> {
    let file = File::open(path).map_err(|e| format!("Failed opening DOCX: {e}"))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("Invalid DOCX zip archive: {e}"))?;

    let rels = read_rels(&mut archive);
    let doc_xml = read_zip_string(&mut archive, "word/document.xml")?;
    let doc = Document::parse(&doc_xml).map_err(|e| format!("Failed parsing DOCX XML: {e}"))?;

    let mut sentences: Vec<SentenceItem> = Vec::new();
    let mut toc: Vec<TocEntry> = Vec::new();
    let mut html = String::with_capacity(doc_xml.len().min(512 * 1024));
    let mut paragraph_idx = 0usize;
    let mut current_chapter_idx: Option<usize> = None;

    if let Some(body) = doc.descendants().find(|n| n.tag_name().name() == "body") {
        walk_docx_blocks(
            body,
            &book.id,
            &rels,
            &mut sentences,
            &mut toc,
            &mut html,
            &mut paragraph_idx,
            &mut current_chapter_idx,
        );
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

#[allow(clippy::too_many_arguments)]
fn walk_docx_blocks(
    container: Node,
    book_id: &str,
    rels: &HashMap<String, String>,
    sentences: &mut Vec<SentenceItem>,
    toc: &mut Vec<TocEntry>,
    html: &mut String,
    paragraph_idx: &mut usize,
    current_chapter_idx: &mut Option<usize>,
) {
    for child in container.children().filter(|n| n.is_element()) {
        match child.tag_name().name() {
            "p" => {
                render_paragraph(
                    child,
                    book_id,
                    rels,
                    sentences,
                    toc,
                    html,
                    paragraph_idx,
                    current_chapter_idx,
                );
            }
            "tbl" => {
                html.push_str("<div class=\"br-table-wrap\"><table>");
                for row in child.children().filter(|n| n.tag_name().name() == "tr") {
                    html.push_str("<tr>");
                    for cell in row.children().filter(|n| n.tag_name().name() == "tc") {
                        html.push_str("<td>");
                        walk_docx_blocks(
                            cell,
                            book_id,
                            rels,
                            sentences,
                            toc,
                            html,
                            paragraph_idx,
                            current_chapter_idx,
                        );
                        html.push_str("</td>");
                    }
                    html.push_str("</tr>");
                }
                html.push_str("</table></div>\n");
            }
            "sdt" => {
                for sdt_content in child.children().filter(|n| n.tag_name().name() == "sdtContent") {
                    walk_docx_blocks(
                        sdt_content,
                        book_id,
                        rels,
                        sentences,
                        toc,
                        html,
                        paragraph_idx,
                        current_chapter_idx,
                    );
                }
            }
            _ => {}
        }
    }
}

fn collect_docx_paragraph_nodes(
    node: Node,
    book_id: &str,
    rels: &HashMap<String, String>,
    text_buf: &mut String,
    image_urls: &mut Vec<String>,
) {
    if !node.is_element() {
        return;
    }
    match node.tag_name().name() {
        "AlternateContent" => {
            if let Some(choice) = node.children().find(|n| n.tag_name().name() == "Choice") {
                collect_docx_paragraph_nodes(choice, book_id, rels, text_buf, image_urls);
            } else if let Some(fallback) =
                node.children().find(|n| n.tag_name().name() == "Fallback")
            {
                collect_docx_paragraph_nodes(fallback, book_id, rels, text_buf, image_urls);
            }
            return;
        }
        "t" => {
            if let Some(t) = node.text() {
                text_buf.push_str(t);
            }
        }
        "tab" | "br" => text_buf.push(' '),
        "blip" => {
            if let Some(rid) = node
                .attributes()
                .find(|a| a.name() == "embed" || a.name() == "link")
                .map(|a| a.value())
                && let Some(target) = rels.get(rid)
            {
                let zip_path = normalize_word_target(target);
                image_urls.push(media_url("docx", book_id, &zip_path));
            }
        }
        "imagedata" => {
            if let Some(rid) = node
                .attributes()
                .find(|a| a.name() == "id")
                .map(|a| a.value())
                && let Some(target) = rels.get(rid)
            {
                let zip_path = normalize_word_target(target);
                image_urls.push(media_url("docx", book_id, &zip_path));
            }
        }
        _ => {}
    }

    for child in node.children() {
        collect_docx_paragraph_nodes(child, book_id, rels, text_buf, image_urls);
    }
}

#[allow(clippy::too_many_arguments)]
fn render_paragraph(
    p: Node,
    book_id: &str,
    rels: &HashMap<String, String>,
    sentences: &mut Vec<SentenceItem>,
    toc: &mut Vec<TocEntry>,
    html: &mut String,
    paragraph_idx: &mut usize,
    current_chapter_idx: &mut Option<usize>,
) {
    let heading_level = detect_heading_level(p);
    let mut text_buf = String::new();
    let mut image_urls = Vec::new();

    collect_docx_paragraph_nodes(p, book_id, rels, &mut text_buf, &mut image_urls);

    for img_url in &image_urls {
        html.push_str(&format!(
            "<figure class=\"br-figure\"><img src=\"{}\" alt=\"Document image\" loading=\"lazy\"/></figure>\n",
            escape_html(img_url)
        ));
    }

    let cleaned = text_buf.trim();
    if cleaned.is_empty() {
        return;
    }

    if let Some(lvl) = heading_level {
        let chap_idx = toc.len();
        toc.push(TocEntry {
            title: cleaned.to_string(),
            sentence_idx: sentences.len(),
            page: None,
            level: lvl,
        });
        *current_chapter_idx = Some(chap_idx);
    }

    let tag = match heading_level {
        Some(1) => "h1",
        Some(2) => "h2",
        Some(3) => "h3",
        Some(_) => "h4",
        None => "p",
    };

    let parts = split_sentences(cleaned);
    if parts.is_empty() {
        return;
    }

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
            paragraph_idx: *paragraph_idx,
            is_paragraph_end: is_para_end,
            is_section_break: heading_level.is_some() && is_para_end,
            chapter_idx: *current_chapter_idx,
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
    *paragraph_idx += 1;
}

fn detect_heading_level(p: Node) -> Option<usize> {
    let p_style = p
        .descendants()
        .find(|n| n.tag_name().name() == "pStyle")
        .and_then(|n| n.attributes().find(|a| a.name() == "val").map(|a| a.value()))?;
    let lower = p_style.to_ascii_lowercase();
    if let Some(rest) = lower.strip_prefix("heading") {
        rest.trim().parse::<usize>().ok().map(|n| n.clamp(1, 6))
    } else if lower == "title" {
        Some(1)
    } else {
        None
    }
}

fn read_rels(archive: &mut ZipArchive<File>) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let Ok(rels_xml) = read_zip_string(archive, "word/_rels/document.xml.rels") else {
        return map;
    };
    let Ok(doc) = Document::parse(&rels_xml) else {
        return map;
    };
    for node in doc
        .descendants()
        .filter(|n| n.tag_name().name() == "Relationship")
    {
        if let (Some(id), Some(target)) = (node.attribute("Id"), node.attribute("Target")) {
            map.insert(id.to_string(), target.to_string());
        }
    }
    map
}

fn normalize_word_target(target: &str) -> String {
    let trimmed = target.trim_start_matches('/');
    if trimmed.starts_with("word/") {
        trimmed.to_string()
    } else if let Some(rel) = trimmed.strip_prefix("../") {
        rel.to_string()
    } else {
        format!("word/{trimmed}")
    }
}

pub(crate) fn read_zip_string(archive: &mut ZipArchive<File>, name: &str) -> Result<String, String> {
    const MAX_ZIP_XML_BYTES: usize = 32 * 1024 * 1024;
    let entry = archive
        .by_name(name)
        .map_err(|e| format!("Missing archive entry {name}: {e}"))?;
    let mut buf = Vec::new();
    entry
        .take((MAX_ZIP_XML_BYTES + 1) as u64)
        .read_to_end(&mut buf)
        .map_err(|e| format!("Failed reading {name}: {e}"))?;
    if buf.len() > MAX_ZIP_XML_BYTES {
        return Err(format!("Archive entry {name} exceeds maximum allowed size"));
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}
