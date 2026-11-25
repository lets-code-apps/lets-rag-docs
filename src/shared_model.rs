//! The model both Let's Code apps share: `~/.config/lets-code/model.toml` (see guide/MODEL.md).
//! Reading never fails (a bad file is an empty one); writing is atomic and validated.

use std::fs;
use std::io::{ErrorKind, Write};
use std::path::Path;

use anyhow::{Context, bail};
use serde::{Deserialize, Serialize};

/// Expand the `~` with the app's own `expand_home`.
pub const DEFAULT_PATH: &str = "~/.config/lets-code/model.toml";
#[allow(dead_code)] // used by onboarding and settings (LET-136, LET-137)
pub const RUNTIMES: [&str; 3] = ["ollama", "lmstudio", "custom"];
#[allow(dead_code)] // used by onboarding and settings (LET-136, LET-137)
pub const WRITERS: [&str; 2] = ["rag docs", "triage mail"];

/// All keys optional. No `deny_unknown_fields` (unlike the app configs): the other app may
/// grow keys, and that must not break this one.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct SharedModel {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub set_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated: Option<String>,
}

impl SharedModel {
    /// A blank value counts as missing.
    pub fn chat_model(&self) -> Option<&str> {
        self.model
            .as_deref()
            .map(str::trim)
            .filter(|model| !model.is_empty())
    }

    /// `url` plus `/v1`, unless it already ends in `/v1`. A blank value counts as missing.
    pub fn chat_base_url(&self) -> Option<String> {
        let url = self.url.as_deref()?.trim().trim_end_matches('/');
        if url.is_empty() {
            None
        } else if url.ends_with("/v1") {
            Some(url.to_string())
        } else {
            Some(format!("{url}/v1"))
        }
    }
}

/// A missing, unreadable or invalid file gives the empty value (the last two log a warning).
pub fn read(path: &Path) -> SharedModel {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == ErrorKind::NotFound => return SharedModel::default(),
        Err(e) => {
            tracing::warn!(
                "cannot read {name}: {e}; ignoring it",
                name = path.display()
            );
            return SharedModel::default();
        }
    };
    toml::from_str(&text).unwrap_or_else(|e| {
        tracing::warn!("invalid {name}: {e}; ignoring it", name = path.display());
        SharedModel::default()
    })
}

/// Temp file in the same folder, `sync_all`, then `rename` over the target: a reader sees the
/// old file or the new one, never half. Creates the folder. Validates first; nothing is
/// written on refusal. `updated` is the caller's RFC 3339 string. Replaces the whole file.
#[allow(dead_code)] // used by onboarding and settings (LET-136, LET-137)
pub fn write(path: &Path, model: &SharedModel) -> anyhow::Result<()> {
    validate(model)?;
    let text = toml::to_string(model).context("cannot serialise the model setting")?;
    let dir = path.parent().context("the model file path has no folder")?;
    fs::create_dir_all(dir).with_context(|| format!("cannot create {}", dir.display()))?;
    let tmp = dir.join(format!(".model.toml.{pid}.tmp", pid = std::process::id()));
    let result = write_synced(&tmp, &text).and_then(|_| fs::rename(&tmp, path));
    if let Err(e) = result {
        let _ = fs::remove_file(&tmp);
        return Err(e).with_context(|| format!("cannot write {}", path.display()));
    }
    Ok(())
}

#[allow(dead_code)] // used by onboarding and settings (LET-136, LET-137)
fn write_synced(path: &Path, text: &str) -> std::io::Result<()> {
    let mut file = fs::File::create(path)?;
    file.write_all(text.as_bytes())?;
    file.sync_all()
}

