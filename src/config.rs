//! The config file (`~/.config/lets-rag-docs/config.toml`), same pattern as lets-triage-mail.
//!
//! `#[serde(default)]` on a struct means: any key missing from the TOML takes its value from
//! the type's `Default` impl, so every section and key is optional. `deny_unknown_fields`
//! turns typos into errors instead of silently ignoring them.

use std::path::{Path, PathBuf};

use anyhow::Context;
use serde::Deserialize;

use crate::shared_model::SharedModel;

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
    pub ocr: OcrConfig,
    pub watch: WatchConfig,
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
    /// Where `organize --apply` copies originals into, under `<folder>/<title>`. Kept separate
    /// from `docs_dir`/`ocr_dir` so a copy is never OCR'd or classified as a new original.
    pub library_dir: PathBuf,
}

impl Default for PathsConfig {
    fn default() -> Self {
        PathsConfig {
            ocr_dir: PathBuf::from("data/ocr"),
            evals: PathBuf::from("evals/rag.jsonl"),
            docs_dir: PathBuf::from("docs"),
            db: PathBuf::from("data/lets-rag-docs.sqlite"),
            library_dir: PathBuf::from("library"),
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

/// `[classify]`: the document types, library folders and owners the model may choose. Anything
/// else becomes `unsorted` (type), no folder (filed under `unsorted/`) or no owner (filed under
/// `shared_owner`).
#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ClassifyConfig {
    pub types: Vec<String>,
    pub folders: Vec<String>,
    /// Whose documents these are: family members and the family's own companies. Real names
    /// belong only in the local config.
    pub owners: Vec<String>,
    /// The owner folder for documents that belong to nobody on the list, or to several people.
    pub shared_owner: String,
    /// The language titles and matters are written in (e.g. "Polish"). Unset: each document's own.
    pub language: Option<String>,
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
        let folders = [
            "Identity",
            "Health",
            "Finance",
            "Taxes",
            "Insurance",
            "Home",
            "Car",
            "Work",
            "Education",
            "Purchases",
            "Letters",
            "Other",
        ];
        ClassifyConfig {
            types: types.map(String::from).to_vec(),
            folders: folders.map(String::from).to_vec(),
            owners: Vec::new(),
            shared_owner: "Shared".to_string(),
            language: None,
        }
    }
}

/// `[ocr]`: how `add <file>` shells out to `ocr.py` (OCR stays Python; see CLAUDE.md).
#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct OcrConfig {
    /// The interpreter to run the script with (the repo's venv by default).
    pub python: PathBuf,
    /// The OCR script itself.
    pub script: PathBuf,
    /// The largest file worth OCR'ing, in decimal MB (the way Finder counts them). `add`
    /// refuses a bigger file before touching it; `ingest` and `organize` skip it;
    /// `documents --json` reports the number so the app can explain a skipped row.
    pub max_file_mb: u64,
}

impl Default for OcrConfig {
    fn default() -> Self {
        OcrConfig {
            python: PathBuf::from(".venv/bin/python"),
            script: PathBuf::from("ocr.py"),
            max_file_mb: 50,
        }
    }
}

/// `[watch]`: the folders the first-run onboarding saves for the (not-yet-implemented) watcher.
/// Kept separate from `[paths]` on purpose: these are user-picked source folders, never expanded
/// or resolved, and empty by default so nothing is watched before a human chooses it.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
pub struct WatchConfig {
    pub folders: Vec<String>,
}

impl Config {
    /// Reads the config at `path`; a missing file means all defaults, so the tool runs without
    /// setup. Stays pure: it never looks at the shared model file (see `load_with_shared`).
    #[allow(dead_code)] // the pure loader used by the tests; the CLI passes the shared setting
    pub fn load(path: &Path) -> anyhow::Result<Config> {
        Config::load_with_shared(path, &SharedModel::default())
    }

