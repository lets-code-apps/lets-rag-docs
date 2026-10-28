//! The config file (`~/.config/lets-rag-docs/config.toml`), same pattern as lets-triage-mail.
//!
//! `#[serde(default)]` on a struct means: any key missing from the TOML takes its value from
//! the type's `Default` impl, so every section and key is optional. `deny_unknown_fields`
//! turns typos into errors instead of silently ignoring them.

use std::path::{Path, PathBuf};

use anyhow::Context;
use serde::Deserialize;

/// Where the config lives when `--config` is not given.
pub const DEFAULT_CONFIG_PATH: &str = "~/.config/lets-rag-docs/config.toml";

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub qdrant: QdrantConfig,
    pub embed: EmbedConfig,
    pub paths: PathsConfig,
    pub llm: LlmConfig,
    pub classify: ClassifyConfig,
}

/// `[qdrant]`: the vector store, over gRPC.
#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct QdrantConfig {
    pub url: String,
    pub collection: String,
}

impl Default for QdrantConfig {
    fn default() -> Self {
        QdrantConfig {
            url: String::from("http://127.0.0.1:6334"),
            collection: String::from("documents"),
        }
    }
}

/// `[embed]`: the bge-m3 sidecar (`embed_server.py`).
#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct EmbedConfig {
    pub url: String,
}

impl Default for EmbedConfig {
    fn default() -> Self {
        EmbedConfig {
            url: String::from("http://127.0.0.1:8100"),
        }
    }
}

/// `[paths]`: relative paths resolve against the current directory.
#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct PathsConfig {
    pub ocr_dir: PathBuf,
    pub evals: PathBuf,
    /// The original documents ocr.py read; `classify` hashes them.
    pub docs_dir: PathBuf,
    /// SQLite database with one row per classified document.
    pub db: PathBuf,
}

impl Default for PathsConfig {
    fn default() -> Self {
        PathsConfig {
            ocr_dir: PathBuf::from("data/ocr"),
            evals: PathBuf::from("evals/rag.jsonl"),
            docs_dir: PathBuf::from("docs"),
            db: PathBuf::from("data/lets-rag-docs.sqlite"),
        }
    }
}

/// `[llm]`: the local model `ask` talks to (any OpenAI-compatible server).
#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct LlmConfig {
    pub base_url: String,
    pub model: String,
    pub max_tokens: u32,
    pub timeout_seconds: u64,
    /// Allow a `base_url` outside this machine and the local network. Checked by `ask` and `classify`.
    pub allow_remote: bool,
}

impl Default for LlmConfig {
    fn default() -> Self {
        LlmConfig {
            base_url: String::from("http://127.0.0.1:11434/v1"),
            model: String::from("qwen3:30b-a3b"),
            max_tokens: 4096,
            timeout_seconds: 300,
            allow_remote: false,
        }
    }
}

/// `[classify]`: document types the model may choose. Anything else becomes `unsorted`.
#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ClassifyConfig {
    pub types: Vec<String>,
}

impl Default for ClassifyConfig {
    fn default() -> Self {
        let types = [
            "identity",
            "medical",
            "invoice",
            "receipt",
            "contract",
            "loan",
            "insurance",
            "tax",
            "bank",
            "warranty",
            "certificate",
            "letter",
            "other",
        ];
        ClassifyConfig {
            types: types.map(String::from).to_vec(),
        }
    }
}

impl Config {
    /// Reads the config at `path`; a missing file means all defaults, so the tool runs without setup.
    pub fn load(path: &Path) -> anyhow::Result<Config> {
        let text = match std::fs::read_to_string(path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Config::default()),
            Err(e) => return Err(e).with_context(|| format!("cannot read {}", path.display())),
        };
        let mut config: Config = toml::from_str(&text)
            .with_context(|| format!("invalid config file {}", path.display()))?;
        config.paths.ocr_dir = expand_home(&config.paths.ocr_dir);
        config.paths.evals = expand_home(&config.paths.evals);
        config.paths.docs_dir = expand_home(&config.paths.docs_dir);
        config.paths.db = expand_home(&config.paths.db);
        Ok(config)
    }
}

/// Replaces a leading `~` with `$HOME`. The shell does this for arguments, not for paths in a file.
pub fn expand_home(path: &Path) -> PathBuf {
    match (path.strip_prefix("~"), std::env::var_os("HOME")) {
        (Ok(rest), Some(home)) => PathBuf::from(home).join(rest),
        _ => path.to_path_buf(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn example_config_matches_the_defaults() {
        let example: Config = toml::from_str(include_str!("../config.example.toml")).unwrap();
        // Debug output compares every field without needing PartialEq on each struct.
        assert_eq!(format!("{example:?}"), format!("{:?}", Config::default()));
    }

    #[test]
    fn unknown_keys_are_rejected() {
        assert!(toml::from_str::<Config>("[qdrant]\nulr = \"x\"").is_err());
    }

    #[test]
    fn missing_file_gives_defaults() {
        let config = Config::load(Path::new("/nonexistent/lets-rag-docs.toml")).unwrap();
        assert_eq!(config.qdrant.collection, "documents");
    }
}
