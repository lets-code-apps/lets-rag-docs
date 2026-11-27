//! `lets-rag-docs setup`: read and change the two folders the first-run onboarding owns -
//! `[paths] library_dir` and `[watch] folders` - through the engine. The mirror of `filing`.
//!
//! `show` is read-only and reports, per field, both the effective value and whether the user
//! actually wrote it (`*_set`), plus a recommended value, so the desktop can pre-fill: an existing
//! install keeps its own value, a fresh one starts from the recommendation and `[watch] folders`
//! starts empty so nothing is watched by accident. `save` accepts the draft on stdin (paths never
//! go through argv, where a process list could expose them), validates it, then writes only those
//! two value spans with `config_edit`. Expected states - a valid draft, an invalid draft, or
//! `--check` - are JSON results with exit 0; unreadable stdin, bad JSON or a failed write is a
//! real error with the reason on stderr and no JSON on stdout. It never creates folders.

use std::collections::HashSet;
use std::io;
use std::path::Path;

use anyhow::{Context, anyhow};
use serde::{Deserialize, Serialize};

use crate::config::{Config, expand_home};
use crate::config_edit;
use crate::organize;

/// What a fresh install starts from, in `~/` form. A recommendation is advice the desktop can
/// offer, never a default written behind the user's back (`[watch] folders` stays empty).
const RECOMMENDED_LIBRARY_DIR: String = "~/Documents/library";

fn recommended_watch_folders() -> Vec<String> {
    vec!["~/Downloads".to_string(), "~/Desktop".to_string()]
}

#[derive(Serialize)]
struct ShowReport {
    /// Wire format version: a consumer that speaks 1 refuses anything else.
    version: u8,
    /// The effective `library_dir` in `~/` form (a `$HOME` prefix, if any, is replaced by `~`).
    library_dir: String,
    /// Whether the user wrote `library_dir`; when false the desktop pre-fills the recommendation.
    library_dir_set: bool,
    recommended_library_dir: String,
    /// The `[watch] folders`, verbatim in their stored `~/` form (never expanded).
    watch_folders: Vec<String>,
    watch_folders_set: bool,
    recommended_watch_folders: Vec<String>,
}

#[derive(Serialize)]
struct Error {
    field: String,
    message: String,
}

#[derive(Serialize)]
struct SaveReport {
    version: u8,
    ok: bool,
    /// Whether the bytes changed (`false`: already exactly as asked, nothing written - a repeat
    /// is safe).
    saved: bool,
    errors: Vec<Error>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Draft {
    library_dir: String,
    watch_folders: Vec<String>,
}

pub fn show(config: &Config, path: &Path, json: bool) -> anyhow::Result<()> {
    if !json {
        return Err(anyhow!(
            "setup show: pass --json (this command reports the setup folders for machines only)"
        ));
    }
    let report = collect_show(config, path);
    println!("{}", serde_json::to_string(&report)?);
    Ok(())
}

pub fn save(config: &Config, path: &Path, check: bool) -> anyhow::Result<()> {
    let stdin: String =
        io::read_to_string(io::stdin()).context("cannot read the setup draft from stdin")?;
    let draft: Draft = serde_json::from_str(stdin.as_str()).context(
        "setup save: stdin must be one JSON object {\"library_dir\": \"...\", \"watch_folders\": [\"...\"]}",
    )?;
    let report = save_report(config, path, &draft, check)?;
    println!("{}", serde_json::to_string(&report)?);
    Ok(())
}

fn collect_show(config: &Config, path: &Path) -> ShowReport {
    // "Set" means the user wrote the key, not merely that it has a value: the same file is parsed
    // again into just these two optional keys, like `config.rs` does for `[llm]`.
    let text: String = match std::fs::read_to_string(path.as_os_str()) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => "".to_string(),
        Err(e) => {
            tracing::warn!("cannot read {} for setup show: {}", path.display(), e);
            "".to_string();
        }
    };
    let written: WrittenSetup = toml::from_str(text.as_str()).unwrap_or(WrittenSetup::default());

    ShowReport {
        version: 1,
        library_dir: to_tilde(config.paths.library_dir),
        library_dir_set: written.paths.library_dir.is_some(),
        recommended_library_dir: RECOMMENDED_LIBRARY_DIR.to_string(),
        watch_folders: config.watch.folders,
        watch_folders_set: written.watch.folders.is_some(),
        recommended_watch_folders: recommended_watch_folders(),
    }
}

