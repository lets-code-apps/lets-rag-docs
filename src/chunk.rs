//! Splitting OCR text into chunks: an exact port of `chunks()` and the source naming in `rag.py`.
//!
//! The eval baseline was measured with `rag.py`, so any difference here (even one char of
//! overlap) can change retrieval results. The tests freeze `rag.py`'s output in
//! `testdata/chunk_cases.json` (rag.py has since been removed). `chunks()` output stays
//! byte-identical with page markers added: `paged_chunks` is the same loop, annotated.

/// Upper bound on a chunk's length, in Unicode code points (Python's `len`).
const CHUNK_CHARS: usize = 1500;
/// Lines repeated at the start of the next chunk.
const OVERLAP_LINES: usize = 3;

/// Splits `text` on line boundaries so table rows stay whole, repeating a few lines between
/// chunks. Same loop as `paged_chunks`, pages dropped.
///
/// Port of `for line in filter(str.strip, text.splitlines())`: a line is kept unless it is
/// empty or whitespace-only. Splitting on every Python line break and dropping the empty
/// pieces gives the same lines as `splitlines()`, including for `\r\n` (it leaves an empty
/// piece between `\r` and `\n`, which the filter drops).
pub fn chunks(text: &str) -> Vec<String> {
    paged_chunks(text)
        .into_iter()
        .map(|(chunk, _page)| chunk)
        .collect()
}

/// The chunks with the page each one starts on (`None` when the OCR text has no page markers).
///
/// `ocr.py` starts every page of the OCR text with a form feed, so a line's page is the number
/// of markers that came before it. A chunk's page is the page of its first NON-overlap line:
/// the overlap lines it repeats were already covered by the previous chunk. Text without a
/// leading `\f` (OCR'd before markers existed) gets `None` pages rather than a false "p. 1".
pub fn paged_chunks(text: &str) -> Vec<(String, Option<u32>)> {
    let mut out: Vec<(String, Option<u32>)> = Vec::new();
    let mut cur: Vec<String> = Vec::new();
    let mut cur_page: Option<u32> = None;
    for (page, line) in paged_lines(text) {
        let cur_len: usize = cur.iter().map(|l| l.chars().count() + 1).sum();
        if !cur.is_empty() && cur_len + line.chars().count() > CHUNK_CHARS {
            out.push((cur.join("\n"), cur_page));
            // Python: cur = cur[-OVERLAP_LINES:]
            cur.drain(..cur.len().saturating_sub(OVERLAP_LINES));
            // The chunk continues with `line`, which is not an overlap line, so it sets
            // the page. (After the drain `cur` is never empty, so the branch below skips.)
            cur_page = page;
        }
        if cur.is_empty() {
            cur_page = page;
        }
        cur.push(line);
    }
    if !cur.is_empty() {
        out.push((cur.join("\n"), cur_page));
    }
    out
}

/// The kept (non-blank) lines of `text`, each tagged with the page it is on: the count of
/// `\f` markers before the line (`None` for every line when the text has no leading marker,
/// so an old OCR file is never guessed at). The same break set and empty-line filter as
/// `chunks()`, so the kept lines are identical.
fn paged_lines(text: &str) -> Vec<(Option<u32>, String)> {
    let numbered = text.starts_with("\x0C");
    let mut out: Vec<(Option<u32>, String)> = Vec::new();
    let mut page: u32 = 0;
    let mut start: usize = 0;
    let mut pos: usize = 0;
    for ch in text.chars() {
        if is_python_line_break(ch) {
            let line: String = text[start..pos].to_string();
            if !line.chars().all(is_python_space) {
                out.push((if numbered { Some(page) } else { None }, line));
            }
            // The marker opens the NEXT page; a line ending at a marker is still on this one.
            if ch == '\x0C' {
                page += 1;
            }
            start = pos + ch.len_utf8();
        }
        pos += ch.len_utf8();
    }
    if start < text.len() {
        // The part after the last line break, like `splitlines()` keeps.
        let line: String = text[start..].to_string();
        if !line.chars().all(is_python_space) {
            out.push((if numbered { Some(page) } else { None }, line));
        }
    }
    out
}

/// The number of pages in OCR text that starts every page with `\f` (`None` when it carries
/// no markers). Counting only: the text itself is never shown.
pub fn page_count(text: &str) -> Option<u32> {
    if !text.starts_with("\x0C") {
        return None;
    }
    let markers: usize = text.chars().filter(|c| *c == '\x0C').count();
    Some(markers as u32)
}

