//! `lets-rag-docs documents --json`: the classified library as one JSON object.
//!
//! Read-only and hostile-data-safe: the database is opened through `db::open_for_read`, so a
//! missing database or an old schema is reported as data (exit 0, `status` says which), never
//! as a crash and never as a write. Output is the SQLite rows only - names and paths, never
//! document text - and every consumer writes it as text, not as markup.

use std::path::PathBuf;

use serde::Serialize;

use crate::config::Config;
use crate::db;
use crate::organize::inside_library;

#[derive(Serialize)]
struct Report {
    /// Wire format version: a consumer that speaks 1 refuses anything else.
    version: u8,
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
            let mut documents: Vec<Row> = Vec::new();
            for doc in db::all(&conn)? {
                // A stored `library_path` is only shown while it is still a plain path inside
                // the library; anything else is reported as "not filed", never as a path.
                let filed_as: Option<String> = db::library_path(&conn, &doc.hash)?
                    .filter(|rel| inside_library(library, &PathBuf::from(rel)));
                documents.push(Row {
                    path: doc.path,
                    title: doc.meta.title,
                    doc_type: doc.meta.doc_type,
                    date: doc.meta.date,
                    folder: doc.meta.folder,
                    owner: doc.meta.owner,
                    filed_as,
                });
            }
            Ok(Report {
                version: 1,
                status: Status::Ok,
                documents,
            })
        }
        db::ReadOutcome::NoDatabase { .. } => Ok(Report {
            version: 1,
            status: Status::NoDatabase,
            documents: Vec::new(),
        }),
        db::ReadOutcome::Outdated => Ok(Report {
            version: 1,
            status: Status::Outdated,
            documents: Vec::new(),
        }),
    }
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
        lock("documents.json", &json);
        assert!(json.contains("\"filed_as\":\"Home/Alex Example"), "{json}");
        assert!(
            json.contains("\"filed_as\":null"),
            "the tampered path became null"
        );
    }

    #[test]
    fn without_database_creates_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let config = config_in(dir.path());
        let report = collect(&config).unwrap();
        let json: String = serde_json::to_string(&report).unwrap();
        lock("documents-no-database.json", &json);
        assert!(
            json.starts_with("{\"version\":1,\"status\":\"no_database\""),
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
            json.starts_with("{\"version\":1,\"status\":\"outdated\""),
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
