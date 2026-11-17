//! The `organize --json` contract as spoken by the real binary: with --json, stdout is exactly
//! one JSON object and exit is 0 even for expected states (`no_database` here). `--json` alone
//! fails before anything runs, with nothing on stdout. Synthetic config in a tempdir; no
//! database exists, which is data, not an error.

use serde_json::Value;

#[test]
fn dry_run_json_prints_exactly_one_object() {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("config.toml");
    let entry = |name: &str| -> String {
        format!(
            "{name} = \"{value}\"\n",
            value = dir.path().join(name).to_string_lossy()
        )
    };
    std::fs::write(
        &config,
        format!(
            "[paths]\n{db}{docs}{ocr}{lib}",
            db = entry("db"),
            docs = entry("docs_dir"),
            ocr = entry("ocr_dir"),
            lib = entry("library_dir")
        ),
    )
    .unwrap();

    let out = std::process::Command::new(env!("CARGO_BIN_EXE_lets-rag-docs"))
        .args(&[
            "--config".to_string(),
            config.to_string_lossy().to_string(),
            "organize".to_string(),
            "--dry-run".to_string(),
            "--json".to_string(),
        ])
        .output()
        .unwrap();
    assert!(out.status.code() == Some(0), "expected states exit 0");
    let raw: String = String::from_utf8(out.stdout).unwrap();
    let text: String = raw.trim().to_string();
    assert_eq!(
        text.lines().count(),
        1,
        "stdout must hold only the report object"
    );
    let report: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(report["version"].as_i64(), Some(1));
    assert_eq!(report["mode"].as_str().unwrap(), "dry_run");
    assert_eq!(report["status"].as_str().unwrap(), "no_database");
    assert_eq!(report["items"].as_array().unwrap().len(), 0);
    assert!(report["counts"]["would_copy"].is_number());
    // Nothing was created by a --dry-run.
    assert!(!std::fs::exists(dir.path().join("documents.sqlite")).unwrap_or(false));
    assert!(!std::fs::exists(dir.path().join("library")).unwrap_or(false));
}

#[test]
fn json_without_a_mode_fails_with_empty_stdout() {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("config.toml");
    std::fs::write(&config, "[paths]\n").unwrap();

    let out = std::process::Command::new(env!("CARGO_BIN_EXE_lets-rag-docs"))
        .args(&[
            "--config".to_string(),
            config.to_string_lossy().to_string(),
            "organize".to_string(),
            "--json".to_string(),
        ])
        .output()
        .unwrap();
    assert!(
        out.status.code() != Some(0),
        "exactly one of --dry-run or --apply is required"
    );
    let stdout: String = String::from_utf8(out.stdout).unwrap();
    assert!(
        stdout.trim().is_empty(),
        "a usage failure prints nothing on stdout"
    );
}
