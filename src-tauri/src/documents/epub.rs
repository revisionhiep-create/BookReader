//! `.epub` e-book parser extracting spine chapters, TOC, sentences, and embedded images.

use crate::documents::docx::read_zip_string;
use crate::documents::media_url;
use crate::documents::sentence_split::split_sentences;
use crate::documents::txt::escape_html;
use crate::models::{BookMeta, ChapterHtml, DocumentPayload, SentenceItem, TocEntry};
use roxmltree::{Document, Node};
use std::collections::HashMap;
use std::fs::File;
use std::path::Path;
use zip::ZipArchive;

pub fn parse_epub(path: &Path, mut book: BookMeta) -> Result<DocumentPayload, String> {
    let file = File::open(path).map_err(|e| format!("Failed opening EPUB: {e}"))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("Invalid EPUB zip archive: {e}"))?;

    let container_xml = read_zip_string(&mut archive, "META-INF/container.xml")?;
    let container_doc =
        Document::parse(&container_xml).map_err(|e| format!("Invalid container.xml: {e}"))?;
    let opf_path = container_doc
        .descendants()
        .find(|n| n.tag_name().name() == "rootfile")
        .and_then(|n| n.attribute("full-path"))
        .ok_or_else(|| "EPUB missing rootfile full-path".to_string())?
        .to_string();

    let opf_dir = parent_dir(&opf_path);
    let opf_xml = read_zip_string(&mut archive, &opf_path)?;
    let opf_doc = Document::parse(&opf_xml).map_err(|e| format!("Invalid OPF XML: {e}"))?;

    if book.title.is_empty()
        && let Some(meta_title) = opf_doc
            .descendants()
            .find(|n| n.tag_name().name() == "title")
            .and_then(|n| n.text())
            .map(str::trim)
            .filter(|t| !t.is_empty())
    {
        book.title = meta_title.to_string();
    }

    let mut manifest: HashMap<String, String> = HashMap::new();
    let mut ncx_path: Option<String> = None;
    for item in opf_doc.descendants().filter(|n| n.tag_name().name() == "item") {
        if let (Some(id), Some(href)) = (item.attribute("id"), item.attribute("href")) {
            let resolved = resolve_zip_path(&opf_dir, href);
            if item.attribute("media-type") == Some("application/x-dtbncx+xml") {
                ncx_path = Some(resolved.clone());
            }
            manifest.insert(id.to_string(), resolved);
        }
    }

    let mut spine_files: Vec<String> = Vec::new();
    for itemref in opf_doc
        .descendants()
        .filter(|n| n.tag_name().name() == "itemref")
    {
        if let Some(idref) = itemref.attribute("idref")
            && let Some(path) = manifest.get(idref)
        {
            spine_files.push(path.clone());
        }
    }

    // Fallback if spine was empty: use HTML/XHTML manifest entries
    if spine_files.is_empty() {
        for p in manifest.values() {
            if p.ends_with(".xhtml") || p.ends_with(".html") || p.ends_with(".htm") {
                spine_files.push(p.clone());
            }
        }
    }

    let ncx_titles = ncx_path
        .as_deref()
        .map(|p| read_ncx_titles(&mut archive, p))
        .unwrap_or_default();

    let mut sentences: Vec<SentenceItem> = Vec::new();
    let mut toc: Vec<TocEntry> = Vec::new();
    let mut html_chapters: Vec<ChapterHtml> = Vec::new();
    let mut paragraph_idx = 0usize;

    for (chap_idx, chapter_zip_path) in spine_files.iter().enumerate() {
        let Ok(raw_xhtml) = read_zip_string(&mut archive, chapter_zip_path) else {
            continue;
        };
        let xhtml = sanitize_epub_xhtml_for_xml(&raw_xhtml);
        let Ok(doc) = Document::parse(&xhtml) else {
            tracing::warn!(chapter = %chapter_zip_path, "Skipping unparseable EPUB chapter");
            continue;
        };

        let chapter_dir = parent_dir(chapter_zip_path);
        let start_sid = sentences.len();
        let mut chap_html = String::with_capacity(xhtml.len());
        let mut inferred_title: Option<String> = ncx_titles.get(chapter_zip_path).cloned();

        if let Some(body) = doc.descendants().find(|n| n.tag_name().name() == "body") {
            for child in body.children() {
                walk_epub_node(
                    child,
                    &book.id,
                    &chapter_dir,
                    chap_idx,
                    &mut inferred_title,
                    &mut sentences,
                    &mut chap_html,
                    &mut paragraph_idx,
                );
            }
        }

        if chap_html.trim().is_empty() {
            continue;
        }

        let title = inferred_title
            .filter(|t| !t.trim().is_empty())
            .unwrap_or_else(|| format!("Section {}", html_chapters.len() + 1));

        toc.push(TocEntry {
            title: title.clone(),
            sentence_idx: start_sid,
            page: None,
            level: 1,
        });
        html_chapters.push(ChapterHtml {
            title,
            html: chap_html,
        });
    }

    book.total_sentences = sentences.len();
    book.total_words = sentences
        .iter()
        .map(|s| s.text.split_whitespace().count())
        .sum();

    Ok(DocumentPayload {
        book,
        sentences,
        toc,
        html_chapters,
    })
}

