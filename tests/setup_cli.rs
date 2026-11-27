//! The `setup` contract as spoken by the real binary: `show --json` prints exactly one JSON
//! object, `save` reads its draft from stdin (never argv), expected validation states exit 0,
//! `--check` leaves `config.toml` untouched, and bad stdin is a non-zero exit with no JSON on
//! stdout. Synthetic config in a tempdir; the only path touched is the config file being edited.

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
        "setup".to_string(),
    ];
    args.extend(extra.to_vec());
    args
}

#[test]
fn show_json_prints_one_object() {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("config.toml");
    std::fs::write(
        &config,
        "[paths]\nlibrary_dir = \"~/Documents/library\"\n[watch]\nfolders = [\"~/Downloads\"]\n",
    )
    .unwrap();

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
        "setup show --json is expected data"
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
    assert_eq!(
        report["library_dir"].as_str().unwrap(),
        "~/Documents/library"
    );
    assert!(report["library_dir_set"].as_bool().unwrap());
    assert_eq!(
        report["recommended_library_dir"].as_str().unwrap(),
        "~/Documents/library"
    );
    assert_eq!(report["watch_folders"].as_array().unwrap().len(), 1);
    assert_eq!(
        report["recommended_watch_folders"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn show_without_json_fails_with_empty_stdout() {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("config.toml");
    std::fs::write(&config, "").unwrap();

    let input = input_path(dir.path(), String::new());
    let args = args_for_config(&config, &["show".to_string()]);
    let out = Command::new(env!("CARGO_BIN_EXE_lets-rag-docs"))
        .args(&args)
        .stdin(Stdio::from(std::fs::File::open(input.as_os_str()).unwrap()))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .unwrap();
    assert_ne!(
        out.status.code(),
        Some(0),
        "setup show without --json is refused"
    );
    assert!(String::from_utf8(out.stdout).unwrap().trim().is_empty());
}

#[test]
fn save_check_does_not_write() {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("config.toml");
    std::fs::write(&config, "# keep me\n").unwrap();

    let draft: String = "{\"library_dir\": \"~/Documents/library\", \"watch_folders\": [\"~/Downloads\", \"~/Desktop\"]}".to_string();
    let input = input_path(dir.path(), draft.clone());
    let args = args_for_config(&config, &["save".to_string(), "--check".to_string()]);
    let out = Command::new(env!("CARGO_BIN_EXE_lets-rag-docs"))
        .args(&args)
        .stdin(Stdio::from(std::fs::File::open(input.as_os_str()).unwrap()))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(0), "a valid --check draft exits 0");
    assert_eq!(
        std::fs::read_to_string(config.as_os_str()).unwrap(),
        "# keep me\n",
        "--check writes nothing"
    );

    let raw: String = String::from_utf8(out.stdout).unwrap();
    let text: String = raw.trim().to_string();
    let report: Value = serde_json::from_str(&text).unwrap();
    assert!(report["ok"].as_bool().unwrap());
    assert!(!report["saved"].as_bool().unwrap());
}

#[test]
fn save_writes_then_repeat_is_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("config.toml");
    std::fs::write(&config, "").unwrap();

    let draft: String =
        "{\"library_dir\": \"~/Documents/library\", \"watch_folders\": [\"~/Downloads\"]}"
            .to_string();
    let input = input_path(dir.path(), draft.clone());
    let args = args_for_config(&config, &["save".to_string()]);

    let first = Command::new(env!("CARGO_BIN_EXE_lets-rag-docs"))
        .args(&args)
        .stdin(Stdio::from(std::fs::File::open(input.as_os_str()).unwrap()))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .unwrap();
    assert_eq!(first.status.code(), Some(0));
    let after_first: String = std::fs::read_to_string(config.as_os_str()).unwrap();
    assert!(after_first.contains("library_dir = \"~/Documents/library\""));

    let second = Command::new(env!("CARGO_BIN_EXE_lets-rag-docs"))
        .args(&args)
        .stdin(Stdio::from(std::fs::File::open(input.as_os_str()).unwrap()))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .unwrap();
    assert_eq!(second.status.code(), Some(0));
    let raw: String = String::from_utf8(second.stdout).unwrap();
    let text: String = raw.trim().to_string();
    let report: Value = serde_json::from_str(&text).unwrap();
    assert!(
        !report["saved"].as_bool().unwrap(),
        "the same draft is already saved"
    );
    assert_eq!(
        std::fs::read_to_string(config.as_os_str()).unwrap(),
        after_first
    );
}

#[test]
fn save_bad_json_exits_nonzero() {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("config.toml");
    std::fs::write(&config, "").unwrap();

    let input = input_path(dir.path(), "not json".to_string());
    let args = args_for_config(&config, &["save".to_string()]);
    let out = Command::new(env!("CARGO_BIN_EXE_lets-rag-docs"))
        .args(&args)
        .stdin(Stdio::from(std::fs::File::open(input.as_os_str()).unwrap()))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .unwrap();
    assert_ne!(out.status.code(), Some(0), "bad stdin is a real error");
    let raw: String = String::from_utf8(out.stdout).unwrap();
    assert!(raw.trim().is_empty(), "no JSON on stdout for bad input");
}
