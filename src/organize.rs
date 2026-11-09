//! `lets-rag-docs organize`: copy each classified original into a tidy `library/<folder>/<title>`
//! and re-index the copy under its new source. `--dry-run` prints the plan and changes nothing;
//! `--apply` copies (never moves or renames the originals) and re-embeds the copies.
//!
//! The library path is built from segments that are validated or sanitised by construction
//! (`classify::safe_folder`, `safe_title`, `safe_ext`), never from raw model text: a document can
//! steer the model into a `folder` or `title` like `../../etc`, and that must never escape
//! `library_dir`. Nothing here deletes or moves an original; the only writes are new copies under
//! the library and new points in the collection.

use std::collections::{HashMap, HashSet};
use std::fs::OpenOptions;
use std::io;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Component, Path, PathBuf};

use anyhow::{Context, anyhow};
use rusqlite::Connection;

use crate::chunk;
use crate::classify;
use crate::config::Config;
use crate::db;
use crate::embed::EmbedClient;
use crate::index;
use qdrant_client::Qdrant;

/// A title becomes at most this many characters (then at most 200 bytes on disk).
const TITLE_CAP: usize = 80;
const TITLE_BYTES: usize = 200;
/// Collision suffixes `name`, `name (2)`, ... before giving up on a document.
const COLLISION_CAP: usize = 1000;

#[derive(Debug, Clone, PartialEq)]
pub enum Mode {
    DryRun,
    Apply,
}

struct Entry {
    ocr_rel: String,
    ocr_abs: PathBuf,
    original: PathBuf,
    hash: String,
    folder: String,
    stem: String,
    /// `folder/stem.ext`, relative to the library; checked by `inside_library` before a write.
    rel: PathBuf,
    target: PathBuf,
    meta: db::Meta,
    already: bool,
    duplicates: Vec<String>,
}

#[derive(Clone)]
struct Counts {
    copied: usize,
    already: usize,
    failed: usize,
    duplicate: usize,
    not_classified: usize,
    missing: usize,
}

struct Built {
    entries: Vec<Entry>,
    counts: Counts,
    lines: Vec<String>,
}

pub async fn run(config: &Config, dry_run: bool, apply: bool) -> anyhow::Result<()> {
    let mode =
        parse_mode(dry_run, apply).ok_or(anyhow!("pass exactly one of --dry-run or --apply"))?;
    check_library_separation(config)?;

    if !std::fs::exists(&config.paths.db).unwrap_or(false) {
        // `db::open` would create an empty database; dry-run must change nothing, so bail first.
        println!(
            "run `classify` first: no database at {}",
            config.paths.db.display()
        );
        return Ok(());
    }
    let conn = db::open(&config.paths.db)?;
    let plan = build_plan(config, &conn)?;
    for line in plan.lines {
        println!("{}", line);
    }

    if mode == Mode::DryRun {
        println!("{}", counts_line(&plan.counts));
        return Ok(());
    }

    // Only `--apply` opens the embed service and Qdrant.
    let embed = EmbedClient::new(&config.embed.url);
    let qdrant = index::connect(&config.qdrant.url)?;
    let mut counts = plan.counts.clone();
    for entry in plan.entries {
        if !apply_entry(config, &embed, Some(&qdrant), entry).await? {
            counts.failed += 1;
        }
    }
    println!("{}", counts_line(&counts));
    Ok(())
}

pub fn parse_mode(dry_run: bool, apply: bool) -> Option<Mode> {
    if dry_run && !apply {
        Some(Mode::DryRun)
    } else if apply && !dry_run {
        Some(Mode::Apply)
    } else {
        None
    }
}