#[allow(dead_code)] // used by onboarding and settings (LET-136, LET-137)
fn validate(model: &SharedModel) -> anyhow::Result<()> {
    if !RUNTIMES.contains(&model.runtime.as_deref().unwrap_or("")) {
        bail!("runtime must be one of {RUNTIMES:?}");
    }
    if !WRITERS.contains(&model.set_by.as_deref().unwrap_or("")) {
        bail!("set_by must be one of {WRITERS:?}");
    }
    let Some(url) = model.chat_base_url() else {
        bail!("url must not be empty");
    };
    if url.contains('@') {
        bail!("url must not contain credentials");
    }
    if model.chat_model().is_none() {
        bail!("model must not be empty");
    }
    if model
        .updated
        .as_deref()
        .is_none_or(|updated| updated.trim().is_empty())
    {
        bail!("updated must be an RFC 3339 timestamp");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    use tempfile::tempdir;

    fn full() -> SharedModel {
        SharedModel {
            runtime: Some("ollama".to_string()),
            url: Some("http://127.0.0.1:11434".to_string()),
            model: Some("qwen3:8b".to_string()),
            set_by: Some("rag docs".to_string()),
            updated: Some("2026-11-25T09:00:00+01:00".to_string()),
        }
    }

    fn model_with(url: Option<String>) -> SharedModel {
        SharedModel {
            runtime: None,
            url,
            model: None,
            set_by: None,
            updated: None,
        }
    }

    #[test]
    fn missing_file_reads_as_empty() {
        let model = read(Path::new("/nonexistent/lets-code/model.toml"));
        assert_eq!(model, SharedModel::default());
    }

    #[test]
    fn missing_key_reads_as_none() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("model.toml");
        fs::write(&path, "model = \"qwen3:8b\"\n").unwrap();
        let model = read(&path);
        assert_eq!(model.chat_model(), Some("qwen3:8b"));
        assert_eq!(model.chat_base_url(), None);
    }

    #[test]
    fn unknown_keys_are_ignored() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("model.toml");
        let toml_text = "model = \"qwen3:8b\"\nfuture_key = 1\n\n[extra]\nanything = true\n";
        fs::write(&path, toml_text).unwrap();
        let model = read(&path);
        assert_eq!(model.chat_model(), Some("qwen3:8b"));
    }

    #[test]
    fn invalid_toml_reads_as_empty() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("model.toml");
        fs::write(&path, "model = = =\n").unwrap();
        assert_eq!(read(&path), SharedModel::default());
    }

    #[test]
    fn blank_values_count_as_missing() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("model.toml");
        fs::write(&path, "url = \"  \"\nmodel = \"\"\n").unwrap();
        let model = read(&path);
        assert_eq!(model.chat_base_url(), None);
        assert_eq!(model.chat_model(), None);
    }

    #[test]
    fn base_url_gets_v1_once() {
        assert_eq!(
            model_with(Some("http://127.0.0.1:11434".to_string())).chat_base_url(),
            Some("http://127.0.0.1:11434/v1".to_string())
        );
        assert_eq!(
            model_with(Some("http://127.0.0.1:11434/".to_string())).chat_base_url(),
            Some("http://127.0.0.1:11434/v1".to_string())
        );
        assert_eq!(
            model_with(Some("http://127.0.0.1:11434/v1".to_string())).chat_base_url(),
            Some("http://127.0.0.1:11434/v1".to_string())
        );
    }

    #[test]
    fn write_round_trips_and_leaves_no_temp_file() {
        let dir = tempdir().unwrap();
        // A folder that does not exist yet: write creates it.
        let path = dir.path().join("nested").join("model.toml");
        write(&path, &full()).unwrap();
        // Over an existing file: the whole file is replaced.
        let mut replaced = full();
        replaced.model = Some("qwen3:14b".to_string());
        write(&path, &replaced).unwrap();
        assert_eq!(read(&path), replaced);
        // The temp file is gone: only model.toml remains in the folder.
        let names: Vec<String> = fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, ["model.toml"]);
    }

    #[test]
    fn write_refuses_bad_values_and_keeps_the_old_file() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("model.toml");
        write(&path, &full()).unwrap();
        let before = fs::read_to_string(&path).unwrap();

        let mut bad = full();
        bad.runtime = Some("cloud".to_string());
        assert!(write(&path, &bad).is_err(), "unknown runtime");
        bad = full();
        bad.set_by = Some("someone".to_string());
        assert!(write(&path, &bad).is_err(), "unknown set_by");
        bad = full();
        bad.url = Some("http://user:pw@127.0.0.1:11434".to_string());
        assert!(write(&path, &bad).is_err(), "credentials in url");
        bad = full();
        bad.model = Some("  ".to_string());
        assert!(write(&path, &bad).is_err(), "blank model");
        bad = full();
        bad.updated = None;
        assert!(write(&path, &bad).is_err(), "missing updated");

        assert_eq!(fs::read_to_string(&path).unwrap(), before);
    }
}
