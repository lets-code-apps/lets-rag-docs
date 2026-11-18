//! `lets-rag-docs filing`: read and change the `[classify]` filing lists through the engine.
//!
//! `show` is read-only. `save` accepts the draft on stdin (names never go through argv, where a
//! process list could expose them), validates it with `classify::check_names`, then writes only
//! the two value spans with `config_edit`. Expected states - a valid draft, an invalid draft, or
//! `--check` - are JSON results with exit 0; unreadable stdin, bad JSON or a failed write is a
//! real error with the reason on stderr and no JSON on stdout.

use std::collections::HashSet;
use std::io;
use std::path::Path;

use anyhow::{Context, anyhow};
use serde::{Deserialize, Serialize};

use crate::classify;
use crate::classify::{NameCode, NameIssue, NameList, check_names};
use crate::config::Config;
use crate::config_edit;
use crate::db;

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum List {
    Folders,
    Owners,
    SharedOwner,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "snake_case")]
enum Code {
    EmptyList,
    InvalidName,
    Duplicate,
    RenameFromNotInList,
    RenameToNotInList,
    RenameConflict,
}

#[derive(Serialize)]
struct Error {
    list: List,
    index: Option<usize>,
    name: Option<String>,
    code: Code,
    message: String,
}

#[derive(Serialize)]
struct ShowReport {
    version: u8,
    folders: Vec<String>,
    owners: Vec<String>,
    shared_owner: String,
}

