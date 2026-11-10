//! SQLite: one row per classified document, keyed by the SHA-256 of the original file.
//!
//! `rusqlite` is synchronous. The commands that use it run one step at a time, so a short
//! blocking query on the async runtime holds up nothing else.

use std::path::Path;

use anyhow::Context;
use rusqlite::{Connection, OpenFlags, OptionalExtension, Row, params};

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
    /// One of `[classify] owners`: whose document it is.
    pub owner: Option<String>,
    /// What the document concerns ("Car loan"): goes into the library file name.
    pub matter: Option<String>,
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
    folder TEXT,
    owner TEXT,
    matter TEXT,
    library_path TEXT -- where `organize --apply` filed the copy, relative to `library_dir`
)";

/// Columns added after the first release: `open` adds whichever an older database lacks.
const ADDED_COLUMNS: [&str; 3] = ["owner", "matter", "library_path"];

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
    let have: Vec<String> = columns(&conn)?;
    for col in ADDED_COLUMNS {
        if !have.iter().any(|c| c == col) {
            conn.execute(&format!("ALTER TABLE documents ADD COLUMN {col} TEXT"), [])?;
        }
    }
    Ok(conn)
}

fn columns(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT name FROM pragma_table_info('documents')")?;
    stmt.query_map([], |row| row.get(0))?.collect()
}

/// Whether the table has every column this version reads. A read-only reader (`organize
/// --dry-run`) cannot add them, so it asks for a write command first.
pub fn is_current(conn: &Connection) -> rusqlite::Result<bool> {
    let have: Vec<String> = columns(conn)?;
    Ok(ADDED_COLUMNS
        .iter()
        .all(|col| have.iter().any(|c| c == col)))
}

/// Opens an existing database without writing a thing: no parent folder, no file, no table, no
/// permission change. `organize --dry-run` needs to read the rows and must not touch the file, so
/// it uses this instead of `open` (which is a write command, and is free to set the file up).
pub fn open_read_only(path: &Path) -> anyhow::Result<Connection> {
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .with_context(|| format!("cannot read {}", path.display()))
}

/// Whether the `documents` table exists, so a reader can say "run `classify` first" instead of
/// failing on a missing table (and, unlike `open`, without creating it).
pub fn has_documents(conn: &Connection) -> rusqlite::Result<bool> {
    let rows: i64 = conn.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'documents'",
        [],
        count_row,
    )?;
    Ok(rows > 0)
}

/// One row of a `count(*)` query.
fn count_row(row: &Row) -> rusqlite::Result<i64> {
    row.get(0)
}

/// Inserts the document, or updates the row with the same hash (`classify --force`). An upsert,
/// not a replace: `library_path` belongs to `organize` and must survive a re-classify, or the next
/// `organize --apply` could not find (and move) the copy it filed before.
pub fn put(conn: &Connection, doc: &Doc) -> rusqlite::Result<()> {
    let m = &doc.meta;
    let people = serde_json::to_string(&m.people).expect("a list of strings always serializes");
    conn.execute(
        "INSERT INTO documents (hash, path, title, type, date, people, issuer, folder, owner, matter)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(hash) DO UPDATE SET path = excluded.path, title = excluded.title,
           type = excluded.type, date = excluded.date, people = excluded.people,
           issuer = excluded.issuer, folder = excluded.folder, owner = excluded.owner,
           matter = excluded.matter",
        params![
            doc.hash, doc.path, m.title, m.doc_type, m.date, people, m.issuer, m.folder, m.owner,
            m.matter
        ],
    )?;
    Ok(())
}

/// Where `organize --apply` last filed this document, relative to `library_dir`. Data on disk:
/// the caller re-checks it before touching the path.
pub fn library_path(conn: &Connection, hash: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT library_path FROM documents WHERE hash = ?1",
        [hash],
        |row| row.get(0),
    )
    .optional()
    .map(Option::flatten)
}

pub fn set_library_path(conn: &Connection, hash: &str, rel: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE documents SET library_path = ?2 WHERE hash = ?1",
        params![hash, rel],
    )?;
    Ok(())
}

const SELECT: &str =
    "SELECT hash, path, title, type, date, people, issuer, folder, owner, matter FROM documents";

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
            owner: row.get(8)?,
            matter: row.get(9)?,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_only_open_never_creates_anything() {
        let dir = tempfile::tempdir().unwrap();
        // The parent folder is missing too: a read-only open fails instead of building it out.
        let missing = dir.path().join("data/missing.sqlite");
        assert!(open_read_only(&missing).is_err());
        assert!(!std::fs::exists(missing.parent().unwrap()).unwrap_or(false));
        // An existing database is readable; `has_documents` reads the schema without adding one.
        open(&missing).unwrap();
        assert!(has_documents(&open_read_only(&missing).unwrap()).unwrap());
        // A bare database file with no table is "no documents", and still gets no table.
        let bare = Connection::open(dir.path().join("bare.sqlite")).unwrap();
        assert!(!has_documents(&bare).unwrap());
        assert!(!has_documents(&open_read_only(&dir.path().join("bare.sqlite")).unwrap()).unwrap());
    }

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
                owner: Some("Jan Kowalski".into()),
                matter: Some("Office chair".into()),
            },
        };
        put(&conn, &doc).unwrap();
        assert_eq!(get(&conn, "abc").unwrap(), Some(doc.clone()));
        assert_eq!(get(&conn, "nope").unwrap(), None);

        // A re-classify keeps where `organize` filed the copy.
        set_library_path(&conn, "abc", "Home/Jan Kowalski/2025/x.pdf").unwrap();
        doc.meta.doc_type = "unsorted".into();
        put(&conn, &doc).unwrap();
        assert_eq!(all(&conn).unwrap(), vec![doc]);
        assert_eq!(
            library_path(&conn, "abc").unwrap().as_deref(),
            Some("Home/Jan Kowalski/2025/x.pdf")
        );
        assert_eq!(library_path(&conn, "nope").unwrap(), None);
    }

    #[test]
    fn an_older_database_gets_the_new_columns() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("old.sqlite");
        let old = Connection::open(&path).unwrap();
        old.execute(
            "CREATE TABLE documents (hash TEXT PRIMARY KEY, path TEXT NOT NULL, title TEXT,
             type TEXT NOT NULL, date TEXT, people TEXT NOT NULL, issuer TEXT, folder TEXT)",
            [],
        )
        .unwrap();
        old.execute(
            "INSERT INTO documents VALUES ('h', 'a.pdf', 'T', 'bank', NULL, '[]', NULL, NULL)",
            [],
        )
        .unwrap();
        assert!(!is_current(&old).unwrap());
        drop(old);
        let conn = open(&path).unwrap();
        assert!(is_current(&conn).unwrap());
        let doc = get(&conn, "h").unwrap().unwrap();
        assert_eq!((doc.meta.owner, doc.meta.matter), (None, None));
    }
}
