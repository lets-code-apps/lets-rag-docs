//! `lets-rag-docs organize`: copy each classified original into a tidy `library/<folder>/<title>`
//! and re-index the copy under its new source. `--dry-run` prints the plan and changes nothing;
//! `--apply` copies (never moves or renames the originals) and re-embeds the copies.
//!
//! The library path is built from segments that are validated or sanitised by construction
//! (`classify::safe_folder`, `safe_title`, `safe_ext`), never from raw model text: a document can
//! steer the model into a `folder` or `title` like `../../etc`, and that must never escape
//! `library_dir`. Nothing here deletes or moves an original; the only writes are new copies under
//! the library and new points in the collection. A dry-run reads the database through a read-only
//! connection, so it cannot create the file, its table, a parent folder or the library either.

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
use qdrant_client::qdrant::PointStruct;

/// A title becomes at most this many characters (then at most 200 bytes on disk).
const TITLE_CAP: usize = 80;
const TITLE_BYTES: usize = 200;
/// Collision suffixes `name`, `name (2)`, ... before giving up on a document.
const COLLISION_CAP: usize = 1000;
/// A word with this many digits is a reference number, not a name (see `sanitise`).
const LONG_NUMBER_DIGITS: usize = 8;

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
    /// The sanitised title (before any collision suffix) and the extension the copy gets: planning
    /// and apply both derive their candidate names from these two fields.
    name: String,
    ext_suffix: String,
    /// `folder/stem.ext`, relative to the library: the name `resolve_target` picked, checked by
    /// `inside_library` before a write.
    rel: PathBuf,
    meta: db::Meta,
    duplicates: Vec<String>,
}

#[derive(Clone)]
struct Counts {
    /// What the plan would do.
    would_copy: usize,
    would_reuse: usize,
    /// What `--apply` did. A copy that failed counts as failed only and never as copied, so an
    /// operator can read the totals and know whether a retry is needed.
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

    if mode == Mode::DryRun {
        // A dry-run may read, never write: `db::open` creates the parent folder, the file and its
        // table and tightens permissions, so dry-run opens the database read-only instead - and
        // does not open it at all when the file is missing.
        if !std::fs::exists(&config.paths.db).unwrap_or(false) {
            println!(
                "run `classify` first: no database at {}",
                config.paths.db.display()
            );
            return Ok(());
        }
        let conn = db::open_read_only(&config.paths.db)?;
        if !db::has_documents(&conn)? {
            println!(
                "run `classify` first: no documents table in {}",
                config.paths.db.display()
            );
            return Ok(());
        }
        let plan = build_plan(config, &conn)?;
        for line in plan.lines {
            println!("{}", line);
        }
        println!("{}", plan_line(&plan.counts));
        return Ok(());
    }

    // Only `--apply` opens the embed service and Qdrant.
    let conn = db::open(&config.paths.db)?;
    let plan = build_plan(config, &conn)?;
    for line in plan.lines {
        println!("{}", line);
    }
    let embed = EmbedClient::new(&config.embed.url);
    let qdrant = index::connect(&config.qdrant.url)?;
    let mut counts = plan.counts.clone();
    for entry in plan.entries {
        let applied = apply_entry(config, &embed, Some(&qdrant), entry).await?;
        tally(&mut counts, applied);
    }
    println!("{}", apply_line(&counts));
    Ok(())
}