/// The library must be a place of its own: if it is inside (or contains) `docs_dir` or `ocr_dir`, a
/// filed copy could later be OCR'd or classified as a new original. Refuse rather than risk that.
fn check_library_separation(config: &Config) -> anyhow::Result<()> {
    let lib = std::path::absolute(&config.paths.library_dir)?;
    let others = [
        ("docs_dir", &config.paths.docs_dir),
        ("ocr_dir", &config.paths.ocr_dir),
    ];
    for (name, other) in others {
        let abs = std::path::absolute(other)?;
        if lib.starts_with(&abs) || abs.starts_with(&lib) {
            return Err(anyhow!(
                "`library_dir` must not contain or be contained by {}: a copy could be OCR'd or classified as a new original",
                name,
            ));
        }
    }
    Ok(())
}

/// Walks the OCR files exactly as `classify::run` does and turns each classified, non-duplicate
/// document into an entry with a collision-resolved target.
fn build_plan(config: &Config, conn: &Connection) -> anyhow::Result<Built> {
    let ocr_dir = &config.paths.ocr_dir;
    let docs_dir = &config.paths.docs_dir;
    let library = &config.paths.library_dir;

    let mut files: Vec<PathBuf> = Vec::new();
    crate::find_txt(ocr_dir, &mut files)?;
    files.sort();

    let mut entries: Vec<Entry> = Vec::new();
    let mut counts = Counts {
        copied: 0,
        already: 0,
        failed: 0,
        duplicate: 0,
        not_classified: 0,
        missing: 0,
    };
    let mut lines: Vec<String> = Vec::new();
    // Case-folded key so macOS's case-insensitive filesystem and a shared stem both collide.
    let mut claimed: HashSet<String> = HashSet::new();
    let mut first_by_hash: HashMap<String, String> = HashMap::new();
    let mut entry_by_hash: HashMap<String, usize> = HashMap::new();

    for path in files {
        let rel: String = path.strip_prefix(ocr_dir)?.to_string_lossy().to_string();
        let original = classify::original_path(docs_dir, &rel);
        let orel = classify::original_rel(&rel);
        let hash = match classify::hash_file(&original) {
            Ok(hash) => hash,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                lines.push(format!("missing original  {rel}"));
                counts.missing += 1;
                continue;
            }
            Err(e) => {
                tracing::warn!("cannot hash the original of {rel}: {e}");
                counts.failed += 1;
                continue;
            }
        };
        let doc = db::get(conn, &hash)?;
        let meta = match doc {
            Some(doc) => doc.meta,
            // No row: `classify` has not seen it. Copies are never deleted, so a forgotten `classify`
            // would leave stale copies behind: skip rather than file it under `unsorted`.
            None => {
                counts.not_classified += 1;
                continue;
            }
        };

        if let Some(first) = first_by_hash.get(&hash) {
            // Same bytes already planned from another OCR path: one document, no second copy.
            lines.push(format!("duplicate of {first}  {rel}"));
            counts.duplicate += 1;
            if let Some(idx) = entry_by_hash.get(&hash) {
                entries[*idx].duplicates.push(rel);
            }
            continue;
        }
        first_by_hash.insert(hash.clone(), rel.clone());

        // Re-validate the folder from the database: the row is data on disk, not trusted.
        let folder: String = match &meta.folder {
            Some(f) if classify::safe_folder(f) => f.clone(),
            _ => classify::UNSORTED.to_string(),
        };
        let name = safe_title(meta.title.as_ref(), hash.to_string());
        let ext = safe_ext(&original);
        let ext_suffix: String = match ext.as_ref() {
            Some(e) => format!(".{e}"),
            None => String::new(),
        };

        let (stem, target, already, ok) =
            resolve_target(library, &folder, &name, &ext_suffix, &hash, &claimed);
        if !ok {
            counts.failed += 1;
            continue;
        }
        claimed.insert(target_key(&folder, &stem).to_lowercase());
        let rel_path: PathBuf = PathBuf::from(format!("{folder}/{stem}{ext_suffix}"));

        if already {
            lines.push(format!(
                "already there  {orel} -> {folder}/{stem}{ext_suffix}"
            ));
            counts.already += 1;
        } else {
            lines.push(format!("copy  {orel} -> {folder}/{stem}{ext_suffix}"));
            counts.copied += 1;
        }
        entry_by_hash.insert(hash.clone(), entries.len());
        entries.push(Entry {
            ocr_rel: rel,
            ocr_abs: path.to_path_buf(),
            original,
            hash,
            folder,
            stem,
            rel: rel_path,
            target,
            meta,
            already,
            duplicates: Vec::new(),
        });
    }
    Ok(Built {
        entries,
        counts,
        lines,
    })
}