#[allow(clippy::too_many_arguments)]
fn walk_epub_node(
    node: Node,
    book_id: &str,
    chapter_dir: &str,
    chapter_idx: usize,
    inferred_title: &mut Option<String>,
    sentences: &mut Vec<SentenceItem>,
    out_html: &mut String,
    paragraph_idx: &mut usize,
) {
    if !node.is_element() {
        return;
    }

    let tag = node.tag_name().name().to_ascii_lowercase();
    match tag.as_str() {
        "script" | "style" | "iframe" | "object" | "embed" => return,
        "img" => {
            if let Some(src) = node.attribute("src") {
                let resolved = resolve_zip_path(chapter_dir, src);
                let url = media_url("epub", book_id, &resolved);
                let alt = node.attribute("alt").unwrap_or("Book image");
                out_html.push_str(&format!(
                    r#"<figure class="br-figure"><img src="{}" alt="{}" loading="lazy"/></figure>"#,
                    escape_html(&url),
                    escape_html(alt)
                ));
            }
            return;
        }
        "svg" => {
            // Preserve embedded SVG cover/illustration images
            for desc in node.descendants() {
                if desc.tag_name().name() == "image"
                    && let Some(href) = desc
                        .attributes()
                        .find(|a| a.name() == "href")
                        .map(|a| a.value())
                {
                    let resolved = resolve_zip_path(chapter_dir, href);
                    let url = media_url("epub", book_id, &resolved);
                    out_html.push_str(&format!(
                        r#"<figure class="br-figure"><img src="{}" alt="Illustration" loading="lazy"/></figure>"#,
                        escape_html(&url)
                    ));
                }
            }
            return;
        }
        "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "p" | "blockquote" | "li" => {
            // Render any nested images in this block first
            for desc in node.descendants() {
                if desc.is_element() && desc.tag_name().name().eq_ignore_ascii_case("img")
                    && let Some(src) = desc.attribute("src")
                {
                    let resolved = resolve_zip_path(chapter_dir, src);
                    let url = media_url("epub", book_id, &resolved);
                    out_html.push_str(&format!(
                        r#"<figure class="br-figure"><img src="{}" alt="Book image" loading="lazy"/></figure>"#,
                        escape_html(&url)
                    ));
                }
            }

            let raw_text = collect_text(node);
            let cleaned = raw_text.trim();
            if cleaned.is_empty() {
                return;
            }

            let is_heading = tag.starts_with('h');
            if is_heading && inferred_title.is_none() {
                *inferred_title = Some(cleaned.to_string());
            }

            let parts = split_sentences(cleaned);
            if parts.is_empty() {
                return;
            }

            out_html.push('<');
            out_html.push_str(&tag);
            out_html.push('>');
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
                    is_section_break: is_heading && is_para_end,
                    chapter_idx: Some(chapter_idx),
                });
                if idx > 0 {
                    out_html.push(' ');
                }
                out_html.push_str(&format!(
                    r#"<span class="br-sent" data-sid="{sid}">{}</span>"#,
                    escape_html(&sent)
                ));
            }
            out_html.push_str("</");
            out_html.push_str(&tag);
            out_html.push_str(">\n");
            *paragraph_idx += 1;
            return;
        }
        "hr" => {
            out_html.push_str("<hr/>\n");
            return;
        }
        _ => {}
    }

    // For container tags (div, section, ul, ol, span, etc.), check if children contain block tags
    let has_block_child = node.children().any(|c| {
        c.is_element()
            && matches!(
                c.tag_name().name().to_ascii_lowercase().as_str(),
                "div"
                    | "section"
                    | "article"
                    | "p"
                    | "h1"
                    | "h2"
                    | "h3"
                    | "h4"
                    | "h5"
                    | "h6"
                    | "blockquote"
                    | "ul"
                    | "ol"
                    | "li"
                    | "figure"
                    | "img"
                    | "svg"
            )
    });

    if has_block_child {
        for child in node.children() {
            walk_epub_node(
                child,
                book_id,
                chapter_dir,
                chapter_idx,
                inferred_title,
                sentences,
                out_html,
                paragraph_idx,
            );
        }
    } else {
        let raw_text = collect_text(node);
        let cleaned = raw_text.trim();
        if !cleaned.is_empty() {
            let parts = split_sentences(cleaned);
            if !parts.is_empty() {
                out_html.push_str("<p>");
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
                        is_section_break: false,
                        chapter_idx: Some(chapter_idx),
                    });
                    if idx > 0 {
                        out_html.push(' ');
                    }
                    out_html.push_str(&format!(
                        r#"<span class="br-sent" data-sid="{sid}">{}</span>"#,
                        escape_html(&sent)
                    ));
                }
                out_html.push_str("</p>\n");
                *paragraph_idx += 1;
            }
        }
    }
}