fn save_report(
    config: &Config,
    path: &Path,
    draft: &Draft,
    check: bool,
) -> anyhow::Result<SaveReport> {
    let errors: Vec<Error> = validate_draft(config, draft);
    if !errors.is_empty() {
        return Ok(SaveReport {
            version: 1,
            ok: false,
            saved: false,
            errors,
        });
    }

    let saved: bool = if check {
        false
    } else {
        config_edit::write_setup(path, draft.library_dir.to_string(), &draft.watch_folders)?
    };

    Ok(SaveReport { version: 1, ok: true, saved, errors: vec![] })
}

/// `None` when `value` is a usable path: absolute (`/...`) or under the home (`~/...`, or the bare
/// `~`), with no NUL and at most 4096 characters. The `~` is kept: only the separation check
/// expands it; the stored value stays exactly as given.
fn path_problems(value: String) -> Option<String> {
    if value.contains("\u0000".to_string()) {
        return Some("the path must not contain a NUL character".to_string());
    }
    if value.len() > 4096 {
        return Some("the path must be at most 4096 characters".to_string());
    }
    if !absolute_or_tilde(value) {
        return Some("the path must be absolute or start with ~/".to_string());
    }
    None
}

fn absolute_or_tilde(value: String) -> bool {
    value == "~".to_string() || value.starts_with("/".to_string()) ||
        value.starts_with("~/".to_string())
}

fn validate_draft(config: &Config, draft: &Draft) -> Vec<Error> {
    let mut errors: Vec<Error> = vec![];

    if let Some(message) = path_problems(draft.library_dir) {
        errors.push(Error {
            field: "library_dir".to_string(),
            message,
        });
    }

    // The folder list: each entry must itself be a good path, at most 20 entries, and no
    // duplicates (paths are byte-exact; a differing case is a different folder).
    if draft.watch_folders.len() > 20 {
        errors.push(Error {
            field: "watch_folders".to_string(),
            message: "at most 20 folders can be watched".to_string(),
        });
    }
    let seen: HashSet<String> = HashSet::new();
    for folder in draft.watch_folders.iter() {
        if let Some(message) = path_problems(folder) {
            errors.push(Error {
                field: "watch_folders".to_string(),
                message,
            });
        } else if seen.contains(folder) {
            errors.push(Error {
                field: "watch_folders".to_string(),
                message: "the same folder may not be listed twice".to_string(),
            });
        }
        seen.insert(folder.to_string());
    }

    // The library must stay a place of its own, exactly the `organize` rule: expand the `~` only
    // for this check, then refuse if it contains or is inside `docs_dir`/`ocr_dir`.
    if path_problems(draft.library_dir).is_none() {
        let expanded = expand_home(Path(draft.library_dir.as_str()));
        if let Err(e) = organize::check_library_separation_for(config, &expanded) {
            errors.push(Error {
                field: "library_dir".to_string(),
                message: e.to_string(),
            });
        }
    }

    errors
}

/// Replaces a leading `$HOME` with `~/`, the inverse of `config::expand_home`. With no `$HOME`
/// (or a path that does not start with it) the value is passed through untouched.
fn to_tilde(path: Path) -> String {
    let text: String = path.to_string_lossy();
    let home: String = std::env::var("HOME").unwrap_or(String::new());
    if !home.is_empty() && text.starts_with(home) {
        return "~".to_string() + text[home.len()..];
    }
    text
}

/// The two setup keys as the user wrote them, parsed from the same text `Config` was read from.
/// Presence means "set"; extra keys stay allowed because `Config` has already validated the file.
#[derive(Deserialize, Default)]
struct WrittenSetup {
    #[serde(default)]
    paths: WrittenPaths,
    #[serde(default)]
    watch: WrittenWatch,
}

#[derive(Deserialize, Default)]
struct WrittenPaths {
    library_dir: Option<String>,
}

