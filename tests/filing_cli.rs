//! The `filing` contract as spoken by the real binary: `show --json` prints exactly one JSON
//! object, `save` reads its draft from stdin (never argv), expected validation states exit 0,
//! and `--check` leaves `config.toml` untouched. Synthetic config in a tempdir; no paths are
//! opened beyond the config file being edited.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde_json::Value;

fn input_path(dir: &Path, input: String) -> PathBuf {
    let path: PathBuf = dir.join("stdin.json");
    std::fs::write(&path, input.as_str()).unwrap();
    path
}

fn args_for_config(config: &Path, extra: &[String]) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "--config".to_string(),
        config.to_string_lossy().to_string(),
        "filing".to_string(),
    ];
    args.extend(extra.to_vec());
    args
}

#[test]
fn show_json_prints_exactly_one_object() {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("config.toml");
    std::fs::write(
        &config,
        "[classify]\nfolders = [\"Home\", \"Work\"]\nowners = [\"Alex Example\", \"Sam Example\"]\nshared_owner = \"Shared\"\n",
    ).unwrap();

    let input = input_path(dir.path(), String::new());
    let args = args_for_config(&config, &["show".to_string(), "--json".to_string()]);
    let out = Command::new(env!("CARGO_BIN_EXE_lets-rag-docs"))
        .args(&args)
        .stdin(Stdio::from(std::fs::File::open(input.as_os_str()).unwrap()))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .unwrap();
    assert_eq!(
        out.status.code(),
        Some(0),
        "a read-only filing command is expected data"
    );

    let raw: String = String::from_utf8(out.stdout).unwrap();
    let text: String = raw.trim().to_string();
    assert_eq!(
        text.lines().count(),
        1,
        "stdout must hold only the report object"
    );
    let report: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(report["version"].as_i64(), Some(1));
    assert_eq!(report["folders"].as_array().unwrap().len(), 2);
    assert_eq!(report["folders"][0].as_str().unwrap(), "Home");
    assert_eq!(report["folders"][1].as_str().unwrap(), "Work");
    assert_eq!(report["owners"].as_array().unwrap().len(), 2);
    assert_eq!(report["owners"][0].as_str().unwrap(), "Alex Example");
    assert_eq!(report["owners"][1].as_str().unwrap(), "Sam Example");
    assert_eq!(report["shared_owner"].as_str().unwrap(), "Shared");
}

#[test]
fn show_without_json_fails_with_empty_stdout() {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("config.toml");
    std::fs::write(&config, "[classify]\n").unwrap();

    let input = input_path(dir.path(), String::new());
    let args = args_for_config(&config, &["show".to_string()]);
    let out = Command::new(env!("CARGO_BIN_EXE_lets-rag-docs"))
        .args(&args)
        .stdin(Stdio::from(std::fs::File::open(input.as_os_str()).unwrap()))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .unwrap();
    assert!(out.status.code() != Some(0), "filing show requires --json");
    let stdout: String = String::from_utf8(out.stdout).unwrap();
    assert!(
        stdout.trim().is_empty(),
        "a usage failure prints nothing on stdout"
    );
}

#[test]
fn save_check_reports_errors_without_writing() {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("config.toml");
    std::fs::write(
        &config,
        "[classify]\nfolders = [\"Home\"]\nowners = [\"Alex Example\"]\nshared_owner = \"Shared\"\n",
    ).unwrap();
    let before: String = std::fs::read_to_string(config.as_os_str()).unwrap();

    let draft: String = "{\"folders\": [], \"owners\": [\"Alex Example\"]}".to_string();
    let input = input_path(dir.path(), draft);
    let args = args_for_config(&config, &["save".to_string(), "--check".to_string()]);
    let out = Command::new(env!("CARGO_BIN_EXE_lets-rag-docs"))
        .args(&args)
        .stdin(Stdio::from(std::fs::File::open(input.as_os_str()).unwrap()))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .unwrap();
    assert_eq!(
        out.status.code(),
        Some(0),
        "an invalid draft is data, not a process failure"
    );

    let raw: String = String::from_utf8(out.stdout).unwrap();
    let text: String = raw.trim().to_string();
    assert_eq!(
        text.lines().count(),
        1,
        "stdout must hold only the report object"
    );
    let report: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(report["version"].as_i64(), Some(1));
    assert!(!report["ok"].as_bool().unwrap());
    assert!(!report["saved"].as_bool().unwrap());
    assert!(!report["errors"].as_array().unwrap().is_empty());
    assert_eq!(std::fs::read_to_string(config.as_os_str()).unwrap(), before);
}