fn collect_text(node: Node) -> String {
    let mut buf = String::new();
    for desc in node.descendants() {
        if desc.is_text()
            && let Some(t) = desc.text()
        {
            buf.push_str(t);
        } else if desc.is_element() && desc.tag_name().name().eq_ignore_ascii_case("br") {
            buf.push(' ');
        }
    }
    buf.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn read_ncx_titles(archive: &mut ZipArchive<File>, ncx_path: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let Ok(raw_xml) = read_zip_string(archive, ncx_path) else {
        return map;
    };
    let xml = sanitize_epub_xhtml_for_xml(&raw_xml);
    let Ok(doc) = Document::parse(&xml) else {
        return map;
    };
    let ncx_dir = parent_dir(ncx_path);
    for np in doc.descendants().filter(|n| n.tag_name().name() == "navPoint") {
        let label = np
            .children()
            .find(|n| n.tag_name().name() == "navLabel")
            .and_then(|l| l.descendants().find(|n| n.tag_name().name() == "text"))
            .and_then(|t| t.text())
            .map(str::trim);
        let src = np
            .children()
            .find(|n| n.tag_name().name() == "content")
            .and_then(|c| c.attribute("src"));
        if let (Some(label), Some(src)) = (label, src) {
            let clean_src = src.split('#').next().unwrap_or(src);
            let resolved = resolve_zip_path(&ncx_dir, clean_src);
            map.entry(resolved).or_insert_with(|| label.to_string());
        }
    }
    map
}

fn parent_dir(path: &str) -> String {
    match path.rsplit_once('/') {
        Some((dir, _)) => dir.to_string(),
        None => String::new(),
    }
}

/// Resolves relative archive paths cleanly without directory traversal outside the archive.
pub fn resolve_zip_path(base_dir: &str, href: &str) -> String {
    let decoded = percent_decode(href.split('#').next().unwrap_or(href));
    let mut parts: Vec<&str> = if decoded.starts_with('/') || base_dir.is_empty() {
        Vec::new()
    } else {
        base_dir.split('/').filter(|p| !p.is_empty()).collect()
    };
    for seg in decoded.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    parts.join("/")
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3])
            && let Ok(val) = u8::from_str_radix(hex, 16)
        {
            out.push(val);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Strips DOCTYPE declarations and resolves HTML named entities so strict XML parsing
/// (`roxmltree`) succeeds on real-world EPUB 2/3 chapters without silently dropping content.
pub fn sanitize_epub_xhtml_for_xml(raw: &str) -> String {
    let without_doctype = strip_doctype_declarations(raw);
    let mut out = String::with_capacity(without_doctype.len());
    let bytes = without_doctype.as_bytes();
    let mut i = 0usize;

    while i < bytes.len() {
        if bytes[i] == b'&' {
            if let Some(semi_rel) = without_doctype[i + 1..].find(';')
                && semi_rel > 0
                && semi_rel <= 16
            {
                let entity = &without_doctype[i + 1..i + 1 + semi_rel];
                let is_xml_builtin = matches!(entity, "amp" | "lt" | "gt" | "quot" | "apos");
                let is_numeric = is_valid_numeric_entity(entity);

                if is_xml_builtin || is_numeric {
                    out.push('&');
                    out.push_str(entity);
                    out.push(';');
                    i += 1 + semi_rel + 1;
                    continue;
                }
                if entity.bytes().all(|b| b.is_ascii_alphanumeric()) {
                    if let Some(decoded) = decode_html_entity(entity) {
                        out.push_str(decoded);
                    } else {
                        out.push_str("&amp;");
                        out.push_str(entity);
                        out.push(';');
                    }
                    i += 1 + semi_rel + 1;
                    continue;
                }
            }
            // Bare stray `&` not forming a valid XML entity reference
            out.push_str("&amp;");
            i += 1;
            continue;
        }

        let ch = without_doctype[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn strip_doctype_declarations(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0usize;

    while i < bytes.len() {
        if bytes.len() - i >= 9 && bytes[i..i + 9].eq_ignore_ascii_case(b"<!doctype") {
            let mut j = i + 9;
            let mut bracket_depth = 0usize;
            let mut quote: Option<u8> = None;
            while j < bytes.len() {
                let b = bytes[j];
                if let Some(q) = quote {
                    if b == q {
                        quote = None;
                    }
                } else {
                    match b {
                        b'"' | b'\'' => quote = Some(b),
                        b'[' => bracket_depth += 1,
                        b']' if bracket_depth > 0 => bracket_depth -= 1,
                        b'>' if bracket_depth == 0 => {
                            j += 1;
                            break;
                        }
                        _ => {}
                    }
                }
                j += 1;
            }
            i = j;
            continue;
        }
        let ch = input[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn is_valid_numeric_entity(entity: &str) -> bool {
    if let Some(hex) = entity.strip_prefix("#x").or_else(|| entity.strip_prefix("#X")) {
        !hex.is_empty() && hex.bytes().all(|b| b.is_ascii_hexdigit())
    } else if let Some(dec) = entity.strip_prefix('#') {
        !dec.is_empty() && dec.bytes().all(|b| b.is_ascii_digit())
    } else {
        false
    }
}

fn decode_html_entity(name: &str) -> Option<&'static str> {
    match name {
        "nbsp" | "thinsp" | "ensp" | "emsp" => Some(" "),
        "shy" => Some(""),
        "mdash" => Some("—"),
        "ndash" => Some("–"),
        "hellip" => Some("…"),
        "lsquo" => Some("‘"),
        "rsquo" => Some("’"),
        "sbquo" => Some("‚"),
        "ldquo" => Some("“"),
        "rdquo" => Some("”"),
        "bdquo" => Some("„"),
        "laquo" => Some("«"),
        "raquo" => Some("»"),
        "bull" => Some("•"),
        "middot" => Some("·"),
        "sect" => Some("§"),
        "copy" => Some("©"),
        "reg" => Some("®"),
        "trade" => Some("™"),
        "deg" => Some("°"),
        "times" => Some("×"),
        "divide" => Some("÷"),
        "plusmn" => Some("±"),
        "iexcl" => Some("¡"),
        "iquest" => Some("¿"),
        "cent" => Some("¢"),
        "pound" => Some("£"),
        "euro" => Some("€"),
        "yen" => Some("¥"),
        "aacute" => Some("á"),
        "Aacute" => Some("Á"),
        "agrave" => Some("à"),
        "Agrave" => Some("À"),
        "acirc" => Some("â"),
        "auml" => Some("ä"),
        "ccedil" => Some("ç"),
        "Ccedil" => Some("Ç"),
        "eacute" => Some("é"),
        "Eacute" => Some("É"),
        "egrave" => Some("è"),
        "ecirc" => Some("ê"),
        "euml" => Some("ë"),
        "iacute" => Some("í"),
        "icirc" => Some("î"),
        "iuml" => Some("ï"),
        "ntilde" => Some("ñ"),
        "Ntilde" => Some("Ñ"),
        "oacute" => Some("ó"),
        "ocirc" => Some("ô"),
        "ouml" => Some("ö"),
        "uacute" => Some("ú"),
        "ucirc" => Some("û"),
        "uuml" => Some("ü"),
        "Uuml" => Some("Ü"),
        _ => None,
    }
}
