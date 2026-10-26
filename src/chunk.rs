//! Splitting OCR text into chunks: an exact port of `chunks()` and the source naming in `rag.py`.
//!
//! The eval baseline was measured with `rag.py`, so any difference here (even one char of
//! overlap) can change retrieval results. Tests compare against `rag.py`'s own output.

/// Upper bound on a chunk's length, in Unicode code points (Python's `len`).
const CHUNK_CHARS: usize = 1500;
/// Lines repeated at the start of the next chunk.
const OVERLAP_LINES: usize = 3;

/// Splits `text` on line boundaries so table rows stay whole, repeating a few lines between chunks.
///
/// Port of `for line in filter(str.strip, text.splitlines())`: a line is kept unless it is
/// empty or whitespace-only. Splitting on every Python line break and dropping the empty
/// pieces gives the same lines as `splitlines()`, including for `\r\n` (it leaves an empty
/// piece between `\r` and `\n`, which the filter drops).
pub fn chunks(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur: Vec<&str> = Vec::new();
    for line in text
        .split(is_python_line_break)
        .filter(|l| !l.chars().all(is_python_space))
    {
        let cur_len: usize = cur.iter().map(|l| l.chars().count() + 1).sum();
        if !cur.is_empty() && cur_len + line.chars().count() > CHUNK_CHARS {
            out.push(cur.join("\n"));
            // Python: cur = cur[-OVERLAP_LINES:]
            cur.drain(..cur.len().saturating_sub(OVERLAP_LINES));
        }
        cur.push(line);
    }
    if !cur.is_empty() {
        out.push(cur.join("\n"));
    }
    out
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

    /// Synthetic cases with `rag.py`'s output as the expected values. Regenerate by running
    /// rag.py's `chunks()` on the same inputs; never put real document text in this file.
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

    /// Compares every file in the configured OCR folder with what `rag.py` produces right now.
    /// Ignored by default: it needs the private documents and `.venv`. Run with
    /// `cargo test -- --ignored`. Prints counts only, never document text or names.
    #[test]
    #[ignore]
    fn real_ocr_files_match_rag_py() {
        use std::collections::BTreeMap;
        use std::path::{Path, PathBuf};

        let config_path = crate::config::expand_home(Path::new(crate::config::DEFAULT_CONFIG_PATH));
        let ocr = crate::config::Config::load(&config_path)
            .unwrap()
            .paths
            .ocr_dir;
        // Pulls chunks() and its constants out of rag.py without importing its heavy deps.
        let script = r#"
import ast, json, sys
from pathlib import Path
tree = ast.parse(Path("rag.py").read_text())
keep = [n for n in tree.body if (isinstance(n, ast.FunctionDef) and n.name == "chunks")
        or (isinstance(n, ast.Assign) and n.targets[0].id in ("CHUNK_CHARS", "OVERLAP_LINES"))]
ns = {}
exec(compile(ast.Module(keep, []), "rag", "exec"), ns)
ocr = Path(sys.argv[1])
json.dump({str(f.relative_to(ocr)): [str(f.relative_to(ocr)).rsplit(".", 3)[0], ns["chunks"](f.read_text())]
           for f in sorted(ocr.rglob("*.txt"))}, sys.stdout)
"#;
        let output = std::process::Command::new(".venv/bin/python")
            .args(["-c", script])
            .arg(&ocr)
            .output()
            .expect("run .venv/bin/python");
        assert!(output.status.success(), "rag.py helper failed");
        let python: BTreeMap<String, (String, Vec<String>)> =
            serde_json::from_slice(&output.stdout).unwrap();

        fn txt_files(dir: &Path, out: &mut Vec<PathBuf>) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    txt_files(&path, out);
                } else if path.extension().is_some_and(|e| e == "txt") {
                    out.push(path);
                }
            }
        }
        let mut files = Vec::new();
        txt_files(&ocr, &mut files);

        let (mut same, mut different) = (0, 0);
        for file in &files {
            let rel = file.strip_prefix(&ocr).unwrap().to_str().unwrap();
            let text = std::fs::read_to_string(file).unwrap();
            let ok = python.get(rel).is_some_and(|(source, parts)| {
                *source == source_name(rel) && *parts == chunks(&text)
            });
            if ok { same += 1 } else { different += 1 }
        }
        println!(
            "{same} files match, {different} differ, {} seen only by Python",
            python.len().saturating_sub(same + different)
        );
        assert!(same > 0, "no OCR files found");
        assert_eq!(different, 0);
        assert_eq!(files.len(), python.len());
    }
}