/// Picks a free name for one document. An earlier entry with the same key, or a different file at
/// the path, forces the next suffix; a file with the *same* hash means "already there" (idempotent).
fn resolve_target(
    library: &Path,
    folder: &str,
    name: &str,
    ext_suffix: &str,
    hash: &str,
    claimed: &HashSet<String>,
) -> (String, PathBuf, bool, bool) {
    for n in 1..=COLLISION_CAP {
        let stem: String = if n == 1 {
            name.to_string()
        } else {
            format!("{name} ({n})")
        };
        let key: String = target_key(folder, &stem).to_lowercase();
        if claimed.contains(&key) {
            continue;
        }
        let candidate: PathBuf = PathBuf::from(format!(
            "{lib}/{folder}/{stem}{ext_suffix}",
            lib = library.display()
        ));
        match classify::hash_file(&candidate) {
            // A file is there: same bytes => reuse it; different bytes => this name is taken.
            Ok(seen) if seen == hash => return (stem, candidate, true, true),
            Ok(_) => continue,
            // Nothing there (NotFound or the folder missing) => copy here.
            Err(e) if e.kind() == io::ErrorKind::NotFound => return (stem, candidate, false, true),
            Err(_) => continue,
        }
    }
    // No free name within the cap: give up on this document rather than write somewhere else.
    (String::new(), PathBuf::new(), false, false)
}

fn target_key(folder: &str, stem: &str) -> String {
    format!("{folder}/{stem}")
}

/// Does one planned entry: create the folder (refusing a symlink), copy the bytes owner-only, then
/// embed and re-index. Embed and Qdrant errors abort the whole run (the service is down, so continuing
/// is pointless); a per-file copy or folder error is just counted and the run moves on. The `Option`
/// `qdrant` is a seam: tests without a Qdrant pass `None` and still exercise the copy and embed.
async fn apply_entry(
    config: &Config,
    embed: &EmbedClient,
    qdrant: Option<&Qdrant>,
    entry: Entry,
) -> anyhow::Result<bool> {
    debug_assert!(inside_library(&config.paths.library_dir, &entry.rel));
    if !ensure_folder(&config.paths.library_dir, &entry.folder) {
        tracing::warn!(
            "refusing to write into a non-directory or symlinked folder {}",
            entry.folder
        );
        return Ok(false);
    }
    if !entry.already && !copy_file(&entry.original, &entry.target, &entry.hash) {
        return Ok(false);
    }

    // Embed before deleting (as `ingest` does): a failure here leaves the old index untouched.
    let text = std::fs::read_to_string(&entry.ocr_abs)
        .with_context(|| format!("cannot read {}", entry.ocr_abs.display()))?;
    let source = format!("{}/{}", entry.folder, entry.stem);
    let parts = chunk::chunks(&text);
    let inputs: Vec<String> = parts.iter().map(|c| format!("{source}\n{c}")).collect();
    let embeddings = embed.embed(&inputs).await?;

    let points: Vec<qdrant_client::qdrant::PointStruct> = parts
        .into_iter()
        .zip(embeddings)
        .enumerate()
        .map(|(n, (part, embedding))| {
            index::point(
                index::organized_id(&entry.hash, n),
                part,
                &source,
                &entry.ocr_rel,
                n,
                embedding,
                Some(&entry.meta),
            )
        })
        .collect();

    if let Some(client) = qdrant {
        index::delete_file(client, &config.qdrant.collection, &entry.ocr_rel).await?;
        for dup in entry.duplicates {
            index::delete_file(client, &config.qdrant.collection, dup.as_str()).await?;
        }
        index::upsert(client, &config.qdrant.collection, points).await?;
    }
    Ok(true)
}