#[test]
fn save_bad_json_fails_with_empty_stdout() {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("config.toml");
    std::fs::write(&config, "[classify]\n").unwrap();
    let before: String = std::fs::read_to_string(config.as_os_str()).unwrap();

    let draft: String = "{\"folders\": []}".to_string();
    let input = input_path(dir.path(), draft);
    let args = args_for_config(&config, &["save".to_string(), "--check".to_string()]);
    let out = Command::new(env!("CARGO_BIN_EXE_lets-rag-docs"))
        .args(&args)
        .stdin(Stdio::from(std::fs::File::open(input.as_os_str()).unwrap()))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .unwrap();
    assert!(
        out.status.code() != Some(0),
        "bad JSON on stdin is a real input error"
    );

    let stdout: String = String::from_utf8(out.stdout).unwrap();
    assert!(
        stdout.trim().is_empty(),
        "a real failure prints no report on stdout"
    );
    assert!(!String::from_utf8(out.stderr).unwrap().trim().is_empty());
    assert_eq!(std::fs::read_to_string(config.as_os_str()).unwrap(), before);
}

#[test]
fn save_valid_draft_writes_then_is_idempotent() {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("config.toml");
    std::fs::write(&config, "[classify]\n# keep me\n").unwrap();

    let draft: String = "{\"folders\": [\"Home\"], \"owners\": [\"Alex Example\"]}".to_string();
    let args = args_for_config(&config, &["save".to_string()]);
    let first_input = input_path(dir.path(), draft.clone());
    let first = Command::new(env!("CARGO_BIN_EXE_lets-rag-docs"))
        .args(&args)
        .stdin(Stdio::from(
            std::fs::File::open(first_input.as_os_str()).unwrap(),
        ))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .unwrap();
    assert_eq!(first.status.code(), Some(0));
    let first_text: String = String::from_utf8(first.stdout).unwrap().trim().to_string();
    assert_eq!(first_text.lines().count(), 1);
    let first_report: Value = serde_json::from_str(&first_text).unwrap();
    assert!(first_report["ok"].as_bool().unwrap());
    assert!(first_report["saved"].as_bool().unwrap());

    let after_first: String = std::fs::read_to_string(config.as_os_str()).unwrap();
    assert!(after_first.contains("# keep me"));
    assert!(after_first.contains("folders = ["));
    assert!(after_first.contains("\"Home\""));
    assert!(after_first.contains("owners = ["));
    assert!(after_first.contains("\"Alex Example\""));

    let second_input = input_path(dir.path(), draft);
    let second = Command::new(env!("CARGO_BIN_EXE_lets-rag-docs"))
        .args(&args)
        .stdin(Stdio::from(
            std::fs::File::open(second_input.as_os_str()).unwrap(),
        ))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .unwrap();
    assert_eq!(second.status.code(), Some(0));
    let second_text: String = String::from_utf8(second.stdout).unwrap().trim().to_string();
    assert_eq!(second_text.lines().count(), 1);
    let second_report: Value = serde_json::from_str(&second_text).unwrap();
    assert!(second_report["ok"].as_bool().unwrap());
    assert!(!second_report["saved"].as_bool().unwrap());
    assert_eq!(
        std::fs::read_to_string(config.as_os_str()).unwrap(),
        after_first
    );
}
