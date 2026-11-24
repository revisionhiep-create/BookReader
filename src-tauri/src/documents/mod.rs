//! Unified document importer, parser dispatcher, and `bookmedia` protocol asset handler.

pub mod docx;
pub mod epub;
pub mod sentence_split;
pub mod txt;

use crate::models::{BookFormat, BookMeta, DocumentPayload};
use crate::paths::AppPaths;
use crate::storage::{Storage, now_unix_secs};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use tauri::http::{Request, Response, StatusCode, header};
use zip::ZipArchive;

/// Returns the platform-appropriate custom protocol base URL (`http://bookmedia.localhost` on Windows,
/// `bookmedia://localhost` on macOS/Linux WKWebView).
pub fn media_base_url() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "http://bookmedia.localhost"
    }
    #[cfg(not(target_os = "windows"))]
    {
        "bookmedia://localhost"
    }
}

/// Generates a WebView-compatible custom protocol URL for book files and embedded images.
pub fn media_url(kind: &str, book_id: &str, rel_path: &str) -> String {
    let clean = rel_path.trim_start_matches('/');
    format!("{}/{kind}/{book_id}/{clean}", media_base_url())
}

/// Copies an external book into `BookReader_Data/books/` and registers it in `library.json`.
pub fn import_book(source_path: &Path, storage: &Storage) -> Result<BookMeta, String> {
    let ext = source_path
        .extension()
        .and_then(|e| e.to_str())
        .ok_or_else(|| "Selected file has no extension".to_string())?;
    let format = BookFormat::from_extension(ext)
        .ok_or_else(|| format!("Unsupported format '.{ext}'. Supported: PDF, EPUB, DOCX, TXT"))?;

    let original_filename = source_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("book")
        .to_string();
    let title = source_path
        .file_stem()
        .and_then(|n| n.to_str())
        .unwrap_or("Untitled Book")
        .to_string();

    let id = uuid::Uuid::new_v4().to_string();
    let stored_filename = format!("{id}.{}", format.as_ext());
    let dest = storage.paths().book_path(&stored_filename)?;

    fs::copy(source_path, &dest)
        .map_err(|e| format!("Failed copying book to {}: {e}", dest.display()))?;

    let settings = storage.settings();
    let now = now_unix_secs();
    let mut book = BookMeta {
        id,
        title,
        format,
        stored_filename,
        original_filename,
        added_at: now,
        last_opened_at: now,
        current_sentence_idx: 0,
        current_page: 1,
        scroll_y: 0.0,
        total_sentences: 0,
        total_words: 0,
        pdf_header_ignore_pct: settings.default_pdf_header_ignore_pct,
        pdf_footer_ignore_pct: settings.default_pdf_footer_ignore_pct,
        bookmarks: Vec::new(),
    };

    // For EPUB/DOCX/TXT, parse immediately to populate metadata (title, sentence & word counts)
    if book.format != BookFormat::Pdf
        && let Ok(parsed) = load_non_pdf_document(&dest, book.clone())
    {
        book = parsed.book;
    }

    storage.upsert_book(book)
}

/// Parses an EPUB, DOCX, or TXT document from disk into HTML + sentences + TOC.
pub fn load_non_pdf_document(path: &Path, book: BookMeta) -> Result<DocumentPayload, String> {
    match book.format {
        BookFormat::Txt => txt::parse_txt(path, book),
        BookFormat::Docx => docx::parse_docx(path, book),
        BookFormat::Epub => epub::parse_epub(path, book),
        BookFormat::Pdf => Err("PDF documents are rendered directly in the viewer".to_string()),
    }
}