/// Copies the original to `target` owner-only and atomically "create only if absent", then verifies
/// the copy's bytes match. The only file it may remove is a partial copy it just created.
fn copy_file(original: &Path, target: &Path, hash: &str) -> bool {
    let bytes_res = std::fs::read(original);
    if bytes_res.is_err() {
        tracing::warn!("cannot read the original {}", original.display());
        return false;
    }
    let bytes = bytes_res.unwrap();
    let opened = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(target);
    if opened.is_err() {
        // A file we did not create is there, or the create failed: reuse only if the bytes match.
        return match classify::hash_file(target) {
            Ok(h) => h == hash,
            _ => false,
        };
    }
    let mut dst = opened.unwrap();
    if dst.write_all(&bytes).is_err() {
        // A partial copy we just made: remove it and let the caller count the document as failed.
        if std::fs::remove_file(target).is_err() {
            tracing::warn!("could not remove the partial copy {}", target.display());
        }
        return false;
    }
    match classify::hash_file(target) {
        Ok(h) if h == hash => true,
        _ => {
            if std::fs::remove_file(target).is_err() {
                tracing::warn!("could not remove the partial copy {}", target.display());
            }
            false
        }
    }
}

/// Creates `<library>/<folder>` but refuses if it is not a real directory: a planted symlink must not
/// redirect writes outside the library.
fn ensure_folder(library: &Path, folder: &str) -> bool {
    let dir: PathBuf = PathBuf::from(format!("{lib}/{folder}", lib = library.display()));
    if std::fs::create_dir_all(&dir).is_err() {
        return false;
    }
    match std::fs::symlink_metadata(&dir) {
        // `symlink_metadata` does not follow links, so a symlink reports as a symlink, not a directory.
        Ok(st) => st.is_dir() && !st.is_symlink(),
        Err(_) => false,
    }
}

fn counts_line(c: &Counts) -> String {
    format!(
        "organized {}: {} copied, {} already there, {} failed, {} duplicate, {} not classified, {} missing original",
        c.copied + c.already,
        c.copied,
        c.already,
        c.failed,
        c.duplicate,
        c.not_classified,
        c.missing,
    )
}

/// A `title` becomes a safe file stem, or a hash-derived name when there is nothing usable.
fn safe_title(title: Option<&String>, hash: String) -> String {
    let cleaned: String = title
        .map(|t| sanitise(t.to_string()))
        .filter(|s| !s.is_empty())
        .unwrap_or_default();
    if !cleaned.is_empty() {
        return cleaned;
    }
    if hash.len() >= 12 {
        format!("doc-{short}", short = &hash[..12])
    } else {
        format!("doc-{short}", short = hash)
    }
}

/// Keeps letters (any script), digits, space, `-` and `_`; every other character (`/`, `\`, `.`,
/// control, RTL override, NUL) becomes `-`. Then collapses runs, trims, caps to 80 chars and 200 bytes.
fn sanitise(s: String) -> String {
    let mut mapped: Vec<char> = Vec::new();
    for c in s.chars() {
        if c.is_alphanumeric() || matches!(c, ' ' | '-' | '_') {
            mapped.push(c);
        } else {
            mapped.push('-');
        }
    }

    // Collapse runs of whitespace to one space, then runs of '-' to one '-', tracking the last kept
    // character so the pass stays linear.
    let mut collapsed: Vec<char> = Vec::new();
    let mut prev: Option<char> = None;
    for c in mapped {
        if (c == ' ' && prev == Some(' ')) || (c == '-' && prev == Some('-')) {
            continue;
        }
        collapsed.push(c);
        prev = Some(c);
    }

    // Trim leading and trailing ' ', '-' and '_'.
    let drop = |c: char| matches!(c, ' ' | '-' | '_');
    let mut a = 0;
    while a < collapsed.len() && drop(collapsed[a]) {
        a += 1;
    }
    let mut b = collapsed.len();
    while b > a && drop(collapsed[b - 1]) {
        b -= 1;
    }
    let trimmed: String = collapsed[a..b].iter().copied().collect();

    // Cap at 80 characters, then at 200 bytes on a character boundary.
    let capped: String = trimmed.chars().take(TITLE_CAP).collect();
    truncate_bytes(capped, TITLE_BYTES)
}

