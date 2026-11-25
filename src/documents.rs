//! `lets-rag-docs documents --json`: the classified library as one JSON object.
//!
//! Read-only and hostile-data-safe: the database is opened through `db::open_for_read`, so a
//! missing database or an old schema is reported as data (exit 0, `status` says which), never
//! as a crash and never as a write. Output is the SQLite rows plus sizes and page counts read
//! from the filesystem - names, paths, byte counts, never document text - and every consumer
//! writes it as text, not as markup.

use std::path::{Path, PathBuf};

use anyhow::Context;
use serde::Serialize;

use crate::add;
use crate::chunk;
use crate::config::Config;
use crate::db;
use crate::organize::inside_library;

#[derive(Serialize)]
struct Report {
    /// Wire format version: a consumer that speaks 1 refuses anything else.
    version: u8,
    /// The `[ocr] max_file_mb` limit, so the app can say why a row was skipped in its own
    /// words.
    max_file_mb: u64,
    status: Status,
    documents: Vec<Row>,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum Status {
    Ok,
    NoDatabase,
    Outdated,
}

#[derive(Serialize)]
struct Row {
    path: String,
    title: Option<String>,
    #[serde(rename = "type")]
    doc_type: String,
    date: Option<String>,
    folder: Option<String>,
    owner: Option<String>,
    /// Where `organize --apply` filed the copy, relative to `library_dir` - but only while the
    /// stored path still passes `organize::inside_library`: the row is data on disk, not trusted,
    /// so a tampered `library_path` becomes `null` instead of a path the app would touch.
    filed_as: Option<String>,
    /// Size of the original in bytes, via `symlink_metadata` (links are not followed), and
    /// only while the row's `path` still passes `inside_library(docs_dir, path)` - the same
    /// rule as `filed_as`: a row is not trusted.
    bytes: Option<u64>,
    /// Pages in the OCR text when it starts every page with a form feed (re-OCR'd documents);
    /// the markers are counted only, the text itself never leaves here.
    pages: Option<u32>,
    /// `"over_limit"` when `bytes` exceeds `max_file_mb` MB: the document is listed but not
    /// indexed, and the app shows why.
    skipped: Option<String>,
    /// `true` when the original's contents live only in iCloud Drive: the macOS
    /// `SF_DATALESS` bit in `st_flags`, read from `symlink_metadata` - a `stat` never
    /// downloads the file, so this stays cheap and safe on an iCloud library.
    dataless: bool,
}

pub fn run(config: &Config, json: bool) -> anyhow::Result<()> {
    if !json {
        return Err(anyhow::anyhow!(
            "documents: pass --json (this command prints the library for machines only)"
        ));
    }
    let report = collect(config)?;
    println!("{}", serde_json::to_string(&report)?);
    Ok(())
}

/// The rows, with the expected database states spelled as `status`.
fn collect(config: &Config) -> anyhow::Result<Report> {
    match db::open_for_read(&config.paths.db)? {
        db::ReadOutcome::Ready(conn) => {
            let library = &config.paths.library_dir;
            let docs_dir = &config.paths.docs_dir;
            let max_mb: u64 = config.ocr.max_file_mb;
            let max_bytes: u64 = max_mb.saturating_mul(1_000_000);
            let mut documents: Vec<Row> = Vec::new();
            let mut listed: Vec<String> = Vec::new();
            for doc in db::all(&conn)? {
                listed.push(doc.path.clone());
                // A stored `library_path` is only shown while it is still a plain path inside
                // the library; anything else is reported as "not filed", never as a path.
                let filed_as: Option<String> = db::library_path(&conn, &doc.hash)?
                    .filter(|rel| inside_library(library, &PathBuf::from(rel)));
                let rel = PathBuf::from(doc.path.clone());
                let bytes: Option<u64> = row_bytes(config, &rel);
                let pages: Option<u32> = row_pages(config, &rel);
                let skipped: Option<String> = if bytes.map(|n| n > max_bytes).unwrap_or(false) {
                    Some("over_limit".to_string())
                } else {
                    None
                };
                let dataless: bool = row_dataless(config, &rel);
                documents.push(Row {
                    path: doc.path,
                    title: doc.meta.title,
                    doc_type: doc.meta.doc_type,
                    date: doc.meta.date,
                    folder: doc.meta.folder,
                    owner: doc.meta.owner,
                    filed_as,
                    bytes,
                    pages,
                    skipped,
                    dataless,
                });
            }

            // Also list originals in `docs_dir` that are over the limit and have no row at all:
            // `classify` never saw them, so without this walk the over-limit pill could never
            // appear for them. Listed only: nothing about them is hashed, OCR'd or stored.
            let mut files: Vec<PathBuf> = Vec::new();
            find_doc_files(docs_dir, &mut files)?;
            files.sort();
            for path in &files {
                let rel: PathBuf = path.strip_prefix(docs_dir).unwrap().to_path_buf();
                let rel_string: String = rel.to_string_lossy().to_string();
                if listed.contains(&rel_string) {
                    continue;
                }
                let size: Option<u64> = row_bytes(config, &rel);
                if !size.is_some() || size.unwrap() <= max_bytes {
                    continue; // only over-limit files without a row join this listing
                }
                documents.push(Row {
                    path: rel_string,
                    title: None,
                    doc_type: "unsorted".to_string(),
                    date: None,
                    folder: None,
                    owner: None,
                    filed_as: None,
                    bytes: size,
                    pages: None,
                    skipped: Some("over_limit".to_string()),
                    dataless: row_dataless(config, &rel),
                });
            }
            documents.sort_by(|a, b| a.path.cmp(&b.path));
            Ok(Report {
                version: 1,
                max_file_mb: max_mb,
                status: Status::Ok,
                documents,
            })
        }
        db::ReadOutcome::NoDatabase { .. } => Ok(Report {
            version: 1,
            max_file_mb: config.ocr.max_file_mb,
            status: Status::NoDatabase,
            documents: Vec::new(),
        }),
        db::ReadOutcome::Outdated => Ok(Report {
            version: 1,
            max_file_mb: config.ocr.max_file_mb,
            status: Status::Outdated,
            documents: Vec::new(),
        }),
    }
}

/// The original's size for one row's path, only while the path is a plain name under `docs_dir`
/// and the file itself is a real file (a symlink or a tampered path gets `null`, not a path).
fn row_bytes(config: &Config, rel: &Path) -> Option<u64> {
    use std::os::unix::fs::MetadataExt;
    if !inside_library(&config.paths.docs_dir, rel) {
        return None;
    }
    match std::fs::symlink_metadata(config.paths.docs_dir.join(rel)) {
        Ok(meta) if meta.is_file() => Some(meta.size()),
        _ => None,
    }
}

/// The macOS `SF_DATALESS` bit (`0x4000_0000`) set in `st_flags` when a file's contents
/// live only in iCloud Drive. Pure so the rule is testable without an iCloud mount:
/// the OS refuses to create a dataless file in a test, so `dataless_uses_metadata_only`
/// below proves only the metadata-only half, and this bit logic is proven here. Shared with
/// `organize` (crate-internal), which must leave such originals out of its dry-run.
pub(crate) fn is_dataless(flags: u32) -> bool {
    flags & 0x4000_0000 != 0
}

/// `st_flags` from a `symlink_metadata` result. `st_flags()` is a method of
/// `std::os::macos::fs::MetadataExt`, so this is one body per OS: `#[cfg]` picks the
/// body at compile time (an `if cfg!(...)` would still have to compile the macOS call
/// on every platform). Off macOS there is no such flag: `false`, not a guess.
#[cfg(target_os = "macos")]
fn file_flags(meta: std::fs::Metadata) -> u32 {
    use std::os::macos::fs::MetadataExt;
    meta.st_flags()
}

#[cfg(not(target_os = "macos"))]
fn file_flags(_meta: std::fs::Metadata) -> u32 {
    0
}

/// Whether one row's original is a dataless (iCloud-only) file. Same trust rule as `row_bytes`:
/// only while the path is a plain name under `docs_dir`. `symlink_metadata` is a `stat`,
/// so the contents are never downloaded - checking must never defeat the point of checking.
fn row_dataless(config: &Config, rel: &Path) -> bool {
    if !inside_library(&config.paths.docs_dir, rel) {
        return false;
    }
    match std::fs::symlink_metadata(config.paths.docs_dir.join(rel)) {
        Ok(meta) if meta.is_file() => is_dataless(file_flags(meta)),
        _ => false,
    }
}

/// The pages of the document's OCR text, when the OCR file exists and the text carries page
/// markers. Counting only: the text is read to count, never printed.
fn row_pages(config: &Config, rel: &Path) -> Option<u32> {
    match add::ocr_output_path(config, rel) {
        None => None,
        Some(path) => match std::fs::read_to_string(&path) {
            Err(_) => None,
            Ok(text) => chunk::page_count(text.as_str()),
        },
    }
}

/// Every file under `dir` whose extension `ocr.py`/`add` accept, recursively. `file_type()`
/// does not follow symlinks, so a link to a folder is never walked (as `main::find_txt` does).
fn find_doc_files(dir: &Path, out: &mut Vec<PathBuf>) -> anyhow::Result<()> {
    if !dir.is_dir() {
        // A library with no `docs_dir` yet: nothing to walk, not an error.
        return Ok(());
    }
    let entries =
        std::fs::read_dir(dir).with_context(|| format!("cannot read {}", dir.display()))?;
    for entry in entries {
        let entry = entry?;
        let path: PathBuf = entry.path();
        if entry.file_type()?.is_dir() {
            find_doc_files(&path, out)?;
        } else if path.extension().is_some_and(|e| {
            let ext: String = e.to_string_lossy().to_lowercase();
            add::OCR_TYPES.contains(&ext.as_str())
        }) {
            out.push(path);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;

    use rusqlite::Connection;

    use super::*;

    // The config half of organize's fixture: a tempdir tree, network pointed at dead ports.
    fn config_in(dir: &Path) -> Config {
        let mut config = Config::default();
        config.paths.ocr_dir = dir.join("ocr");
        config.paths.docs_dir = dir.join("docs");
        config.paths.db = dir.join("data/documents.sqlite");
        config.paths.library_dir = dir.join("library");
        config
    }

    // Fixture lock shared with the TS tests and the fake engine: the serialized shape lives in
    // `testdata/desktop/<name>.json`. With LOCK_FIXTURES=1 the actual bytes are written to the
    // fixture, so a shape change is a deliberate, reviewable diff; otherwise a mismatch fails.
    fn lock(name: &str, actual: &str) {
        let path: PathBuf = PathBuf::from("testdata/desktop").join(name);
        if std::env::var("LOCK_FIXTURES")
            .map(|v| v == "1")
            .unwrap_or(false)
        {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, actual).unwrap();
            return;
        }
        let want: String = fs::read_to_string(&path)
            .expect("fixture missing: run the tests once with LOCK_FIXTURES=1");
        assert_eq!(
            actual,
            want.as_str(),
            "JSON shape changed (or the fixture is stale)"
        );
    }

    fn put_doc(conn: &Connection, hash: String, path: String, meta: db::Meta) {
        db::put(conn, &db::Doc { hash, path, meta }).unwrap();
    }

    #[test]
    fn json_lists_rows_read_only() {
        let dir = tempfile::tempdir().unwrap();
        let config = config_in(dir.path());
        let conn = db::open(&config.paths.db).unwrap();
        put_doc(
            &conn,
            "a1".into(),
            "home/car-loan-invoice.pdf".into(),
            db::Meta {
                title: Some("Invoice".into()),
                doc_type: "invoice".into(),
                date: Some("2025-03-14".into()),
                people: Vec::new(),
                issuer: None,
                folder: Some("Home".into()),
                owner: Some("Alex Example".into()),
                matter: Some("Car loan".into()),
            },
        );
        db::set_library_path(
            &conn,
            "a1",
            "Home/Alex Example/2025/2025-03-14 Car loan - Invoice.pdf",
        )
        .unwrap();
        put_doc(
            &conn,
            "b2".into(),
            "letters/letter.pdf".into(),
            db::Meta {
                title: Some("Letter".into()),
                doc_type: "letter".into(),
                date: None,
                people: Vec::new(),
                issuer: None,
                folder: None,
                owner: None,
                matter: None,
            },
        );
        // A tampered library_path must not reach the app as a path it could touch.
        db::set_library_path(&conn, "b2", "../outside.pdf").unwrap();

        let report = collect(&config).unwrap();
        let json: String = serde_json::to_string(&report).unwrap();
        assert!(json.contains("\"filed_as\":\"Home/Alex Example"), "{json}");
        assert!(
            json.contains("\"filed_as\":null"),
            "the tampered path became null"
        );
        // No original on disk: sizes are null, not guesses. (The shape with sizes is locked
        // by `json_has_sizes_pages_and_skipped` below, which locks `documents.json`.)
        assert!(json.contains("\"bytes\":null"), "{json}");
    }

    #[test]
    fn json_has_sizes_pages_and_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let mut config = config_in(dir.path());
        // A known-size original with a marked OCR file: 2 pages.
        fs::create_dir_all(&config.paths.docs_dir).unwrap();
        fs::create_dir_all(config.paths.docs_dir.join("scans")).unwrap();
        fs::create_dir_all(config.paths.ocr_dir.join("scans")).unwrap();
        let scan: PathBuf = config.paths.docs_dir.join("scans/scan.pdf");
        fs::write(&scan, "a scan").unwrap();
        let ocr_txt: PathBuf = config.paths.ocr_dir.join("scans/scan.pdf.text.txt");
        fs::write(&ocr_txt, "\x0CPage one line\nmore text\x0CPage two line").unwrap();
        fs::write(
            config.paths.ocr_dir.join("scans/scan.pdf.text.txt"),
            "\x0CPage one line\nmore text\x0CPage two line",
        )
        .unwrap();
        let conn = db::open(&config.paths.db).unwrap();
        put_doc(
            &conn,
            "a1".into(),
            "scans/scan.pdf".into(),
            db::Meta {
                title: Some("Scan".into()),
                doc_type: "invoice".into(),
                date: None,
                people: Vec::new(),
                issuer: None,
                folder: None,
                owner: None,
                matter: None,
            },
        );
        drop(conn);

        // An original over the limit with NO row at all: it must still show up, marked.
        let big = config.paths.docs_dir.join("big-scan.pdf");
        fs::write(&big, "x".repeat(51_000_000).as_bytes()).unwrap(); // over the 50 MB limit
        config.ocr.max_file_mb = 50;

        let report = collect(&config).unwrap();
        let json: String = serde_json::to_string(&report).unwrap();
        lock("documents.json", &json);
        let rows = json
            .as_str()
            .split("\"path\":")
            .filter(|s| s.starts_with("\"big-scan.pdf\""))
            .count();
        assert_eq!(
            rows, 1,
            "the over-limit file without a row is listed once: {json}"
        );
        assert!(json.contains("\"skipped\":\"over_limit\""), "{json}");
        assert!(
            json.contains("\"pages\":2"),
            "marked OCR text gives page count: {json}"
        );
        assert!(
            json.contains("\"bytes\":6"),
            "the known-size original reports its 6 bytes"
        );
        // The over-limit row: an unsorted listing with a size, no title, no filing.
        assert!(
            json.contains("\"big-scan.pdf\",\"title\":null,\"type\":\"unsorted\""),
            "{json}"
        );
        // Every row carries the dataless bit; on a normal disk (and in the locked fixture)
        // it is false.
        assert!(json.contains("\"dataless\":false"), "{json}");
    }

    #[test]
    fn tampered_path_has_no_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let config = config_in(dir.path());
        let conn = db::open(&config.paths.db).unwrap();
        // A row whose `path` itself tries to walk out of docs_dir: no bytes, no pages, no
        // crash - the path is data on disk, not trusted.
        put_doc(
            &conn,
            "b2".into(),
            "../outside.pdf".into(),
            db::Meta {
                title: None,
                doc_type: "unsorted".into(),
                date: None,
                people: Vec::new(),
                issuer: None,
                folder: None,
                owner: None,
                matter: None,
            },
        );
        let report = collect(&config).unwrap();
        let json: String = serde_json::to_string(&report).unwrap();
        assert!(
            json.contains("\"path\":\"../outside.pdf\""),
            "the path stays visible"
        );
        assert!(
            json.contains("\"bytes\":null"),
            "but it never becomes a size the app reads"
        );
    }