#[derive(Serialize)]
struct SaveReport {
    version: u8,
    ok: bool,
    saved: bool,
    /// How many database rows the renames updated (0 also for a repeat, where the UPDATE
    /// matches nothing - that is what makes saving again safe).
    renamed: usize,
    folders: Vec<String>,
    owners: Vec<String>,
    errors: Vec<Error>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Draft {
    folders: Vec<String>,
    owners: Vec<String>,
    /// Present only when the draft renames the shared owner.
    shared_owner: Option<String>,
    /// Pair renames of the stored folder/owner values, applied to the database in one
    /// transaction after the config is written.
    renames: Option<Vec<Rename>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Rename {
    list: RenameList,
    from: String,
    to: String,
}

#[derive(Deserialize, PartialEq, Clone, Copy)]
#[serde(rename_all = "snake_case")]
enum RenameList {
    Folders,
    Owners,
}

pub fn show(config: &Config, json: bool) -> anyhow::Result<()> {
    if !json {
        return Err(anyhow!(
            "filing show: pass --json (this command prints the filing lists for machines only)"
        ));
    }
    let report = collect_show(config);
    println!("{}", serde_json::to_string(&report)?);
    Ok(())
}

pub fn save(config: &Config, path: &Path, check: bool) -> anyhow::Result<()> {
    let stdin: String =
        io::read_to_string(io::stdin()).context("cannot read the filing draft from stdin")?;
    let draft: Draft = serde_json::from_str(stdin.as_str()).context(
        "filing save: stdin must be one JSON object {\"folders\": [...], \"owners\": [...]} with optional \"shared_owner\": \"...\" and \"renames\": [{\"list\": \"folders\"|\"owners\", \"from\": \"...\", \"to\": \"...\"}]",
    )?;
    let report = save_report(config, path, &draft, check)?;
    println!("{}", serde_json::to_string(&report)?);
    Ok(())
}

fn collect_show(config: &Config) -> ShowReport {
    ShowReport {
        version: 1,
        folders: config.classify.folders.clone(),
        owners: config.classify.owners.clone(),
        shared_owner: config.classify.shared_owner.clone(),
    }
}

fn save_report(
    config: &Config,
    path: &Path,
    draft: &Draft,
    check: bool,
) -> anyhow::Result<SaveReport> {
    // What the shared owner will be after this save: the draft's rename if present.
    let shared: String = draft
        .shared_owner
        .clone()
        .unwrap_or(config.classify.shared_owner.clone());
    let mut errors: Vec<Error> = check_names(&draft.folders, &draft.owners, shared.clone())
        .iter()
        .map(|issue| error_row(issue.clone()))
        .collect();
    errors.extend(rename_issues(draft));
    if !errors.is_empty() {
        return Ok(SaveReport {
            version: 1,
            ok: false,
            saved: false,
            renamed: 0,
            folders: draft.folders.clone(),
            owners: draft.owners.clone(),
            errors,
        });
    }

    // Config first: the lists, plus the shared owner only when the draft renames it to a
    // different value than what is in effect now.
    let shared_change: Option<String> = if shared != config.classify.shared_owner {
        Some(shared.clone())
    } else {
        None
    };
    let saved: bool = if check {
        false
    } else {
        config_edit::write_lists(
            path,
            &draft.folders,
            &draft.owners,
            shared_change.as_deref(),
        )?
    };

    // Then the database, only if renames were asked for and a database exists (a rename on a
    // fresh library is simply nothing done yet).
    let wants_renames: bool = if let Some(pairs) = &draft.renames {
        !pairs.is_empty()
    } else {
        false
    };
    let renamed: usize =
        if !check && wants_renames && std::fs::exists(&config.paths.db).unwrap_or(false) {
            let mut conn = db::open(&config.paths.db)?;
            let pairs: Vec<(db::Column, String, String)> = all_renames(draft)
                .iter()
                .map(|r| (to_column(r.list), r.from.to_string(), r.to.to_string()))
                .collect();
            db::rename(&mut conn, &pairs)?
        } else {
            0
        };

    Ok(SaveReport {
        version: 1,
        ok: true,
        saved,
        renamed,
        folders: draft.folders.clone(),
        owners: draft.owners.clone(),
        errors: Vec::new(),
    })
}

/// Validates the draft's renames against the draft's own NEW lists, returning the problems as
/// error rows (index null: the problem is about a rename as a whole, not one list position).
/// Rules: both names safe path segments; `from` is NOT in the new list (it is being replaced);
/// `to` IS in it; and within one column no two renames share a `from`, a `to`, or chain
/// (`a`->`b` and `b`->`c`) - the UPDATEs run in one transaction in list order, and a chain
/// would silently move `a` to `c`.
fn rename_issues(draft: &Draft) -> Vec<Error> {
    let mut issues: Vec<Error> = Vec::new();
    for (list, names) in [
        (RenameList::Folders, &draft.folders),
        (RenameList::Owners, &draft.owners),
    ] {
        let in_list: HashSet<String> = names.iter().map(|n| n.to_lowercase().to_string()).collect();
        let mut froms: HashSet<String> = HashSet::new();
        let mut tos: HashSet<String> = HashSet::new();
        for rename in renames_of(draft, list).iter() {
            let from: String = rename.from.to_string();
            let to: String = rename.to.to_string();
            let key: String = from.to_lowercase().to_string();
            let target: String = to.to_lowercase().to_string();
            if !classify::safe_folder(from.as_str()) || !classify::safe_folder(to.as_str()) {
                issues.push(rename_error(
                    list,
                    Code::InvalidName,
                    from.as_str(),
                    to.as_str(),
                ));
                continue;
            }
            let conflicts: bool =
                froms.contains(&key[..]) || tos.contains(&target[..]) || tos.contains(&key[..]);
            if conflicts {
                issues.push(rename_error(
                    list,
                    Code::RenameConflict,
                    from.as_str(),
                    to.as_str(),
                ));
            }
            froms.insert(key.clone());
            tos.insert(target.clone());
            if in_list.contains(&key[..]) {
                issues.push(rename_error(
                    list,
                    Code::RenameFromNotInList,
                    from.as_str(),
                    to.as_str(),
                ));
            }
            if !in_list.contains(&target[..]) {
                issues.push(rename_error(
                    list,
                    Code::RenameToNotInList,
                    from.as_str(),
                    to.as_str(),
                ));
            }
        }
    }
    issues
}

/// One rename problem as an error row.
fn rename_error(list: RenameList, code: Code, from: &str, to: &str) -> Error {
    let message: String = rename_message(code.clone(), from.to_string(), to.to_string());
    Error {
        list: rename_list_to_list(list),
        index: None,
        name: Some(from.to_string()),
        message,
        code,
    }
}

/// The draft's renames for one column.
fn renames_of(draft: &Draft, list: RenameList) -> Vec<&Rename> {
    draft
        .renames
        .iter()
        .flat_map(|renames| renames.iter())
        .filter(|r| r.list == list)
        .collect()
}

/// The draft's renames for both columns.
fn all_renames(draft: &Draft) -> Vec<&Rename> {
    draft
        .renames
        .iter()
        .flat_map(|renames| renames.iter())
        .collect()
}

fn to_column(list: RenameList) -> db::Column {
    match list {
        RenameList::Folders => db::Column::Folder,
        RenameList::Owners => db::Column::Owner,
    }
}

fn rename_list_to_list(list: RenameList) -> List {
    match list {
        RenameList::Folders => List::Folders,
        RenameList::Owners => List::Owners,
    }
}

/// A rename message: the two names are synthetic-or-user data, and both are already known
/// safe (or reported unsafe by the check that produced this row), so quoting them is fine.
fn rename_message(code: Code, from: String, to: String) -> String {
    match code {
        Code::InvalidName => {
            format!("\"{from}\" and \"{to}\" must each be one safe path segment")
                .to_string()
        }
        Code::RenameConflict => {
            format!(
                "\"{from}\" -> \"{to}\" conflicts with another rename: a name may be renamed once"
            ).to_string()
        }
        Code::RenameFromNotInList => {
            format!("\"{from}\" is still in the saved list, so it is not being renamed away")
                .to_string()
        }
        Code::RenameToNotInList => {
            format!("\"{to}\" is not in the saved list, so rows would be renamed to a name that no longer exists")
                .to_string()
        }
        Code::EmptyList => "the list must not be empty".to_string(),
        Code::Duplicate => "the name is used twice in this list".to_string(),
    }
}

fn error_row(issue: NameIssue) -> Error {
    let (list, index, name, code) = (issue.list, issue.index, issue.name, issue.code);
    let message: String = issue_message(code.clone());
    Error {
        list: to_list(list),
        index,
        name,
        code: to_code(code),
        message,
    }
}

fn to_list(list: NameList) -> List {
    match list {
        NameList::Folders => List::Folders,
        NameList::Owners => List::Owners,
        NameList::Shared => List::SharedOwner,
    }
}

fn to_code(code: NameCode) -> Code {
    match code {
        NameCode::EmptyList => Code::EmptyList,
        NameCode::InvalidName => Code::InvalidName,
        NameCode::Duplicate => Code::Duplicate,
    }
}

fn issue_message(code: NameCode) -> String {
    match code {
        NameCode::EmptyList => "the folders list must not be empty".to_string(),
        NameCode::InvalidName => {
            "the name must be one safe path segment, and an owner may not be the shared owner"
                .to_string()
        }
        NameCode::Duplicate => "the name is used twice in this list".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use super::*;

    fn lock(name: String, actual: String) {
        let path: PathBuf = PathBuf::from("testdata/desktop".to_string()).join(name.as_str());
        if std::env::var("LOCK_FIXTURES")
            .map(|v| v == "1")
            .unwrap_or(false)
        {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(&path, actual.as_str()).unwrap();
            return;
        }
        let want: String = fs::read_to_string(path.as_os_str()).unwrap();
        assert_eq!(
            actual,
            want.as_str(),
            "JSON shape changed (or the fixture is stale)"
        );
    }

    fn synthetic_config() -> Config {
        let mut config = Config::default();
        config.classify.folders = vec![
            "Identity".to_string(),
            "Finance".to_string(),
            "Other".to_string(),
        ];
        config.classify.owners = vec!["Alex Example".to_string(), "Sam Example".to_string()];
        config.classify.shared_owner = "Shared".to_string();
        config
    }

    /// A rename row for a test draft.
    fn rename(list: &str, from: &str, to: &str) -> Rename {
        let column: RenameList = match list {
            "folders" => RenameList::Folders,
            "owners" => RenameList::Owners,
            _ => panic!("unknown rename list"),
        };
        Rename {
            list: column,
            from: from.to_string(),
            to: to.to_string(),
        }
    }

    #[test]
    fn show_fixture_locks_effective_lists() {
        let config = synthetic_config();
        let report = collect_show(&config);
        lock(
            "filing.json".to_string(),
            serde_json::to_string(&report).unwrap(),
        );
    }

    #[test]
    fn save_check_reports_errors_without_writing() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("config.toml");
        fs::write(&file, "[classify]\nowners = [\"Alex Example\"]\n").unwrap();
        let before: String = fs::read_to_string(file.as_os_str()).unwrap();

        let config = synthetic_config();
        let draft = Draft {
            folders: vec!["../up".to_string(), "Home".to_string(), "home".to_string()],
            owners: vec!["Shared".to_string()],
            shared_owner: None,
            renames: None,
        };
        let report = save_report(&config, &file, &draft, true).unwrap();
        lock(
            "filing-errors.json".to_string(),
            serde_json::to_string(&report).unwrap(),
        );
        assert!(!report.ok);
        assert!(!report.saved);
        assert_eq!(fs::read_to_string(file.as_os_str()).unwrap(), before);
    }

    #[test]
    fn save_renames_are_validated_against_the_draft() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("config.toml");
        fs::write(
            &file,
            "[classify]\nfolders = [\"Home\"]\nowners = [\"Alex Example\"]\n",
        )
        .unwrap();
        let before: String = fs::read_to_string(file.as_os_str()).unwrap();

        let config = synthetic_config();
        // `Old` -> `Home`: `Home` is in the new list but so is `Old`, so nothing is being renamed
        // away. And `Gone` is a target nobody chose.
        let draft = Draft {
            folders: vec!["Home".to_string(), "Old".to_string()],
            owners: vec!["Alex Example".to_string()],
            shared_owner: None,
            renames: Some(vec![
                rename("folders", "Old", "Home"),
                rename("folders", "Home", "Gone"),
            ]),
        };
        let report = save_report(&config, &file, &draft, false).unwrap();
        lock(
            "filing-rename-errors.json".to_string(),
            serde_json::to_string(&report).unwrap(),
        );
        assert!(!report.ok);
        assert!(!report.saved);
        assert_eq!(report.renamed, 0);
        assert_eq!(fs::read_to_string(file.as_os_str()).unwrap(), before);
    }

    #[test]
    fn save_renames_shared_owner_writes_config_then_rows() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("config.toml");
        fs::write(
            &file,
            "[classify]\nfolders = [\"Home\"]\nowners = [\"Old Owner\"]\nshared_owner = \"Old Shared\"\n",
        )
            .unwrap();

        let mut config = synthetic_config();
        config.paths.db = dir.path().join("data.db");
        let conn = db::open(&config.paths.db).unwrap();
        db::put(
            &conn,
            &db::Doc {
                hash: "a1".to_string(),
                path: "scans/scan.pdf".to_string(),
                meta: db::Meta {
                    title: None,
                    doc_type: "invoice".to_string(),
                    date: None,
                    people: Vec::new(),
                    issuer: None,
                    folder: None,
                    owner: Some("Old Owner".to_string()),
                    matter: None,
                },
            },
        )
        .unwrap();
        drop(conn);

        let draft = Draft {
            folders: vec!["Home".to_string()],
            owners: vec!["Alex Example".to_string()],
            shared_owner: Some("Everyone".to_string()),
            renames: Some(vec![rename("owners", "Old Owner", "Alex Example")]),
        };
        let report = save_report(&config, &file, &draft, false).unwrap();
        assert!(report.ok);
        assert!(report.saved);
        assert_eq!(
            report.renamed, 1,
            "the stored row follows the renamed owner"
        );
        let after: String = fs::read_to_string(file.as_os_str()).unwrap();
        assert!(after.contains("shared_owner = \"Everyone\""));
        assert!(!after.contains("Old Owner"));
        let rows = db::all(&db::open(&config.paths.db).unwrap()).unwrap();
        assert_eq!(
            rows.first().unwrap().meta.owner,
            Some("Alex Example".to_string())
        );

        // Repeating the same save: nothing to write, the UPDATE matches nothing, still ok.
        let second = save_report(&config, &file, &draft, false).unwrap();
        assert!(second.ok);
        assert!(!second.saved);
        assert_eq!(second.renamed, 0);
        assert_eq!(fs::read_to_string(file.as_os_str()).unwrap(), after);
    }