/// Serves `bookmedia` custom protocol requests for PDFs (with HTTP Range support) and embedded EPUB/DOCX images.
pub fn handle_media_request(
    paths: &AppPaths,
    storage: &Storage,
    request: &Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    if request.method() == tauri::http::Method::OPTIONS {
        return Response::builder()
            .status(StatusCode::NO_CONTENT)
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .header(header::ACCESS_CONTROL_ALLOW_METHODS, "GET, HEAD, OPTIONS")
            .header(
                header::ACCESS_CONTROL_ALLOW_HEADERS,
                "Range, Content-Type, Accept, Origin",
            )
            .header(
                header::ACCESS_CONTROL_EXPOSE_HEADERS,
                "Accept-Ranges, Content-Length, Content-Range",
            )
            .body(Vec::new())
            .unwrap();
    }

    let uri_path = request.uri().path().trim_start_matches('/');
    let mut parts = uri_path.splitn(3, '/');
    let kind = parts.next().unwrap_or("");
    let book_id = parts.next().unwrap_or("");
    let inner_path = parts.next().unwrap_or("");

    let Some(book) = storage.get_book(book_id) else {
        return error_response(StatusCode::NOT_FOUND, "Book not found");
    };
    let Ok(file_path) = paths.book_path(&book.stored_filename) else {
        return error_response(StatusCode::BAD_REQUEST, "Invalid book path");
    };

    match kind {
        "book" => serve_file_with_ranges(&file_path, request),
        "epub" | "docx" => serve_zip_entry(&file_path, inner_path),
        _ => error_response(StatusCode::NOT_FOUND, "Unknown media kind"),
    }
}

fn serve_file_with_ranges(path: &Path, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let Ok(mut file) = File::open(path) else {
        return error_response(StatusCode::NOT_FOUND, "Book file missing");
    };
    let Ok(meta) = file.metadata() else {
        return error_response(StatusCode::INTERNAL_SERVER_ERROR, "Metadata error");
    };
    let total_len = meta.len();
    let mime = guess_mime(path.to_str().unwrap_or(""));
    let is_head = request.method() == tauri::http::Method::HEAD;

    if let Some(range_hdr) = request
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        && let Some((start, end)) = parse_byte_range(range_hdr, total_len)
    {
        let chunk_len = (end - start + 1) as usize;
        let buf = if is_head {
            Vec::new()
        } else {
            let mut b = vec![0u8; chunk_len];
            if file.seek(SeekFrom::Start(start)).is_err() || file.read_exact(&mut b).is_err() {
                return error_response(StatusCode::INTERNAL_SERVER_ERROR, "Read error");
            }
            b
        };
        return Response::builder()
            .status(StatusCode::PARTIAL_CONTENT)
            .header(header::CONTENT_TYPE, mime)
            .header(header::ACCEPT_RANGES, "bytes")
            .header(header::CONTENT_LENGTH, chunk_len.to_string())
            .header(
                header::CONTENT_RANGE,
                format!("bytes {start}-{end}/{total_len}"),
            )
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .header(
                header::ACCESS_CONTROL_EXPOSE_HEADERS,
                "Accept-Ranges, Content-Length, Content-Range",
            )
            .body(buf)
            .unwrap();
    }

    let buf = if is_head {
        Vec::new()
    } else {
        let mut b = Vec::with_capacity(total_len as usize);
        if file.read_to_end(&mut b).is_err() {
            return error_response(StatusCode::INTERNAL_SERVER_ERROR, "Read error");
        }
        b
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, total_len.to_string())
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(
            header::ACCESS_CONTROL_EXPOSE_HEADERS,
            "Accept-Ranges, Content-Length, Content-Range",
        )
        .body(buf)
        .unwrap()
}

fn serve_zip_entry(zip_path: &Path, entry_path: &str) -> Response<Vec<u8>> {
    let Ok(file) = File::open(zip_path) else {
        return error_response(StatusCode::NOT_FOUND, "Archive missing");
    };
    let Ok(mut archive) = ZipArchive::new(file) else {
        return error_response(StatusCode::INTERNAL_SERVER_ERROR, "Invalid archive");
    };
    let decoded = percent_decode_path(entry_path);
    let Ok(mut entry) = archive.by_name(&decoded) else {
        return error_response(StatusCode::NOT_FOUND, "Embedded image not found");
    };
    let mut buf = Vec::new();
    if entry.read_to_end(&mut buf).is_err() {
        return error_response(StatusCode::INTERNAL_SERVER_ERROR, "Failed reading image");
    }
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, guess_mime(&decoded))
        .header(header::CACHE_CONTROL, "max-age=3600")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(buf)
        .unwrap()
}