    #[test]
    fn dataless_bit() {
        // The SF_DATALESS bit alone, and mixed with other flags, is dataless; its neighbours
        // are not. (A test cannot ask macOS to make a real dataless file - the OS refuses -
        // so `documents --json` reporting iCloud-only originals is covered through this
        // pure rule plus `dataless_uses_metadata_only` below.)
        assert!(is_dataless(0x4000_0000));
        assert!(is_dataless(0x4000_8000));
        assert!(!is_dataless(0));
        assert!(!is_dataless(0x8000));
        assert!(!is_dataless(0x2000_0000));
        assert!(!is_dataless(0x8000_0000));
    }

    #[test]
    fn dataless_uses_metadata_only() {
        // The check never opens the file: a path with no file at all gives `false`, not an
        // error, and a tampered path never reaches the filesystem. `symlink_metadata` is a
        // `stat`, so a real dataless file could never be downloaded by this code either.
        let dir = tempfile::tempdir().unwrap();
        let config = config_in(dir.path());
        fs::create_dir_all(&config.paths.docs_dir).unwrap();
        let gone: PathBuf = PathBuf::from("gone.pdf");
        assert!(
            !row_dataless(&config, &gone),
            "a missing original is just not dataless"
        );
        let tampered: PathBuf = PathBuf::from("../outside.pdf");
        assert!(
            !row_dataless(&config, &tampered),
            "a tampered path is never statted"
        );
        // A real, ordinary file on this machine: metadata says not dataless.
        fs::write(config.paths.docs_dir.join("scan.pdf"), "bytes").unwrap();
        let real: PathBuf = PathBuf::from("scan.pdf");
        assert!(!row_dataless(&config, &real), "an ordinary local file");
    }