    /// Reads the config at `path`, then applies `shared` (see guide/MODEL.md): when the user
    /// wrote neither `[llm] base_url` nor `model`, each key comes from the shared setting,
    /// else from the built-in default. A missing config file is still all defaults.
    pub fn load_with_shared(path: &Path, shared: &SharedModel) -> anyhow::Result<Config> {
        let text = match std::fs::read_to_string(path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(e) => return Err(e).with_context(|| format!("cannot read {}", path.display())),
        };
        let mut config: Config = toml::from_str(&text)
            .with_context(|| format!("invalid config file {}", path.display()))?;
        config.paths.ocr_dir = expand_home(&config.paths.ocr_dir);
        config.paths.evals = expand_home(&config.paths.evals);
        config.paths.docs_dir = expand_home(&config.paths.docs_dir);
        config.paths.db = expand_home(&config.paths.db);
        config.paths.library_dir = expand_home(&config.paths.library_dir);
        config.ocr.python = expand_home(&config.ocr.python);
        config.ocr.script = expand_home(&config.ocr.script);
        config.apply_shared(&text, shared);
        Ok(config)
    }

    /// All-or-nothing: an app that wrote either `[llm]` key keeps its own LLM setup completely
    /// (never one server's URL with another's model name). `Config` itself cannot tell a set
    /// key from a defaulted one (serde fills defaults in), so the same text is parsed again
    /// into just these two optional keys.
    fn apply_shared(&mut self, text: &str, shared: &SharedModel) {
        let written: Written = toml::from_str(text).unwrap_or_default();
        if written.llm.base_url.is_some() || written.llm.model.is_some() {
            return;
        }
        if let Some(url) = shared.chat_base_url() {
            self.llm.base_url = url;
        }
        if let Some(model) = shared.chat_model() {
            self.llm.model = model.to_string();
        }
    }
}

/// What the user wrote under `[llm]`; `Config` cannot say (serde fills in defaults). Unknown
/// keys stay allowed here: this is the user's own config, already validated by `Config`.
#[derive(Deserialize, Default)]
struct Written {
    #[serde(default)]
    llm: WrittenLlm,
}

#[derive(Deserialize, Default)]
struct WrittenLlm {
    base_url: Option<String>,
    model: Option<String>,
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

    use std::fs;

    use tempfile::tempdir;

    fn shared_with(url: Option<String>, model: Option<String>) -> SharedModel {
        SharedModel {
            runtime: None,
            url,
            model,
            set_by: None,
            updated: None,
        }
    }

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
    fn watch_section_parses() {
        let config: Config =
            toml::from_str("[watch]\nfolders = [\"~/Downloads\", \"~/Desktop\"]\n").unwrap();
        assert_eq!(
            config.watch.folders,
            vec!["~/Downloads".to_string(), "~/Desktop".to_string()]
        );
        // Absent: empty, so nothing is watched by accident.
        let empty: Config = toml::from_str("").unwrap();
        assert!(
            empty.watch.folders.is_empty(),
            "an absent [watch] stays empty"
        );
        // Kept verbatim: no `~` expansion in the stored value.
        assert_eq!(empty.watch.folders.first(), None);
    }

    #[test]
    fn unknown_watch_key_rejected() {
        assert!(
            toml::from_str::<Config>("[watch]\nfoldrs = [\"x\"]").is_err(),
            "a typo in [watch] must be an error, not ignored"
        );
    }

    #[test]
    fn missing_file_gives_defaults() {
        let config = Config::load(Path::new("/nonexistent/lets-rag-docs.toml")).unwrap();
        assert_eq!(config.qdrant.collection, "documents");
    }

    #[test]
    fn shared_model_replaces_the_llm_defaults() {
        let dir = tempdir().unwrap();
        let config_path = dir.path().join("config.toml");
        fs::write(&config_path, "").unwrap();
        let shared = shared_with(
            Some("http://localhost:11434".to_string()),
            Some("qwen3:8b".to_string()),
        );
        let config = Config::load_with_shared(&config_path, &shared).unwrap();
        assert_eq!(config.llm.base_url, "http://localhost:11434/v1");
        assert_eq!(config.llm.model, "qwen3:8b");
    }

