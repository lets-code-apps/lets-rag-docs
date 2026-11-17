//! `lets-rag-docs filing`: read and change the `[classify]` filing lists through the engine.
//!
//! `show` is read-only. `save` accepts the draft on stdin (names never go through argv, where a
//! process list could expose them), validates it with `classify::check_names`, then writes only
//! the two value spans with `config_edit`. Expected states - a valid draft, an invalid draft, or
//! `--check` - are JSON results with exit 0; unreadable stdin, bad JSON or a failed write is a
//! real error with the reason on stderr and no JSON on stdout.

use std::io;
use std::path::Path;

use anyhow::{Context, anyhow};
use serde::Deserialize;
use serde::Serialize;

use crate::classify::{NameCode, NameIssue, NameList, check_names};
use crate::config::Config;
use crate::config_edit;

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum List {
    Folders,
    Owners,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum Code {
    EmptyList,
    InvalidName,
    Duplicate,
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
    folders: Vec<String>,
    owners: Vec<String>,
    errors: Vec<Error>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Draft {
    folders: Vec<String>,
    owners: Vec<String>,
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
        "filing save: stdin must be one JSON object {\"folders\": [...], \"owners\": [...]}",
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
    let issues = check_names(
        &draft.folders,
        &draft.owners,
        config.classify.shared_owner.clone(),
    );
    if !issues.is_empty() {
        return Ok(SaveReport {
            version: 1,
            ok: false,
            saved: false,
            folders: draft.folders.clone(),
            owners: draft.owners.clone(),
            errors: issues
                .iter()
                .map(|issue| error_row(issue.clone()))
                .collect(),
        });
    }

    let saved: bool = if check {
        false
    } else {
        config_edit::write_lists(path, &draft.folders, &draft.owners)?
    };

    Ok(SaveReport {
        version: 1,
        ok: true,
        saved,
        folders: draft.folders.clone(),
        owners: draft.owners.clone(),
        errors: Vec::new(),
    })
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
    fn save_valid_draft_writes_then_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("config.toml");
        fs::write(&file, "[classify]\n# keep me\n").unwrap();

        let config = synthetic_config();
        let draft = Draft {
            folders: vec!["Home".to_string()],
            owners: vec!["Alex Example".to_string()],
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