/// The document name for a file path relative to the OCR folder:
/// `a/b.pdf.text.txt` -> `a/b`. Port of Python's `rsplit(".", 3)[0]`.
pub fn source_name(rel_path: &str) -> String {
    // rsplitn yields pieces from the right; the last one is everything left of the 3rd dot.
    rel_path
        .rsplitn(4, '.')
        .last()
        .unwrap_or(rel_path)
        .to_string()
}

/// The characters Python's `str.splitlines()` breaks on.
fn is_python_line_break(c: char) -> bool {
    matches!(
        c,
        '\n' | '\r'
            | '\x0b'
            | '\x0c'
            | '\x1c'
            | '\x1d'
            | '\x1e'
            | '\u{85}'
            | '\u{2028}'
            | '\u{2029}'
    )
}

/// Python's `str.isspace()`: Unicode White_Space (Rust's `is_whitespace`) plus the
/// separators U+001C..U+001F, which Python also counts as whitespace.
fn is_python_space(c: char) -> bool {
    c.is_whitespace() || ('\x1c'..='\x1f').contains(&c)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Synthetic cases with `rag.py`'s output as the expected values, generated from its `chunks()`
    /// before it was removed. Edit by hand only with care; never put real document text in it.
    const CASES: &str = include_str!("../testdata/chunk_cases.json");

    #[test]
    fn chunks_match_rag_py() {
        let cases: serde_json::Value = serde_json::from_str(CASES).unwrap();
        for case in cases["chunks"].as_array().unwrap() {
            let expected: Vec<String> = serde_json::from_value(case["expected"].clone()).unwrap();
            assert_eq!(
                chunks(case["text"].as_str().unwrap()),
                expected,
                "case {}",
                case["name"]
            );
        }
    }

    #[test]
    fn source_names_match_rag_py() {
        let cases: serde_json::Value = serde_json::from_str(CASES).unwrap();
        for case in cases["sources"].as_array().unwrap() {
            assert_eq!(
                source_name(case["path"].as_str().unwrap()),
                case["expected"]
            );
        }
    }

    #[test]
    fn python_space_matches_str_isspace() {
        // The full list printed by `[c for c in range(0x110000) if chr(c).isspace()]`.
        let python: Vec<u32> = [0x9..=0xd, 0x1c..=0x20, 0x85..=0x85, 0xa0..=0xa0]
            .into_iter()
            .flatten()
            .chain([0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000])
            .chain(0x2000..=0x200a)
            .collect();
        let rust: Vec<u32> = (0..=0x10ffff_u32)
            .filter_map(char::from_u32)
            .filter(|&c| is_python_space(c))
            .map(u32::from)
            .collect();
        let mut python = python;
        python.sort();
        assert_eq!(rust, python);
    }

    #[test]
    fn markers_do_not_change_chunks() {
        // `\f` is already one of the break characters `splitlines()` eats, so a page boundary
        // looks like a blank line: the chunks stay byte-identical, markers and all.
        assert_eq!(chunks("\x0Ca\n\x0Cb"), chunks("a\n\nb"));
    }

    #[test]
    fn pages_follow_markers() {
        let parts = paged_chunks("\x0Cpage one line\nsecond line\x0Cpage two line");
        assert_eq!(
            parts,
            [(
                "page one line\nsecond line\npage two line".to_string(),
                Some(1_u32)
            )],
        );
        // Two pages still fit one chunk: the chunk's page is the page it started on.
        let two_pages = paged_chunks("\x0Cpage one line\x0Cpage two line");
        assert_eq!(
            two_pages,
            [("page one line\npage two line".to_string(), Some(1_u32))],
        );
    }

    #[test]
    fn no_leading_marker_means_no_pages() {
        // OCR'd before markers existed: no page is honest, "p. 1" would be a guess.
        assert_eq!(paged_chunks("a\nb"), [("a\nb".to_string(), None)]);
        assert_eq!(page_count("a\nb"), None);
        assert_eq!(page_count("\x0Cpage one\x0Cpage two"), Some(2_u32));
    }

    #[test]
    fn page_skips_overlap_lines() {
        // Page 1: three 600-char lines (the third no longer fits). Page 2: one more line.
        let long = "x".repeat(600);
        let text: String = format!("\x0C{long}\n{long}\n{long}\x0C{long}");
        let parts = paged_chunks(text.as_str());
        // Same overlap rule as rag.py: fewer lines than the overlap repeats all of them,
        // so four lines still make three chunks.
        assert_eq!(parts.len(), 3);
        // The first chunks start on page 1; the last chunk repeats page-1 lines but NEWLY
        // carries the page-2 line, so its page is page 2.
        assert_eq!(parts[0].1, Some(1_u32));
        assert_eq!(parts[1].1, Some(1_u32));
        assert_eq!(parts[2].1, Some(2_u32));
        assert!(parts[2].0.starts_with(&long));
    }
}