/// Cut on a character boundary: slicing a `String` at a byte that lands mid-char panics.
fn truncate_bytes(s: String, limit: usize) -> String {
    let mut total = 0;
    let mut end = 0;
    for (idx, c) in s.char_indices() {
        if total + c.len_utf8() > limit {
            break;
        }
        total += c.len_utf8();
        end = idx + c.len_utf8();
    }
    s[..end].to_string()
}

/// The original's last extension, lowercased, only if it is 1..8 ASCII alphanumerics; else none.
/// No dots means `..` and hidden files are impossible from the extension.
fn safe_ext(original: &Path) -> Option<String> {
    let ext = original.extension()?;
    let lower: String = ext.to_string_lossy().to_lowercase();
    if !lower.is_empty() && lower.len() <= 8 && lower.chars().all(|c| c.is_ascii_alphanumeric()) {
        Some(lower)
    } else {
        None
    }
}

/// Belt and braces before every write: every component of `rel` is a plain name, and the joined
/// path is still under `library`.
fn inside_library(library: &Path, rel: &Path) -> bool {
    let all_normal: bool = rel.components().all(|c| matches!(c, Component::Normal(_)));
    all_normal && library.join(rel).starts_with(library)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::classify;

    // A synthetic workspace: separate `docs/`, `data/ocr/` and `library/` trees and a config
    // pointing the network at dead ports. Nothing here is a real document; every byte is made up.
    struct Fixture {
        dir: tempfile::TempDir,
        config: Config,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("ocr")).unwrap();
        fs::create_dir_all(root.join("docs")).unwrap();
        let mut config = Config::default();
        config.paths.ocr_dir = root.join("ocr");
        config.paths.docs_dir = root.join("docs");
        config.paths.db = root.join("data/documents.sqlite");
        config.paths.library_dir = root.join("library");
        config.embed.url = "http://127.0.0.1:1".to_string();
        config.qdrant.url = "http://127.0.0.1:1".to_string();
        Fixture { dir, config }
    }

    fn open(f: &Fixture) -> Connection {
        db::open(&f.config.paths.db).unwrap()
    }

    // Writes one classified document: original bytes under docs_dir, OCR text under ocr_dir, and a
    // database row keyed by the original's content hash.
    fn add_doc(
        f: &Fixture,
        conn: &Connection,
        ocr_rel: &str,
        content: &str,
        title: Option<&str>,
        folder: Option<&str>,
    ) {
        let original_rel = classify::original_rel(ocr_rel);
        let original = f.config.paths.docs_dir.join(original_rel);
        fs::create_dir_all(original.parent().unwrap()).unwrap();
        fs::write(&original, content).unwrap();
        let ocr = f.config.paths.ocr_dir.join(ocr_rel);
        fs::create_dir_all(ocr.parent().unwrap()).unwrap();
        fs::write(&ocr, "hello world synthetic document text").unwrap();
        let hash = classify::hash_file(&original).unwrap();
        let meta = db::Meta {
            title: title.map(|s| s.to_string()),
            doc_type: "invoice".to_string(),
            date: None,
            people: Vec::new(),
            issuer: None,
            folder: folder.map(|s| s.to_string()),
        };
        db::put(
            conn,
            &db::Doc {
                hash,
                path: original_rel.to_string(),
                meta,
            },
        )
        .unwrap();
    }

    #[test]
    fn plan_lists_copies_and_counts() {
        let f = fixture();
        let conn = open(&f);
        add_doc(
            &f,
            &conn,
            "one.pdf.vision.txt",
            "abc",
            Some("Report"),
            Some("Home"),
        );
        assert!(fs::exists(f.dir.path()).unwrap_or(false));
        let plan = build_plan(&f.config, &conn).unwrap();
        assert!(plan.entries.len() == 1);
        let e = plan.entries.first().unwrap();
        assert_eq!(e.folder, "Home");
        assert_eq!(e.stem, "Report");
        assert!(!e.already, "a fresh target is a copy, not already-there");
        assert_eq!(e.rel, PathBuf::from("Home/Report.pdf"));
        assert_eq!(
            counts_line(&plan.counts),
            "organized 1: 1 copied, 0 already there, 0 failed, 0 duplicate, 0 not classified, 0 missing original",
        );
    }

    #[test]
    fn same_title_gets_suffix() {
        let f = fixture();
        let conn = open(&f);
        add_doc(
            &f,
            &conn,
            "one.pdf.vision.txt",
            "abc",
            Some("Report"),
            Some("Home"),
        );
        add_doc(
            &f,
            &conn,
            "two.pdf.vision.txt",
            "def",
            Some("Report"),
            Some("Home"),
        );
        let plan = build_plan(&f.config, &conn).unwrap();
        assert!(plan.entries.len() == 2);
        assert_eq!(plan.entries[0].stem, "Report");
        assert_eq!(plan.entries[1].stem, "Report (2)");
    }

    #[test]
    fn case_only_difference_collides() {
        let f = fixture();
        let conn = open(&f);
        add_doc(
            &f,
            &conn,
            "one.pdf.vision.txt",
            "abc",
            Some("Report"),
            Some("Home"),
        );
        add_doc(
            &f,
            &conn,
            "two.pdf.vision.txt",
            "def",
            Some("report"),
            Some("home"),
        );
        let plan = build_plan(&f.config, &conn).unwrap();
        assert_eq!(plan.entries[1].stem, "report (2)");
    }

    #[test]
    fn same_stem_other_extension_collides() {
        let f = fixture();
        let conn = open(&f);
        add_doc(
            &f,
            &conn,
            "one.pdf.vision.txt",
            "abc",
            Some("Report"),
            Some("Home"),
        );
        add_doc(
            &f,
            &conn,
            "two.jpg.vision.txt",
            "def",
            Some("Report"),
            Some("Home"),
        );
        let plan = build_plan(&f.config, &conn).unwrap();
        assert_eq!(plan.entries[0].rel, PathBuf::from("Home/Report.pdf"));
        assert_eq!(plan.entries[1].rel, PathBuf::from("Home/Report (2).jpg"));
    }

    #[test]
    fn duplicate_content_is_one_document() {
        let f = fixture();
        let conn = open(&f);
        add_doc(
            &f,
            &conn,
            "one.pdf.vision.txt",
            "abc",
            Some("Report"),
            Some("Home"),
        );
        add_doc(
            &f,
            &conn,
            "two.pdf.vision.txt",
            "abc",
            Some("Report"),
            Some("Home"),
        );
        let plan = build_plan(&f.config, &conn).unwrap();
        assert!(plan.entries.len() == 1, "identical bytes are one document");
        assert_eq!(plan.counts.duplicate, 1);
        assert_eq!(plan.entries[0].duplicates.len(), 1);
        assert_eq!(plan.entries[0].duplicates[0], "two.pdf.vision.txt");
    }

    #[test]
    fn folder_revalidated_from_db() {
        let f = fixture();
        let conn = open(&f);
        add_doc(
            &f,
            &conn,
            "one.pdf.vision.txt",
            "abc",
            Some("Report"),
            Some("../x"),
        );
        let plan = build_plan(&f.config, &conn).unwrap();
        assert_eq!(plan.entries[0].folder, classify::UNSORTED);
        assert!(inside_library(
            &f.config.paths.library_dir,
            &plan.entries[0].rel
        ));
    }

    #[test]
    fn title_none_falls_back_to_hash_name() {
        let hash = "deadbeefcafe12345678".to_string();
        assert_eq!(safe_title(None, hash.clone()), "doc-deadbeefcafe");
        let empty: String = "".to_string();
        assert_eq!(safe_title(Some(&empty), hash), "doc-deadbeefcafe");
    }

    #[test]
    fn hostile_title_stays_a_safe_name() {
        let hash = "deadbeefcafe12345678".to_string();
        let long = "x".repeat(10_000);
        let wide = "\u{1f600}".repeat(300);
        let hostile = [
            "../x",
            "a/b",
            "..",
            "...",
            "",
            "\u{0}",
            "a\u{202e}b",
            long.as_str(),
            wide.as_str(),
        ];
        for raw in hostile {
            let title: String = raw.to_string();
            let name = safe_title(Some(&title), hash.clone());
            assert!(
                !name
                    .chars()
                    .any(|c| c == '/' || c == '\\' || c == '.' || c.is_control()),
                "a hostile title produced an unsafe name",
            );
            assert!(name.len() + 4 < 255);
            let rel = PathBuf::from(format!("unsorted/{name}.pdf"));
            assert!(inside_library(&PathBuf::from("library"), &rel));
        }
    }

    #[test]
    fn hostile_folder_is_refused() {
        let bad = [
            "../../etc",
            "/abs",
            "a/b",
            "..",
            ".hidden",
            "a\\b",
            "C:",
            "~",
            "$HOME",
        ];
        for raw in bad {
            assert!(!classify::safe_folder(raw));
        }
    }

    #[test]
    fn safe_ext_cases() {
        assert_eq!(safe_ext(&PathBuf::from("x.PDF")).unwrap(), "pdf");
        assert_eq!(safe_ext(&PathBuf::from("a.tar.gz")).unwrap(), "gz");
        assert!(safe_ext(&PathBuf::from("x.a b")).is_none());
        assert!(safe_ext(&PathBuf::from("x.abcdefghi")).is_none());
        assert!(safe_ext(&PathBuf::from("Makefile")).is_none());
    }

    #[test]
    fn copy_keeps_original() {
        use std::os::unix::fs::PermissionsExt;
        let f = fixture();
        let conn = open(&f);
        add_doc(
            &f,
            &conn,
            "one.pdf.vision.txt",
            "abc",
            Some("Report"),
            Some("Home"),
        );
        let original = f.config.paths.docs_dir.join("one.pdf");
        let hash = classify::hash_file(&original).unwrap();
        let target = f.config.paths.library_dir.join("Home/Report.pdf");
        assert!(ensure_folder(&f.config.paths.library_dir, "Home"));
        assert!(copy_file(&original, &target, &hash));
        assert_eq!(fs::read_to_string(original).unwrap(), "abc");
        assert_eq!(classify::hash_file(&target).unwrap(), hash);
        assert_eq!(
            fs::metadata(target).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn existing_different_file_is_never_overwritten() {
        let f = fixture();
        let conn = open(&f);
        add_doc(
            &f,
            &conn,
            "one.pdf.vision.txt",
            "abc",
            Some("Report"),
            Some("Home"),
        );
        let original = f.config.paths.docs_dir.join("one.pdf");
        let hash = classify::hash_file(&original).unwrap();
        let target = f.config.paths.library_dir.join("Home/other.pdf");
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(&target, "ZZZ pre-existing").unwrap();
        assert!(!copy_file(&original, &target, &hash));
        assert_eq!(fs::read_to_string(target).unwrap(), "ZZZ pre-existing");
    }

    #[test]
    fn rerun_is_idempotent() {
        let f = fixture();
        let conn = open(&f);
        add_doc(
            &f,
            &conn,
            "one.pdf.vision.txt",
            "abc",
            Some("Report"),
            Some("Home"),
        );
        let target = build_plan(&f.config, &conn).unwrap().entries[0]
            .target
            .clone();
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(target, "abc").unwrap();
        let plan2 = build_plan(&f.config, &conn).unwrap();
        let second = plan2.entries.first().unwrap();
        assert!(
            second.already,
            "same bytes at the target means already there"
        );
        assert_eq!(second.stem, "Report");
    }

    #[test]
    fn library_inside_docs_is_refused() {
        let f = fixture();
        let mut inside = f.config.clone();
        inside.paths.library_dir = f.config.paths.docs_dir.join("library");
        assert!(check_library_separation(&inside).is_err());
        let mut contains = f.config.clone();
        contains.paths.docs_dir = f.config.paths.library_dir.join("docs");
        assert!(check_library_separation(&contains).is_err());
        assert!(check_library_separation(&f.config).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_folder_is_refused() {
        let f = fixture();
        let other = tempfile::tempdir().unwrap();
        fs::create_dir_all(&f.config.paths.library_dir).unwrap();
        std::os::unix::fs::symlink(other.path(), f.config.paths.library_dir.join("Home")).unwrap();
        assert!(
            !ensure_folder(&f.config.paths.library_dir, "Home"),
            "a symlinked folder is refused"
        );
        assert_eq!(fs::read_dir(other.path()).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn dry_run_changes_nothing() {
        let f = fixture();
        let conn = open(&f);
        add_doc(
            &f,
            &conn,
            "one.pdf.vision.txt",
            "abc",
            Some("Invoice 42/2025 ACME"),
            Some("Home"),
        );
        let original = f.config.paths.docs_dir.join("one.pdf");
        let before = fs::read_to_string(&original).unwrap();
        run(&f.config, true, false).await.unwrap();
        assert!(
            !fs::exists(f.config.paths.library_dir).unwrap_or(false),
            "dry-run must not create the library"
        );
        assert!(
            fs::exists(&original).unwrap_or(false),
            "the original is never moved"
        );
        assert_eq!(fs::read_to_string(original).unwrap(), before);
    }

    #[tokio::test]
    async fn dry_run_without_db_does_not_create_it() {
        let f = fixture();
        run(&f.config, true, false).await.unwrap();
        assert!(
            !fs::exists(f.config.paths.db).unwrap_or(false),
            "dry-run must not create the database"
        );
        assert!(
            !fs::exists(f.config.paths.library_dir).unwrap_or(false),
            "dry-run must not create the library"
        );
    }

    #[tokio::test]
    async fn apply_embeds_new_source_prefix() {
        use serde_json::json;
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, Request as MockRequest, ResponseTemplate};

        let f = fixture();
        let conn = open(&f);
        add_doc(
            &f,
            &conn,
            "one.pdf.vision.txt",
            "hello world document",
            Some("Invoice 42/2025 ACME"),
            Some("Home"),
        );
        let plan = build_plan(&f.config, &conn).unwrap();
        let entry = plan.entries.into_iter().next().unwrap();
        let target = entry.target.clone();
        let source = format!("{}/{}", entry.folder, entry.stem);
        let prefix = format!("{source}\n");

        let server = MockServer::start().await;
        // Only answer with real embeddings when every input begins with "<folder>/<name>\n".
        Mock::given(method("POST"))
            .and(path("/embed"))
            .respond_with(move |req: &MockRequest| {
                let body: serde_json::Value = serde_json::from_slice(&req.body).unwrap();
                let texts = body["texts"].as_array().unwrap();
                let ok = texts
                    .iter()
                    .all(|t| t.as_str().unwrap().starts_with(&prefix));
                if !ok {
                    return ResponseTemplate::new(200)
                        .set_body_json(json!({"dense": [], "sparse": []}));
                }
                let dense: Vec<_> = texts.iter().map(|_| vec![0.5]).collect();
                let sparse: Vec<_> = texts
                    .iter()
                    .map(|_| json!({"indices": [1], "values": [0.5]}))
                    .collect();
                ResponseTemplate::new(200).set_body_json(json!({"dense": dense, "sparse": sparse}))
            })
            .expect(1)
            .mount(&server)
            .await;

        let embed = EmbedClient::new(&server.uri());
        apply_entry(&f.config, &embed, None, entry).await.unwrap();
        assert!(
            fs::exists(&target).unwrap_or(false),
            "the copy landed in the library"
        );
    }
}