    #[test]
    fn without_database_creates_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let config = config_in(dir.path());
        let report = collect(&config).unwrap();
        let json: String = serde_json::to_string(&report).unwrap();
        lock("documents-no-database.json", &json);
        assert!(
            json.starts_with("{\"version\":1,\"max_file_mb\":50,\"status\":\"no_database\""),
            "{json}"
        );
        assert!(!fs::exists(&config.paths.db).unwrap_or(false));
        assert!(!fs::exists(config.paths.db.parent().unwrap()).unwrap_or(false));
        assert!(!fs::exists(config.paths.library_dir).unwrap_or(false));
    }

    #[test]
    fn outdated_database_is_data_not_a_write() {
        let dir = tempfile::tempdir().unwrap();
        let config = config_in(dir.path());
        fs::create_dir_all(config.paths.db.parent().unwrap()).unwrap();
        // The first-release schema: no owner/matter/library_path columns.
        let old = Connection::open(&config.paths.db).unwrap();
        old.execute(
            "CREATE TABLE documents (hash TEXT PRIMARY KEY, path TEXT NOT NULL, title TEXT,
                 type TEXT NOT NULL, date TEXT, people TEXT NOT NULL, issuer TEXT, folder TEXT)",
            [],
        )
        .unwrap();
        let before: Vec<u8> = fs::read(&config.paths.db).unwrap();

        let report = collect(&config).unwrap();
        let json: String = serde_json::to_string(&report).unwrap();
        lock("documents-outdated.json", &json);
        assert!(
            json.starts_with("{\"version\":1,\"max_file_mb\":50,\"status\":\"outdated\""),
            "{json}"
        );
        assert_eq!(
            fs::read(&config.paths.db).unwrap(),
            before,
            "the bytes are untouched"
        );
        let ro = db::open_read_only(&config.paths.db).unwrap();
        assert!(
            !db::is_current(&ro).unwrap(),
            "still predates the new columns"
        );
    }
}