/// The library folder a stored `folder` files under. The row is data on disk, not trusted, and one
/// classified before `[classify] folders` existed may hold a free-text name: both go to `unsorted`.
/// Shared with `eval --classify`, so the eval scores the folder `organize` would really use.
pub(crate) fn library_folder(config: &Config, folder: Option<&str>) -> String {
    match folder {
        Some(f) if classify::safe_folder(f) && config.classify.folders.iter().any(|c| c == f) => {
            f.to_string()
        }
        _ => classify::UNSORTED.to_string(),
    }
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
        would_copy: 0,
        would_reuse: 0,
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

        let folder: String = library_folder(config, meta.folder.as_deref());
        let name = file_name(&meta, hash.to_string());
        let ext = safe_ext(&original);
        let ext_suffix: String = match ext.as_ref() {
            Some(e) => format!(".{e}"),
            None => String::new(),
        };

        let (stem, already, ok) =
            resolve_target(library, &folder, &name, &ext_suffix, &hash, &claimed);
        if !ok {
            counts.failed += 1;
            continue;
        }
        claimed.insert(target_key(&folder, &stem).to_lowercase());
        let rel_path: PathBuf = rel_for(&folder, &stem, &ext_suffix);

        if already {
            lines.push(format!(
                "already there  {orel} -> {folder}/{stem}{ext_suffix}"
            ));
            counts.would_reuse += 1;
        } else {
            lines.push(format!("copy  {orel} -> {folder}/{stem}{ext_suffix}"));
            counts.would_copy += 1;
        }
        entry_by_hash.insert(hash.clone(), entries.len());
        entries.push(Entry {
            ocr_rel: rel,
            ocr_abs: path.to_path_buf(),
            original,
            hash,
            folder,
            name,
            ext_suffix,
            rel: rel_path,
            meta,
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
/// The last member of the tuple is false when no name within `COLLISION_CAP` was free.
fn resolve_target(
    library: &Path,
    folder: &str,
    name: &str,
    ext_suffix: &str,
    hash: &str,
    claimed: &HashSet<String>,
) -> (String, bool, bool) {
    for n in 1..=COLLISION_CAP {
        let stem: String = stem_for(name, n);
        let key: String = target_key(folder, &stem).to_lowercase();
        if claimed.contains(&key) {
            continue;
        }
        let candidate: PathBuf = candidate_path(library, folder, &stem, ext_suffix);
        match classify::hash_file(&candidate) {
            // A file is there: same bytes => reuse it; different bytes => this name is taken.
            Ok(seen) if seen == hash => return (stem, true, true),
            Ok(_) => continue,
            // Nothing there (NotFound or the folder missing) => copy here.
            Err(e) if e.kind() == io::ErrorKind::NotFound => return (stem, false, true),
            Err(_) => continue,
        }
    }
    // No free name within the cap: give up on this document rather than write somewhere else.
    (String::new(), false, false)
}

fn target_key(folder: &str, stem: &str) -> String {
    format!("{folder}/{stem}")
}

/// The nth candidate stem for a document: `name`, then `name (2)`, `name (3)`, ...
fn stem_for(name: &str, n: usize) -> String {
    if n == 1 {
        name.to_string()
    } else {
        format!("{name} ({n})")
    }
}

/// `<library>/<folder>/<stem><ext>` for one candidate name.
fn candidate_path(library: &Path, folder: &str, stem: &str, ext_suffix: &str) -> PathBuf {
    PathBuf::from(format!(
        "{lib}/{folder}/{stem}{ext_suffix}",
        lib = library.display()
    ))
}

/// `<folder>/<stem><ext>`: the same name relative to the library, which is what `inside_library`
/// checks and what the plan prints.
fn rel_for(folder: &str, stem: &str, ext_suffix: &str) -> PathBuf {
    PathBuf::from(format!("{folder}/{stem}{ext_suffix}"))
}

#[derive(Debug, Eq, PartialEq)]
enum Applied {
    Copied,
    Reused,
    Failed,
}

/// One entry's final library name: the stem and relative path the copy landed under, plus whether
/// the bytes were written now (`false`: an identical file was already there).
struct Filed {
    stem: String,
    rel: PathBuf,
    wrote: bool,
}

/// Does one planned entry: create the folder (refusing a symlink), copy the bytes owner-only, then
/// embed and re-index under the source the copy actually landed under. Embed and Qdrant errors abort
/// the whole run (the service is down, so continuing is pointless); a per-file copy or folder error
/// is just counted and the run moves on. The `Option` `qdrant` is a seam: tests without a Qdrant pass
/// `None` and still exercise the copy and the embed.
async fn apply_entry(
    config: &Config,
    embed: &EmbedClient,
    qdrant: Option<&Qdrant>,
    entry: Entry,
) -> anyhow::Result<Applied> {
    debug_assert!(inside_library(&config.paths.library_dir, &entry.rel));
    if !ensure_folder(&config.paths.library_dir, &entry.folder) {
        tracing::warn!(
            "refusing to write into a non-directory or symlinked folder {}",
            entry.folder
        );
        return Ok(Applied::Failed);
    }
    // The plan's `already` is re-checked, not trusted: `copy_with_probe` re-hashes whatever sits at
    // the planned name, so a file another process swapped in meanwhile is walked past (never indexed,
    // never overwritten) and the copy takes the next free suffix.
    let filed: Option<Filed> = copy_with_probe(&config.paths.library_dir, &entry);
    let filed: Filed = match filed {
        None => return Ok(Applied::Failed),
        Some(filed) => filed,
    };
    debug_assert!(inside_library(&config.paths.library_dir, &filed.rel));

    // Embed before deleting (as `ingest` does): a failure here leaves the old index untouched.
    let re: Reindex = reembed(embed, &entry, &filed).await?;
    if let Some(client) = qdrant {
        for file in re.delete {
            index::delete_file(client, &config.qdrant.collection, file.as_str()).await?;
        }
        index::upsert(client, &config.qdrant.collection, re.points).await?;
    }
    tracing::debug!("re-indexed {} under {}", entry.ocr_rel, re.source);
    Ok(if filed.wrote {
        Applied::Copied
    } else {
        Applied::Reused
    })
}

/// Embeds one document's OCR text under its new source and builds the points to write. Split out
/// from `apply_entry` so a test with no Qdrant can still see what would be written: `delete` lists
/// the OCR files whose old points must go first, and `points` carry the new source and the
/// `index::organized_id` ids that let a rerun overwrite its own work.
struct Reindex {
    source: String,
    delete: Vec<String>,
    points: Vec<PointStruct>,
}

async fn reembed(embed: &EmbedClient, entry: &Entry, filed: &Filed) -> anyhow::Result<Reindex> {
    let text = std::fs::read_to_string(&entry.ocr_abs)
        .with_context(|| format!("cannot read {}", entry.ocr_abs.display()))?;
    let source: String = format!("{}/{}", entry.folder, filed.stem);
    let parts = chunk::chunks(&text);
    let inputs: Vec<String> = parts.iter().map(|c| format!("{source}\n{c}")).collect();
    let embeddings = embed.embed(&inputs).await?;
    let points: Vec<PointStruct> = parts
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
    // The copy's own OCR file plus every duplicate that pointed at these bytes.
    let mut delete: Vec<String> = Vec::new();
    delete.push(entry.ocr_rel.clone());
    delete.extend(entry.duplicates.iter().cloned());
    Ok(Reindex {
        source,
        delete,
        points,
    })
}

/// Copies the original under the planned name - or, when the bytes are already there, leaves them
/// and reports that - walking `name (2)`, `name (3)`, ... when that path was claimed by a different
/// file between planning and applying (another process, or one Unicode
/// spelling of a name the case-insensitive filesystem already holds under another). `create_new` is
/// what reports the clash, so nothing that exists is ever overwritten.
fn copy_with_probe(library: &Path, entry: &Entry) -> Option<Filed> {
    for n in 1..=COLLISION_CAP {
        let stem: String = stem_for(&entry.name, n);
        let target: PathBuf = candidate_path(library, &entry.folder, &stem, &entry.ext_suffix);
        match copy_attempt(entry, &target) {
            Attempt::Wrote => return Some(filed_for(library, entry, &stem, true)),
            Attempt::Reused => return Some(filed_for(library, entry, &stem, false)),
            Attempt::Taken => continue,
            Attempt::Failed => return None,
        }
    }
    tracing::warn!(
        "no free library name for {} within {} tries",
        entry.ocr_rel,
        COLLISION_CAP
    );
    None
}

/// The `Filed` for one candidate name.
fn filed_for(library: &Path, entry: &Entry, stem: &str, wrote: bool) -> Filed {
    let rel: PathBuf = rel_for(&entry.folder, stem, &entry.ext_suffix);
    debug_assert!(inside_library(library, &rel));
    Filed {
        stem: stem.to_string(),
        rel,
        wrote,
    }
}

/// What one copy attempt found at a candidate path.
enum Attempt {
    /// The bytes were written to a new file.
    Wrote,
    /// An identical file was already there: nothing to write.
    Reused,
    /// Another file is there: this name is taken, so the probe tries the next suffix.
    Taken,
    /// An I/O error while writing: another name would not help.
    Failed,
}

/// Copies the original to one candidate path: create-only (never overwrite), owner-only, then verify
/// the bytes. The only file it may remove is a partial copy it just created itself.
fn copy_attempt(entry: &Entry, target: &Path) -> Attempt {
    let bytes: Vec<u8> = match std::fs::read(&entry.original) {
        Ok(bytes) => bytes,
        Err(e) => {
            tracing::warn!("cannot read the original {}: {e}", entry.original.display());
            return Attempt::Failed;
        }
    };
    let opened = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(target);
    if opened.is_err() {
        // Something is already at this path: reuse it only when the bytes already match.
        return match classify::hash_file(target) {
            Ok(seen) if seen == entry.hash => Attempt::Reused,
            Ok(_) => Attempt::Taken,
            Err(e) => {
                tracing::warn!("cannot hash the file at {}: {e}", target.display());
                Attempt::Failed
            }
        };
    }
    let mut dst = opened.unwrap();
    if dst.write_all(&bytes).is_err() {
        remove_partial(target);
        return Attempt::Failed;
    }
    match classify::hash_file(target) {
        Ok(seen) if seen == entry.hash => Attempt::Wrote,
        Ok(_) => {
            tracing::warn!(
                "the copy at {} does not match its original",
                target.display()
            );
            remove_partial(target);
            Attempt::Failed
        }
        Err(e) => {
            tracing::warn!("cannot verify the copy at {}: {e}", target.display());
            remove_partial(target);
            Attempt::Failed
        }
    }
}

/// Remove a copy this run created and could not verify.
fn remove_partial(target: &Path) {
    if std::fs::remove_file(target).is_err() {
        tracing::warn!("could not remove the partial copy {}", target.display());
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

/// What the plan would do.
fn plan_line(c: &Counts) -> String {
    format!(
        "planned {}: {} to copy, {} already there, {} failed, {} duplicate, {} not classified, {} missing original",
        c.would_copy + c.would_reuse,
        c.would_copy,
        c.would_reuse,
        c.failed,
        c.duplicate,
        c.not_classified,
        c.missing,
    )
}

/// What `--apply` did: only copies that really landed count as copied.
fn apply_line(c: &Counts) -> String {
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

/// Moves one apply outcome into the counts.
fn tally(counts: &mut Counts, applied: Applied) {
    match applied {
        Applied::Copied => counts.copied += 1,
        Applied::Reused => counts.already += 1,
        Applied::Failed => counts.failed += 1,
    }
}

/// `YYYY-MM-DD Title`: the date first, so a folder lists oldest to newest in any file browser (the
/// phone's Files app included). The date is re-checked: the database row is data, not trusted.
fn file_name(meta: &db::Meta, hash: String) -> String {
    let title: String = safe_title(meta.title.as_ref(), hash);
    match meta.date.as_deref().filter(|d| classify::is_date(d)) {
        Some(date) => format!("{date} {title}"),
        None => title,
    }
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
    // Account, card, contract and ID numbers tell a person browsing nothing and should not sit in a
    // file name on a phone: drop every word with 8 or more digits (the database keeps the full title).
    let words: Vec<&str> = s
        .split_whitespace()
        .filter(|w| w.chars().filter(|c| c.is_ascii_digit()).count() < LONG_NUMBER_DIGITS)
        .collect();
    let s: String = words.join(" ");
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

    use serde_json::json;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, Request as MockRequest, ResponseTemplate};

    use qdrant_client::qdrant::CountPointsBuilder;
    use qdrant_client::qdrant::value::Kind;

    use super::*;
    use crate::classify;
    use crate::embed::{Embedding, Sparse};

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

    // Embed mock that answers with real vectors only when every text begins with `prefix`; any other
    // request gets an empty reply, so a wrong `source` fails loudly (a count mismatch) rather than
    // passing quietly.
    async fn embed_prefix_mock(prefix: &str) -> MockServer {
        let server: MockServer = MockServer::start().await;
        let prefix: String = prefix.to_string();
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
                // 1024 like bge-m3: a real Qdrant (the ignored round-trip test) rejects any other size.
                let dense: Vec<_> = texts.iter().map(|_| vec![0.5; 1024]).collect();
                let sparse: Vec<_> = texts
                    .iter()
                    .map(|_| json!({"indices": [1], "values": [0.5]}))
                    .collect();
                ResponseTemplate::new(200).set_body_json(json!({"dense": dense, "sparse": sparse}))
            })
            .expect(1)
            .mount(&server)
            .await;
        server
    }

    // Embed mock that answers any request: for the tests that check something other than the prefix.
    async fn embed_ok_mock() -> MockServer {
        let server: MockServer = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/embed"))
            .respond_with(|req: &MockRequest| {
                let body: serde_json::Value = serde_json::from_slice(&req.body).unwrap();
                let texts = body["texts"].as_array().unwrap();
                // 1024 like bge-m3: a real Qdrant (the ignored round-trip test) rejects any other size.
                let dense: Vec<_> = texts.iter().map(|_| vec![0.5; 1024]).collect();
                let sparse: Vec<_> = texts
                    .iter()
                    .map(|_| json!({"indices": [1], "values": [0.5]}))
                    .collect();
                ResponseTemplate::new(200).set_body_json(json!({"dense": dense, "sparse": sparse}))
            })
            .mount(&server)
            .await;
        server
    }

    fn payload_string(p: &PointStruct, key: &str) -> String {
        match p.payload.get(key).and_then(|v| v.kind.as_ref()) {
            Some(Kind::StringValue(s)) => s.to_string(),
            _ => panic!("payload has no string {key}"),
        }
    }

    async fn count_points(client: &Qdrant, collection: &str) -> u64 {
        client
            .count(CountPointsBuilder::new(collection.to_string()).exact(true))
            .await
            .unwrap()
            .result
            .unwrap()
            .count
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
        assert_eq!(e.rel, PathBuf::from("Home/Report.pdf"));
        assert_eq!(
            plan_line(&plan.counts),
            "planned 1: 1 to copy, 0 already there, 0 failed, 0 duplicate, 0 not classified, 0 missing original",
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
        assert_eq!(plan.entries[0].rel, PathBuf::from("Home/Report.pdf"));
        assert_eq!(plan.entries[1].rel, PathBuf::from("Home/Report (2).pdf"));
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
            // Folders are stored in their configured spelling, so only the title differs in case.
            Some("Home"),
        );
        let plan = build_plan(&f.config, &conn).unwrap();
        assert_eq!(plan.entries[1].rel, PathBuf::from("Home/report (2).pdf"));
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
        // Safe as a path, but not in `[classify] folders` (a row from before the list existed).
        add_doc(
            &f,
            &conn,
            "two.pdf.vision.txt",
            "def",
            Some("Letter"),
            Some("Дом"),
        );
        let plan = build_plan(&f.config, &conn).unwrap();
        assert_eq!(plan.entries[0].folder, classify::UNSORTED);
        assert_eq!(plan.entries[1].folder, classify::UNSORTED);
        assert!(inside_library(
            &f.config.paths.library_dir,
            &plan.entries[0].rel
        ));
    }

    #[test]
    fn file_name_starts_with_the_date_and_drops_long_numbers() {
        let meta = |title: &str, date: Option<&str>| db::Meta {
            title: Some(title.to_string()),
            doc_type: "loan".into(),
            date: date.map(String::from),
            people: vec![],
            issuer: None,
            folder: None,
        };
        let hash = "deadbeefcafe12345678".to_string();
        let schedule = meta("Repayment Schedule 1234567890123456", Some("2025-03-14"));
        assert_eq!(
            file_name(&schedule, hash.clone()),
            "2025-03-14 Repayment Schedule"
        );
        // An IBAN-like word goes whole; a short invoice number stays.
        let invoice = meta("Invoice 42/2025 PL61109010140000071219812874 ACME", None);
        assert_eq!(file_name(&invoice, hash.clone()), "Invoice 42-2025 ACME");
        // A date that is not a real calendar date is not put in front.
        let bad_date = meta("Report", Some("2025-13-40"));
        assert_eq!(file_name(&bad_date, hash.clone()), "Report");
        // Only a number: the hash name, still dated.
        let only_number = meta("1234567890123456", Some("2025-03-14"));
        assert_eq!(file_name(&only_number, hash), "2025-03-14 doc-deadbeefcafe");
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
        let plan = build_plan(&f.config, &conn).unwrap();
        let entry = plan.entries.first().unwrap();
        assert!(ensure_folder(&f.config.paths.library_dir, &entry.folder));
        let filed = copy_with_probe(&f.config.paths.library_dir, entry).unwrap();
        assert!(filed.wrote);
        let target = f.config.paths.library_dir.join(&filed.rel);
        assert_eq!(fs::read_to_string(&entry.original).unwrap(), "abc");
        assert_eq!(classify::hash_file(&target).unwrap(), entry.hash);
        assert_eq!(
            fs::metadata(&target).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn existing_different_file_walks_the_next_suffix() {
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
        let plan = build_plan(&f.config, &conn).unwrap();
        let entry = plan.entries.first().unwrap();
        let planned = f.config.paths.library_dir.join(&entry.rel);
        fs::create_dir_all(planned.parent().unwrap()).unwrap();
        fs::write(&planned, "ZZZ pre-existing").unwrap();
        let filed = copy_with_probe(&f.config.paths.library_dir, entry).unwrap();
        assert_eq!(
            filed.stem, "Report (2)",
            "a taken name is walked, never overwritten"
        );
        assert_eq!(fs::read_to_string(&planned).unwrap(), "ZZZ pre-existing");
        let moved = f.config.paths.library_dir.join(&filed.rel);
        assert_eq!(classify::hash_file(&moved).unwrap(), entry.hash);
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
        let plan1 = build_plan(&f.config, &conn).unwrap();
        let first = plan1.entries.first().unwrap();
        let target = f.config.paths.library_dir.join(&first.rel);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(&target, "abc").unwrap();
        let plan2 = build_plan(&f.config, &conn).unwrap();
        assert!(
            plan2.lines[0].starts_with("already there"),
            "same bytes at the target means already there",
        );
        assert_eq!(plan2.entries[0].rel, PathBuf::from("Home/Report.pdf"));
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

    #[test]
    fn library_copies_are_gitignored() {
        // `--apply` files copies of real documents: an in-repo library must never be committable.
        let ignore: &str = include_str!("../.gitignore");
        assert!(ignore.contains("/library/"));
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
            !fs::exists(&f.config.paths.db).unwrap_or(false),
            "dry-run must not create the database"
        );
        assert!(
            !fs::exists(f.config.paths.db.parent().unwrap()).unwrap_or(false),
            "dry-run must not create the database's parent folder either",
        );
        assert!(
            !fs::exists(f.config.paths.library_dir).unwrap_or(false),
            "dry-run must not create the library"
        );
    }

    #[tokio::test]
    async fn dry_run_does_not_touch_the_database() {
        use std::os::unix::fs::PermissionsExt;
        let f = fixture();
        {
            let conn = open(&f);
            add_doc(
                &f,
                &conn,
                "one.pdf.vision.txt",
                "abc",
                Some("Report"),
                Some("Home"),
            );
        }
        // Deliberately loose: `db::open` would tighten them to 0600, so a write is visible.
        fs::set_permissions(&f.config.paths.db, fs::Permissions::from_mode(0o644)).unwrap();
        let before: Vec<u8> = fs::read(&f.config.paths.db).unwrap();
        run(&f.config, true, false).await.unwrap();
        assert_eq!(
            fs::read(&f.config.paths.db).unwrap(),
            before,
            "dry-run must leave the database bytes alone",
        );
        assert_eq!(
            fs::metadata(&f.config.paths.db)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o644,
            "dry-run must leave the permissions alone",
        );
        let ro = db::open_read_only(&f.config.paths.db).unwrap();
        assert!(
            db::has_documents(&ro).unwrap(),
            "dry-run must leave the schema alone",
        );
    }

    #[tokio::test]
    async fn dry_run_without_the_documents_table_says_so() {
        // A database file that exists but has no table yet: dry-run must hint, not create it.
        let f = fixture();
        fs::create_dir_all(f.config.paths.db.parent().unwrap()).unwrap();
        Connection::open(&f.config.paths.db).unwrap();
        run(&f.config, true, false).await.unwrap();
        let ro = db::open_read_only(&f.config.paths.db).unwrap();
        assert!(
            !db::has_documents(&ro).unwrap(),
            "dry-run must not create the documents table",
        );
    }

    #[tokio::test]
    async fn apply_embeds_new_source_prefix() {
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
        let target = f.config.paths.library_dir.join(&entry.rel);
        // Every embedded chunk must start with the library name, not the old OCR source.
        let prefix: String = format!("{}/{}\n", entry.folder, entry.name);
        let server = embed_prefix_mock(&prefix).await;
        let embed = EmbedClient::new(&server.uri());
        let applied = apply_entry(&f.config, &embed, None, entry).await.unwrap();
        assert_eq!(applied, Applied::Copied);
        assert!(
            fs::exists(&target).unwrap_or(false),
            "the copy landed in the library"
        );
        assert_eq!(fs::read_to_string(&target).unwrap(), "hello world document");
    }

    #[tokio::test]
    async fn reembed_carries_the_organized_source() {
        // The re-index seam without a Qdrant: which old points must go, and what the new ones say.
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
        // Same bytes as the first document: one row (one title), and it becomes a duplicate.
        add_doc(
            &f,
            &conn,
            "two.pdf.vision.txt",
            "abc",
            Some("Report"),
            Some("Home"),
        );
        let plan = build_plan(&f.config, &conn).unwrap();
        let entry = plan.entries.into_iter().next().unwrap();
        assert_eq!(entry.duplicates[0], "two.pdf.vision.txt");
        let server = embed_ok_mock().await;
        let embed = EmbedClient::new(&server.uri());
        let filed = Filed {
            stem: entry.name.clone(),
            rel: entry.rel.clone(),
            wrote: true,
        };
        let re = reembed(&embed, &entry, &filed).await.unwrap();
        assert_eq!(re.source, "Home/Report");
        assert_eq!(re.delete.len(), 2);
        assert_eq!(re.delete[0], "one.pdf.vision.txt");
        assert_eq!(re.delete[1], "two.pdf.vision.txt");
        assert_eq!(re.points.len(), 1);
        let p: PointStruct = re.points.first().unwrap().clone();
        // A point's id is a wrapper, so compare it against the id `index::point` was asked for.
        let expected_id = index::point(
            index::organized_id(&entry.hash, 0),
            "x".into(),
            "s",
            "f",
            0,
            Embedding {
                dense: vec![0.0],
                sparse: Sparse {
                    indices: vec![],
                    values: vec![],
                },
            },
            None,
        )
        .id;
        assert_eq!(p.id, expected_id);
        assert_eq!(payload_string(&p, "source"), "Home/Report");
        assert_eq!(payload_string(&p, "file"), "one.pdf.vision.txt");
        assert_eq!(payload_string(&p, "type"), "invoice");
    }

    #[tokio::test]
    async fn apply_recovers_from_a_late_collision() {
        // Another file claims the planned name after planning: apply must take the next suffix,
        // keep that stranger's bytes, and embed under the name it actually filed the copy under.
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
        let plan = build_plan(&f.config, &conn).unwrap();
        let entry = plan.entries.into_iter().next().unwrap();
        let planned = f.config.paths.library_dir.join(&entry.rel);
        let original = entry.original.clone();
        fs::create_dir_all(planned.parent().unwrap()).unwrap();
        fs::write(&planned, "someone else's file").unwrap();
        let prefix: String = format!("{}/{} (2)\n", entry.folder, entry.name);
        let server = embed_prefix_mock(&prefix).await;
        let embed = EmbedClient::new(&server.uri());
        let applied = apply_entry(&f.config, &embed, None, entry).await.unwrap();
        assert_eq!(applied, Applied::Copied);
        assert_eq!(fs::read_to_string(&planned).unwrap(), "someone else's file");
        let moved = f.config.paths.library_dir.join("Home/Report (2).pdf");
        assert!(
            fs::exists(&moved).unwrap_or(false),
            "the copy took the next free name"
        );
        assert_eq!(
            classify::hash_file(&moved).unwrap(),
            classify::hash_file(&original).unwrap()
        );
    }

    #[tokio::test]
    async fn apply_rejects_a_file_swapped_into_an_already_there_target() {
        // The mirror of the late-collision test: the plan marked the planned name "already there"
        // because our own bytes sat there, then another process replaced them. Apply must leave the
        // stranger alone and file the copy under the next suffix - never index the stranger's bytes.
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
        let planned = f.config.paths.library_dir.join("Home/Report.pdf");
        fs::create_dir_all(planned.parent().unwrap()).unwrap();
        fs::write(&planned, "abc").unwrap();
        let plan = build_plan(&f.config, &conn).unwrap();
        assert!(
            plan.lines[0].starts_with("already there"),
            "the plan saw our own bytes at the planned name",
        );
        assert_eq!(plan.counts.would_reuse, 1);
        let entry = plan.entries.into_iter().next().unwrap();
        fs::write(&planned, "swapped in by someone else").unwrap();

        let prefix: String = format!("{}/{} (2)\n", entry.folder, entry.name);
        let server = embed_prefix_mock(&prefix).await;
        let embed = EmbedClient::new(&server.uri());
        let applied = apply_entry(&f.config, &embed, None, entry).await.unwrap();
        assert_eq!(
            applied,
            Applied::Copied,
            "the stranger is never filed as this document"
        );
        assert_eq!(
            fs::read_to_string(&planned).unwrap(),
            "swapped in by someone else"
        );
        let moved = f.config.paths.library_dir.join("Home/Report (2).pdf");
        assert!(
            fs::exists(&moved).unwrap_or(false),
            "the copy took the next free name"
        );
        assert_eq!(fs::read_to_string(&moved).unwrap(), "abc");
    }

    #[tokio::test]
    async fn failed_copy_is_not_counted_as_copied() {
        // A directory where the copy should go: the copy cannot happen, so the document counts as
        // failed only - never as copied, and never re-embedded (the fixture's embed URL is a dead
        // port, so an embed attempt would return an error instead of this result).
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
        let plan = build_plan(&f.config, &conn).unwrap();
        assert_eq!(plan.counts.would_copy, 1);
        let entry = plan.entries.into_iter().next().unwrap();
        let target = f.config.paths.library_dir.join(&entry.rel);
        fs::create_dir_all(&target).unwrap();
        let embed = EmbedClient::new(&f.config.embed.url);
        let applied = apply_entry(&f.config, &embed, None, entry).await.unwrap();
        assert_eq!(applied, Applied::Failed);
        let mut counts = plan.counts.clone();
        tally(&mut counts, applied);
        assert_eq!(counts.copied, 0);
        assert_eq!(counts.failed, 1);
        assert_eq!(
            apply_line(&counts),
            "organized 0: 0 copied, 0 already there, 1 failed, 0 duplicate, 0 not classified, 0 missing original",
        );
    }

    #[ignore]
    #[tokio::test]
    async fn apply_reindexes_the_copy_in_qdrant() {
        // Needs a real Qdrant at 127.0.0.1:6334 (`docker compose up -d`); this repo has no CI, so
        // run it by hand with `cargo test -- --ignored`. The point counts are the proof: with no
        // delete the total grows, with no upsert it shrinks, and an unscoped delete would take the
        // other document's point with it.
        let client = index::connect("http://127.0.0.1:6334").unwrap();
        let mut f = fixture();
        f.config.qdrant.collection = "test-organize-apply".to_string();
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
        let server = embed_ok_mock().await;
        let embed = EmbedClient::new(&server.uri());
        index::recreate(&client, &f.config.qdrant.collection)
            .await
            .unwrap();
        // Seed the collection the way `ingest` does: one point per document, under the old sources.
        let plan = build_plan(&f.config, &conn).unwrap();
        assert_eq!(plan.entries.len(), 2);
        let mut seeded: Vec<PointStruct> = Vec::new();
        for entry in &plan.entries {
            let text = fs::read_to_string(&entry.ocr_abs).unwrap();
            seeded.extend(
                index::document_points(&embed, &entry.ocr_rel, text, None)
                    .await
                    .unwrap(),
            );
        }
        index::upsert(&client, &f.config.qdrant.collection, seeded)
            .await
            .unwrap();
        assert_eq!(count_points(&client, &f.config.qdrant.collection).await, 2);
        let entry = plan.entries.into_iter().next().unwrap();
        assert_eq!(entry.ocr_rel, "one.pdf.vision.txt");
        let applied = apply_entry(&f.config, &embed, Some(&client), entry)
            .await
            .unwrap();
        assert_eq!(applied, Applied::Copied);
        assert_eq!(
            count_points(&client, &f.config.qdrant.collection).await,
            2,
            "old points deleted, organized ones added, the other document untouched",
        );
        client
            .delete_collection(&f.config.qdrant.collection)
            .await
            .unwrap();
    }
}