    #[test]
    fn no_shared_file_keeps_the_defaults() {
        // The case that matters most: a user without a shared model.toml sees no change.
        let config = Config::load_with_shared(
            Path::new("/nonexistent/lets-rag-docs.toml"),
            &SharedModel::default(),
        )
        .unwrap();
        assert_eq!(config.llm.base_url, "http://127.0.0.1:11434/v1");
        assert_eq!(config.llm.model, "qwen3:30b-a3b");
    }

    #[test]
    fn shared_file_with_only_a_model_keeps_the_default_url() {
        let dir = tempdir().unwrap();
        let config_path = dir.path().join("config.toml");
        fs::write(&config_path, "").unwrap();
        let shared = shared_with(None, Some("qwen3:8b".to_string()));
        let config = Config::load_with_shared(&config_path, &shared).unwrap();
        assert_eq!(config.llm.base_url, "http://127.0.0.1:11434/v1");
        assert_eq!(config.llm.model, "qwen3:8b");
    }

    #[test]
    fn unknown_key_in_the_shared_file_changes_nothing() {
        let dir = tempdir().unwrap();
        let shared_path = dir.path().join("model.toml");
        fs::write(
            &shared_path,
            "model = \"qwen3:8b\"\nfuture_key = 1\n\n[extra]\nanything = true\n",
        )
        .unwrap();
        let shared = crate::shared_model::read(&shared_path);
        let config_path = dir.path().join("config.toml");
        fs::write(&config_path, "").unwrap();
        let config = Config::load_with_shared(&config_path, &shared).unwrap();
        assert_eq!(config.llm.model, "qwen3:8b");
        assert_eq!(config.llm.base_url, "http://127.0.0.1:11434/v1");
    }

    #[test]
    fn app_config_model_wins_over_the_shared_file() {
        let dir = tempdir().unwrap();
        let config_path = dir.path().join("config.toml");
        fs::write(&config_path, "[llm]\nmodel = \"x\"\n").unwrap();
        let shared = shared_with(
            Some("http://localhost:11434".to_string()),
            Some("qwen3:8b".to_string()),
        );
        let config = Config::load_with_shared(&config_path, &shared).unwrap();
        assert_eq!(config.llm.model, "x");
        assert_eq!(config.llm.base_url, "http://127.0.0.1:11434/v1");
    }

    #[test]
    fn app_config_base_url_wins_over_the_shared_file() {
        let dir = tempdir().unwrap();
        let config_path = dir.path().join("config.toml");
        fs::write(
            &config_path,
            "[llm]\nbase_url = \"http://127.0.0.1:9999/v1\"\n",
        )
        .unwrap();
        let shared = shared_with(
            Some("http://localhost:11434".to_string()),
            Some("qwen3:8b".to_string()),
        );
        let config = Config::load_with_shared(&config_path, &shared).unwrap();
        assert_eq!(config.llm.base_url, "http://127.0.0.1:9999/v1");
        assert_eq!(config.llm.model, "qwen3:30b-a3b");
    }

    #[test]
    fn shared_non_local_url_is_still_refused() {
        use crate::ask::check_base_url;

        let dir = tempdir().unwrap();
        let config_path = dir.path().join("config.toml");
        fs::write(&config_path, "").unwrap();
        let shared = shared_with(
            Some("http://example.com".to_string()),
            Some("qwen3:8b".to_string()),
        );
        let config = Config::load_with_shared(&config_path, &shared).unwrap();
        assert!(
            check_base_url(&config.llm).is_err(),
            "the shared file cannot switch privacy off"
        );

        // Only the app's own config may allow it (and allow_remote is not an [llm] LLM key,
        // so it does not count as "written" for the win-over rule).
        let other_path = dir.path().join("other.toml");
        fs::write(&other_path, "[llm]\nallow_remote = true\n").unwrap();
        let allowed = Config::load_with_shared(&other_path, &shared).unwrap();
        assert!(check_base_url(&allowed.llm).is_ok());
    }
}