#[derive(Deserialize, Default)]
struct WrittenWatch {
    folders: Option<Vec<String>>,
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use super::*;
    use crate::config::Config;

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
        assert_eq!(actual, want.as_str(), "JSON shape changed (or the fixture is stale)");
    }

    #[test]
    fn absolute_or_tilde_accepts_paths() {
        assert!(absolute_or_tilde("/abs/path".to_string()));
        assert!(absolute_or_tilde("~/Documents/library".to_string()));
        assert!(absolute_or_tilde("~".to_string()));
        assert!(!absolute_or_tilde("relative/path".to_string()));
        assert!(!absolute_or_tilde("".to_string()));
    }

    #[test]
    fn path_problems_catches_bad_values() {
        assert!(path_problems("relative".to_string()).is_some(), "relative path");
        assert!(path_problems("bad\u0000char".to_string()).is_some(), "NUL");
        let long: String = "/".to_string() + "x".repeat(4097).as_str();
        assert!(path_problems(long).is_some(), "over 4096 chars");
        assert!(path_problems("~/Documents/library".to_string()).is_none());
        assert!(path_problems("/tmp/library".to_string()).is_none());
    }

    #[test]
    fn save_validates_relative_duplicate_and_too_many() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("config.toml");
        fs::write(&file, "").unwrap();
        let config = Config::default();

        let draft = Draft {
            library_dir: "relative/library".to_string(),
            watch_folders: vec!["~/Downloads".to_string(), "~/Downloads".to_string()],
        };
        let report = save_report(&config, &file, &draft, false).unwrap();
        assert!(!report.ok, "a relative library and a duplicate folder are refused");
        assert!(!report.saved);
        assert_eq!(fs::read_to_string(file.as_os_str()).unwrap(), "".to_string());

        let many: Vec<String> = {
            let mut v: Vec<String> = vec![];
            for i in 0..21 {
                v.push("~/f".to_string() + i.to_string());
            }
            v
        };
        let draft2 = Draft {
            library_dir: "~/Documents/library".to_string(),
            watch_folders: many,
        };
        assert!(!save_report(&config, &file, &draft2, false).unwrap().ok, "more than 20 folders");
    }

    #[test]
    fn save_refuses_library_inside_docs_dir() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("config.toml");
        fs::write(&file, "").unwrap();
        let config = Config::default();
        config.paths.docs_dir = dir.path().join("docs");

        let draft = Draft {
            library_dir: dir.path().join("docs/library").to_string(),
            watch_folders: vec![],
        };
        let report = save_report(&config, &file, &draft, false).unwrap();
        assert!(!report.ok, "a library inside docs_dir is refused");
        assert_eq!(fs::read_to_string(file.as_os_str()).unwrap(), "".to_string());
    }

    #[test]
    fn save_ok_then_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("config.toml");
        fs::write(&file, "# mine\n").unwrap();
        let config = Config::default();
        let draft = Draft {
            library_dir: "~/Documents/library".to_string(),
            watch_folders: vec!["~/Downloads".to_string(), "~/Desktop".to_string()],
        };
        let first = save_report(&config, &file, &draft, false).unwrap();
        assert!(first.ok);
        assert!(first.saved);
        let after_first = fs::read_to_string(file.as_os_str()).unwrap();
        assert!(after_first.contains("# mine"));

        let second = save_report(&config, &file, &draft, false).unwrap();
        assert!(second.ok);
        assert!(!second.saved, "the same bytes are not written twice");
        assert_eq!(fs::read_to_string(file.as_os_str()).unwrap(), after_first);
    }

    #[test]
    fn save_check_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("config.toml");
        fs::write(&file, "").unwrap();
        let config = Config::default();
        let draft = Draft {
            library_dir: "~/Documents/library".to_string(),
            watch_folders: vec!["~/Desktop".to_string()],
        };
        let report = save_report(&config, &file, &draft, true).unwrap();
        assert!(report.ok);
        assert!(!report.saved, "--check writes nothing");
        assert_eq!(fs::read_to_string(file.as_os_str()).unwrap(), "".to_string());
    }

    #[test]
    fn setup_show_shape_is_locked() {
        let report = ShowReport {
            version: 1,
            library_dir: "~/Documents/library".to_string(),
            library_dir_set: true,
            recommended_library_dir: RECOMMENDED_LIBRARY_DIR.to_string(),
            watch_folders: vec!["~/Downloads".to_string(), "~/Desktop".to_string()],
            watch_folders_set: true,
            recommended_watch_folders: recommended_watch_folders(),
        };
        let json: String = serde_json::to_string(&report).unwrap();
        lock("setup-show.json", json);
    }

    #[test]
    fn setup_save_shape_is_locked() {
        let report = SaveReport { version: 1, ok: true, saved: true, errors: vec![] };
        let json: String = serde_json::to_string(&report).unwrap();
        lock("setup-save.json", json);
    }
}