fn parse_byte_range(header_val: &str, total: u64) -> Option<(u64, u64)> {
    if total == 0 {
        return None;
    }
    let spec = header_val.strip_prefix("bytes=")?;
    let (start_s, end_s) = spec.split_once('-')?;
    let start: u64 = start_s.trim().parse().ok()?;
    if start >= total {
        return None;
    }
    let end = if end_s.trim().is_empty() {
        total - 1
    } else {
        end_s.trim().parse::<u64>().ok()?.min(total - 1)
    };
    (start <= end).then_some((start, end))
}

fn percent_decode_path(s: &str) -> String {
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

fn guess_mime(path: &str) -> &'static str {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".pdf") {
        "application/pdf"
    } else if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".gif") {
        "image/gif"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else if lower.ends_with(".svg") {
        "image/svg+xml"
    } else {
        "application/octet-stream"
    }
}

fn error_response(status: StatusCode, msg: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(msg.as_bytes().to_vec())
        .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    #[test]
    fn parses_txt_docx_and_epub_with_images() {
        let root = std::env::temp_dir().join(format!("bookreader_doc_test_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();

        // 1. TXT
        let txt_path = root.join("sample.txt");
        fs::write(&txt_path, "Chapter 1\n\nFirst line. Second line.\n\nThird line!").unwrap();
        let txt_doc = txt::parse_txt(&txt_path, BookMeta::default()).unwrap();
        assert_eq!(txt_doc.toc.len(), 1);
        assert_eq!(txt_doc.sentences.len(), 4);

        // 2. Synthetic DOCX with Heading1 + inline image
        let docx_path = root.join("sample.docx");
        {
            let f = File::create(&docx_path).unwrap();
            let mut zw = zip::ZipWriter::new(f);
            let opts = SimpleFileOptions::default();
            zw.start_file("word/_rels/document.xml.rels", opts).unwrap();
            zw.write_all(
                br#"<?xml version="1.0" encoding="UTF-8"?>
                <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
                    <Relationship Id="rId1" Target="media/pic.png"/>
                </Relationships>"#,
            )
            .unwrap();
            zw.start_file("word/document.xml", opts).unwrap();
            zw.write_all(
                br#"<?xml version="1.0" encoding="UTF-8"?>
                <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
                            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
                            xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
                  <w:body>
                    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Intro</w:t></w:r></w:p>
                    <w:p><w:r><a:blip r:embed="rId1"/><w:t>Hello Word.</w:t></w:r></w:p>
                  </w:body>
                </w:document>"#,
            )
            .unwrap();
            zw.finish().unwrap();
        }
        let mut docx_meta = BookMeta::default();
        docx_meta.id = "b1".into();
        docx_meta.format = BookFormat::Docx;
        let docx_doc = docx::parse_docx(&docx_path, docx_meta).unwrap();
        assert_eq!(docx_doc.toc.len(), 1);
        assert_eq!(docx_doc.sentences.len(), 2);
        assert!(docx_doc.html_chapters[0].html.contains("word/media/pic.png"));

        // 3. Synthetic EPUB with spine + image
        let epub_path = root.join("sample.epub");
        {
            let f = File::create(&epub_path).unwrap();
            let mut zw = zip::ZipWriter::new(f);
            let opts = SimpleFileOptions::default();
            zw.start_file("META-INF/container.xml", opts).unwrap();
            zw.write_all(
                br#"<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#,
            ).unwrap();
            zw.start_file("OEBPS/content.opf", opts).unwrap();
            zw.write_all(
                br#"<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>EPUB Book</dc:title></metadata><manifest><item id="c1" href="Text/ch1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>"#,
            ).unwrap();
            zw.start_file("OEBPS/Text/ch1.xhtml", opts).unwrap();
            zw.write_all(
                br#"<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Ch One</h1><img src="../Images/hero.png"/><p>First epub sentence. Second epub sentence.</p></body></html>"#,
            ).unwrap();
            zw.finish().unwrap();
        }
        let mut epub_meta = BookMeta::default();
        epub_meta.id = "b2".into();
        epub_meta.format = BookFormat::Epub;
        let epub_doc = epub::parse_epub(&epub_path, epub_meta).unwrap();
        assert_eq!(epub_doc.book.title, "EPUB Book");
        assert_eq!(epub_doc.sentences.len(), 3);
        assert!(epub_doc.html_chapters[0].html.contains("OEBPS/Images/hero.png"));

        // 4. EPUB chapter with DOCTYPE, HTML named entities (&nbsp;, &mdash;, &ldquo;, &rdquo;), and unknown &custom; entity
        let epub_entities_path = root.join("entities.epub");
        {
            let f = File::create(&epub_entities_path).unwrap();
            let mut zw = zip::ZipWriter::new(f);
            let opts = SimpleFileOptions::default();
            zw.start_file("META-INF/container.xml", opts).unwrap();
            zw.write_all(
                br#"<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#,
            ).unwrap();
            zw.start_file("content.opf", opts).unwrap();
            zw.write_all(
                br#"<?xml version="1.0"?><package xmlns="http://www.idpf.org/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Entity Book</dc:title></metadata><manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>"#,
            ).unwrap();
            zw.start_file("ch1.xhtml", opts).unwrap();
            zw.write_all(
                br#"<?xml version="1.0"?><!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd"><html xmlns="http://www.w3.org/1999/xhtml"><body><p>&ldquo;Wait&mdash;what?&rdquo;&nbsp;She smiled &custom; ran.</p></body></html>"#,
            ).unwrap();
            zw.finish().unwrap();
        }
        let mut ent_meta = BookMeta::default();
        ent_meta.id = "b3".into();
        ent_meta.format = BookFormat::Epub;
        let ent_doc = epub::parse_epub(&epub_entities_path, ent_meta).unwrap();
        assert_eq!(ent_doc.sentences.len(), 2);
        assert!(ent_doc.sentences[0].text.contains("Wait—what?"));
        assert!(ent_doc.sentences[1].text.contains("She smiled &custom; ran."));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn bookmedia_protocol_handles_options_ranges_zip_images_and_404() {
        let root =
            std::env::temp_dir().join(format!("bookreader_media_test_{}", uuid::Uuid::new_v4()));
        let paths = AppPaths::from_roots(root.join("appdata"), root.join("data")).unwrap();
        let storage = Storage::load(paths.clone()).unwrap();

        let pdf_src = root.join("sample.pdf");
        fs::write(&pdf_src, b"%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n").unwrap();
        let book = import_book(&pdf_src, &storage).unwrap();

        // OPTIONS preflight
        let opts_req = Request::builder()
            .method(tauri::http::Method::OPTIONS)
            .uri(format!("{}/book/{}", media_base_url(), book.id))
            .body(Vec::new())
            .unwrap();
        let opts_resp = handle_media_request(&paths, &storage, &opts_req);
        assert_eq!(opts_resp.status(), StatusCode::NO_CONTENT);
        assert!(opts_resp.headers().contains_key(header::ACCESS_CONTROL_EXPOSE_HEADERS));

        // Partial byte range (used by PDF.js streaming)
        let range_req = Request::builder()
            .method(tauri::http::Method::GET)
            .uri(format!("{}/book/{}", media_base_url(), book.id))
            .header(header::RANGE, "bytes=0-7")
            .body(Vec::new())
            .unwrap();
        let range_resp = handle_media_request(&paths, &storage, &range_req);
        assert_eq!(range_resp.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(range_resp.body(), b"%PDF-1.4");
        assert!(range_resp.headers().contains_key(header::CONTENT_RANGE));

        // HEAD request
        let head_req = Request::builder()
            .method(tauri::http::Method::HEAD)
            .uri(format!("{}/book/{}", media_base_url(), book.id))
            .body(Vec::new())
            .unwrap();
        let head_resp = handle_media_request(&paths, &storage, &head_req);
        assert_eq!(head_resp.status(), StatusCode::OK);
        assert!(head_resp.body().is_empty());

        // Missing book returns 404
        let missing_req = Request::builder()
            .method(tauri::http::Method::GET)
            .uri(format!("{}/book/does-not-exist", media_base_url()))
            .body(Vec::new())
            .unwrap();
        assert_eq!(
            handle_media_request(&paths, &storage, &missing_req).status(),
            StatusCode::NOT_FOUND
        );

        let _ = fs::remove_dir_all(root);
    }
}
