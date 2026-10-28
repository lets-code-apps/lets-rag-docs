//! SQLite: one row per classified document, keyed by the SHA-256 of the original file.
//!
//! `rusqlite` is synchronous. The commands that use it run one step at a time, so a short
//! blocking query on the async runtime holds up nothing else.

use std::path::Path;

use anyhow::Context;
use rusqlite::{Connection, OptionalExtension, Row, params};

/// What `classify` found out about a document, already validated.
#[derive(Debug, Clone, PartialEq)]
pub struct Meta {
    pub title: Option<String>,
    /// One of `[classify] types`, or `unsorted`.
    pub doc_type: String,
    /// `YYYY-MM-DD`, a real calendar date.
    pub date: Option<String>,
    pub people: Vec<String>,
    pub issuer: Option<String>,
    /// A single safe path segment (see `classify::safe_folder`).
    pub folder: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Doc {
    pub hash: String,
    /// The original's path relative to `[paths] docs_dir`.
    pub path: String,
    pub meta: Meta,
}

const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS documents (
    hash TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    title TEXT,
    type TEXT NOT NULL,
    date TEXT,
    people TEXT NOT NULL, -- JSON array of strings
    issuer TEXT,
    folder TEXT
)";

/// Opens (or creates) the database and its table.
pub fn open(path: &Path) -> anyhow::Result<Connection> {
    if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir).with_context(|| format!("cannot create {}", dir.display()))?;
    }
    let conn = Connection::open(path).with_context(|| format!("cannot open {}", path.display()))?;
    // It holds names and titles from private documents: owner-only, as in lets-triage-mail.
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .with_context(|| format!("cannot restrict {}", path.display()))?;
    }
    conn.execute(SCHEMA, [])?;
    Ok(conn)
}

/// Inserts the document, or replaces the row with the same hash (`classify --force`).
pub fn put(conn: &Connection, doc: &Doc) -> rusqlite::Result<()> {
    let m = &doc.meta;
    let people = serde_json::to_string(&m.people).expect("a list of strings always serializes");
    conn.execute(
        "INSERT OR REPLACE INTO documents (hash, path, title, type, date, people, issuer, folder)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            doc.hash, doc.path, m.title, m.doc_type, m.date, people, m.issuer, m.folder
        ],
    )?;
    Ok(())
}

const SELECT: &str = "SELECT hash, path, title, type, date, people, issuer, folder FROM documents";

pub fn get(conn: &Connection, hash: &str) -> rusqlite::Result<Option<Doc>> {
    conn.query_row(&format!("{SELECT} WHERE hash = ?1"), [hash], from_row)
        .optional()
}

/// Every document, ordered by path.
pub fn all(conn: &Connection) -> rusqlite::Result<Vec<Doc>> {
    let mut stmt = conn.prepare(&format!("{SELECT} ORDER BY path"))?;
    stmt.query_map([], from_row)?.collect()
}

fn from_row(row: &Row) -> rusqlite::Result<Doc> {
    let people: String = row.get(5)?;
    Ok(Doc {
        hash: row.get(0)?,
        path: row.get(1)?,
        meta: Meta {
            title: row.get(2)?,
            doc_type: row.get(3)?,
            date: row.get(4)?,
            people: serde_json::from_str(&people).unwrap_or_default(),
            issuer: row.get(6)?,
            folder: row.get(7)?,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_replace() {
        let dir = tempfile::tempdir().unwrap();
        // A missing parent folder is created.
        let db_path = dir.path().join("sub/test.sqlite");
        let conn = open(&db_path).unwrap();
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&db_path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        let mut doc = Doc {
            hash: "abc".into(),
            path: "home/invoice.pdf".into(),
            meta: Meta {
                title: Some("Invoice 1".into()),
                doc_type: "invoice".into(),
                date: Some("2025-03-14".into()),
                people: vec!["Jan Kowalski".into(), "Ольга".into()],
                issuer: None,
                folder: Some("Home".into()),
            },
        };
        put(&conn, &doc).unwrap();
        assert_eq!(get(&conn, "abc").unwrap(), Some(doc.clone()));
        assert_eq!(get(&conn, "nope").unwrap(), None);

        doc.meta.doc_type = "unsorted".into();
        put(&conn, &doc).unwrap();
        assert_eq!(all(&conn).unwrap(), vec![doc]);
    }
}
