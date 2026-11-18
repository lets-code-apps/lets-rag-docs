//! `lets-rag-docs locate --json -- <path>`: resolve ONE `documents --json` row's path to an
//! absolute file the desktop app may open - or say why it cannot.
//!
//! Read-only: this command never opens a thing, never reads the file, and the reported path
//! may not leave the library. Every input here is data on disk: the database rows, the stored
//! `library_path`, and the argument itself are hostile-shaped. A candidate is only reported
//! after TWO checks: `organize::inside_library` rejects `..` and absolute tricks textually,
//! and once the file exists, `canonicalize` + `starts_with` prove it is still under the
//! canonical root after symlinks are resolved (a link out of the library dies here).
//!
//! Expected states - found, no row, a row whose files are gone - are JSON with exit 0
//! (`status` says which); an unreadable database is a real error.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::config::Config;
use crate::db;
use crate::organize::inside_library;

#[derive(Serialize)]
struct Report {
    /// Wire format version: a consumer that speaks 1 refuses anything else.
    version: u8,
    status: Status,
    kind: Option<Kind>,
    path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum Status {
    Ok,
    NotFound,
    Missing,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum Kind {
    Filed,
    Original,
}

pub fn run(config: &Config, json: bool, path: &Path) -> anyhow::Result<()> {
    if !json {
        return Err(anyhow::anyhow!(
            "locate: pass --json (this command prints the answer for machines only)"
        ));
    }
    let report = collect(config, path)?;
    println!("{}", serde_json::to_string(&report)?);
    Ok(())
}

/// The answer as data. Prefers the copy `organize` filed, falls back to the original, and
/// never reports a path outside the library roots.
fn collect(config: &Config, arg: &Path) -> anyhow::Result<Report> {
    let docs_dir = &config.paths.docs_dir;
    let library = &config.paths.library_dir;
    let want: String = arg.to_string_lossy().to_string();

    match db::open_for_read(&config.paths.db)? {
        db::ReadOutcome::Ready(conn) => {
            let doc: Option<db::Doc> = db::all(&conn)?.into_iter().find(|doc| doc.path == want);
            if let Some(doc) = doc {
                // 1. The filed copy: the stored name must pass `inside_library` textually,
                // then exist and stay under the library once links are resolved.
                let filed_rel: Option<PathBuf> = db::library_path(&conn, &doc.hash)?
                    .map(PathBuf::from)
                    .filter(|rel| inside_library(library, rel));
                if let Some(rel) = filed_rel
                    && let Some(abs) = under_root(&library.join(&rel), library)
                {
                    return Ok(Report {
                        version: 1,
                        status: Status::Ok,
                        kind: Some(Kind::Filed),
                        path: Some(abs.to_string_lossy().to_string()),
                    });
                }
                // 2. ...else the original, under the same checks against docs_dir.
                if let Some(abs) = under_root(&docs_dir.join(&want), docs_dir) {
                    return Ok(Report {
                        version: 1,
                        status: Status::Ok,
                        kind: Some(Kind::Original),
                        path: Some(abs.to_string_lossy().to_string()),
                    });
                }
                // 3. A row whose copies are all gone (moved by hand, deleted): still not an
                //    error, just an honest `missing`: there is nothing to open.
                return Ok(Report {
                    version: 1,
                    status: Status::Missing,
                    kind: None,
                    path: None,
                });
            }
        }
        // No (current) database: the no-row path below is the whole answer.
        db::ReadOutcome::NoDatabase { .. } => {}
        db::ReadOutcome::Outdated => {}
    }

    // No row: only a plain path inside `docs_dir` is accepted (an over-limit original never
    // gets a row, but is still a real file the app may want to open), and it must exist.
    if let Some(abs) = under_root(&docs_dir.join(&want), docs_dir) {
        return Ok(Report {
            version: 1,
            status: Status::Ok,
            kind: Some(Kind::Original),
            path: Some(abs.to_string_lossy().to_string()),
        });
    }
    Ok(Report {
        version: 1,
        status: Status::NotFound,
        kind: None,
        path: None,
    })
}

/// The canonical absolute path for `path`, but only if it exists, is a real file, and stays
/// under the canonical `root` once every symlink is resolved. The textual `inside_library`
/// check ran first (so a raw `..` never even reaches the filesystem); this is the physical
/// proof. `canonicalize` resolves links; `metadata`/`is_file` never follows them.
fn under_root(path: &Path, root: &Path) -> Option<PathBuf> {
    let canonical: Option<PathBuf> = std::fs::canonicalize(path).ok();
    let canonical_root: Option<PathBuf> = std::fs::canonicalize(root).ok();
    match (canonical, canonical_root) {
        (Some(p), Some(r)) if p.is_file() && p != r && p.starts_with(&r) => Some(p),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::os::unix::fs::symlink;
    use std::path::Path;
    use std::path::PathBuf;

    use rusqlite::Connection;

    use super::*;

    fn config_in(dir: &Path) -> Config {
        let mut config = Config::default();
        config.paths.ocr_dir = dir.join("ocr");
        config.paths.docs_dir = dir.join("docs");
        config.paths.db = dir.join("data/documents.sqlite");
        config.paths.library_dir = dir.join("library");
        config
    }

    // Fixture lock shared with the TS tests and the fake engine (see documents.rs). `locate.json`
    // contains a tempdir path, so it is locked with that folder redacted to keep it stable.
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
        let want: String = fs::read_to_string(&path).unwrap();
        assert_eq!(
            actual,
            want.as_str(),
            "JSON shape changed (or the fixture is stale)"
        );
    }

    // A row plus the (optional) stored library_path.
    fn put_doc(conn: &Connection, hash: &str, path: &str, filed_as: Option<&str>) {
        db::put(
            conn,
            &db::Doc {
                hash: hash.to_string(),
                path: path.to_string(),
                meta: db::Meta {
                    title: None,
                    doc_type: "invoice".into(),
                    date: None,
                    people: Vec::new(),
                    issuer: None,
                    folder: None,
                    owner: None,
                    matter: None,
                },
            },
        )
        .unwrap();
        if let Some(rel) = filed_as {
            db::set_library_path(conn, hash, rel).unwrap();
        }
    }

    #[test]
    fn filed_copy_preferred() {
        let dir = tempfile::tempdir().unwrap();
        let config = config_in(dir.path());
        let conn = db::open(&config.paths.db).unwrap();
        put_doc(
            &conn,
            "a1",
            "scans/scan.pdf",
            Some("Home/Alex Example/2025/scan.pdf"),
        );
        drop(conn);
        fs::create_dir_all(config.paths.docs_dir.join("scans")).unwrap();
        fs::write(config.paths.docs_dir.join("scans/scan.pdf"), "x").unwrap();
        fs::create_dir_all(config.paths.library_dir.join("Home/Alex Example/2025")).unwrap();
        fs::write(
            config
                .paths
                .library_dir
                .join("Home/Alex Example/2025/scan.pdf"),
            "x",
        )
        .unwrap();

        let report = collect(&config, &PathBuf::from("scans/scan.pdf")).unwrap();
        let json: String = serde_json::to_string(&report).unwrap();
        let tmp: String = dir.path().to_string_lossy().to_string();
        let redacted: String = json.replace(&tmp[..], "TMP");
        lock("locate.json", &redacted);
        // Both files exist: the answer is the FILED copy, absolute, inside the library.
        assert!(json.contains("\"status\":\"ok\""), "{json}");
        assert!(json.contains("\"kind\":\"filed\""), "{json}");
        let lib: String = config.paths.library_dir.to_string_lossy().to_string();
        assert!(
            json.contains(&lib[..]),
            "the path is under the library: {json}"
        );
    }

    #[test]
    fn original_fallback_when_filing_gone_or_tampered() {
        let dir = tempfile::tempdir().unwrap();
        let config = config_in(dir.path());
        let conn = db::open(&config.paths.db).unwrap();
        // The stored library_path walks out of the library: `inside_library` rejects it, so
        // the original is used instead - the tampered path never reaches the answer.
        put_doc(&conn, "b2", "letters/letter.pdf", Some("../outside.pdf"));
        drop(conn);
        fs::create_dir_all(config.paths.docs_dir.join("letters")).unwrap();
        fs::write(config.paths.docs_dir.join("letters/letter.pdf"), "x").unwrap();

        let report = collect(&config, &PathBuf::from("letters/letter.pdf")).unwrap();
        let json: String = serde_json::to_string(&report).unwrap();
        assert!(json.contains("\"kind\":\"original\""), "{json}");
        assert!(!json.contains("outside.pdf"), "{json}");
    }

    #[test]
    fn symlink_out_of_the_library_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let config = config_in(dir.path());
        let conn = db::open(&config.paths.db).unwrap();
        put_doc(&conn, "c3", "scans/scan.pdf", Some("Home/scan.pdf"));
        drop(conn);
        // The filed name exists but is a link to a file OUTSIDE the library: the canonical
        // check refuses it, and with no original on disk the honest answer is `missing`.
        fs::create_dir_all(config.paths.library_dir.join("Home")).unwrap();
        fs::create_dir_all(&config.paths.docs_dir).unwrap();
        let outside: PathBuf = dir.path().join("smuggled.pdf");
        fs::write(&outside, "secret").unwrap();
        symlink(&outside, config.paths.library_dir.join("Home/scan.pdf")).unwrap();

        let report = collect(&config, &PathBuf::from("scans/scan.pdf")).unwrap();
        let json: String = serde_json::to_string(&report).unwrap();
        assert!(json.contains("\"status\":\"missing\""), "{json}");
        assert!(!json.contains("smuggled.pdf"), "{json}");
        assert!(!json.contains("secret"), "{json}");
    }

    #[test]
    fn deleted_files_are_missing_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let config = config_in(dir.path());
        let conn = db::open(&config.paths.db).unwrap();
        put_doc(&conn, "d4", "scans/scan.pdf", Some("Home/2025/scan.pdf"));
        drop(conn);
        // Row exists but neither copy does: `missing` (there IS such a document), distinct
        // from `not_found` (no such document at all). Path null: there is nothing to open.
        let report = collect(&config, &PathBuf::from("scans/scan.pdf")).unwrap();
        let json: String = serde_json::to_string(&report).unwrap();
        lock("locate-missing.json", &json);
        assert_eq!(
            json,
            "{\"version\":1,\"status\":\"missing\",\"kind\":null,\"path\":null}"
        );
    }

    #[test]
    fn unknown_and_traversal_paths_are_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let config = config_in(dir.path());
        // No database at all: still no crash, just `not_found`.
        for arg in ["../x.pdf", "x.pdf", "/etc/passwd", "scans/../../etc/secret"] {
            let report = collect(&config, &PathBuf::from(arg)).unwrap();
            let json: String = serde_json::to_string(&report).unwrap();
            assert_eq!(
                json, "{\"version\":1,\"status\":\"not_found\",\"kind\":null,\"path\":null}",
                "{arg}",
            );
        }
        // Over-limit originals (no row) live inside docs_dir and are accepted.
        fs::create_dir_all(&config.paths.docs_dir).unwrap();
        fs::write(config.paths.docs_dir.join("big-scan.pdf"), "x").unwrap();
        let report = collect(&config, &PathBuf::from("big-scan.pdf")).unwrap();
        let json: String = serde_json::to_string(&report).unwrap();
        assert!(json.contains("\"status\":\"ok\""), "{json}");
        assert!(json.contains("\"kind\":\"original\""), "{json}");
    }
}