    #[test]
    fn check_renames_write_nothing_at_all() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("config.toml");
        fs::write(
            &file,
            "[classify]\nfolders = [\"Home\"]\nowners = [\"Old Owner\"]\n",
        )
        .unwrap();
        let before: String = fs::read_to_string(file.as_os_str()).unwrap();

        let mut config = synthetic_config();
        config.paths.db = dir.path().join("data.db");
        let conn = db::open(&config.paths.db).unwrap();
        db::put(
            &conn,
            &db::Doc {
                hash: "b2".to_string(),
                path: "letters/letter.pdf".to_string(),
                meta: db::Meta {
                    title: None,
                    doc_type: "letter".to_string(),
                    date: None,
                    people: Vec::new(),
                    issuer: None,
                    folder: None,
                    owner: Some("Old Owner".to_string()),
                    matter: None,
                },
            },
        )
        .unwrap();
        drop(conn);

        let draft = Draft {
            folders: vec!["Home".to_string()],
            owners: vec!["Alex Example".to_string()],
            shared_owner: None,
            renames: Some(vec![rename("owners", "Old Owner", "Alex Example")]),
        };
        let report = save_report(&config, &file, &draft, true).unwrap();
        assert!(report.ok);
        assert!(!report.saved);
        assert_eq!(report.renamed, 0, "--check writes neither config nor rows");
        assert_eq!(fs::read_to_string(file.as_os_str()).unwrap(), before);
        let rows = db::all(&db::open(&config.paths.db).unwrap()).unwrap();
        assert_eq!(
            rows.first().unwrap().meta.owner,
            Some("Old Owner".to_string())
        );
    }

    #[test]
    fn save_valid_draft_writes_then_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("config.toml");
        fs::write(&file, "[classify]\n# keep me\n").unwrap();

        let config = synthetic_config();
        let draft = Draft {
            folders: vec!["Home".to_string()],
            owners: vec!["Alex Example".to_string()],
            shared_owner: None,
            renames: None,
        };
        let first = save_report(&config, &file, &draft, false).unwrap();
        assert!(first.ok);
        assert!(first.saved);
        let after_first: String = fs::read_to_string(file.as_os_str()).unwrap();
        assert!(after_first.contains("# keep me"));

        let second = save_report(&config, &file, &draft, false).unwrap();
        assert!(second.ok);
        assert!(!second.saved);
        assert_eq!(fs::read_to_string(file.as_os_str()).unwrap(), after_first);
    }
}
