//! Let's RAG Docs: local, private retrieval over scanned documents.

mod add;
mod ask;
mod chunk;
mod classify;
mod config;
mod config_edit;
mod db;
mod documents;
mod embed;
mod eval;
mod filing;
mod index;
mod locate;
mod mcp;
mod organize;
mod search;
mod setup;
mod model_setup;
mod shared_model;
mod status;

use std::path::{Path, PathBuf};

use anyhow::Context;

use clap::{ArgAction, Args, Parser, Subcommand};
use tracing_subscriber::EnvFilter;

use crate::config::{Config, DEFAULT_CONFIG_PATH, expand_home};
use crate::embed::EmbedClient;

#[derive(Debug, Parser)]
#[command(name = "lets-rag-docs", version, about)]
struct Cli {
    /// Path to the config file [default: ~/.config/lets-rag-docs/config.toml]
    #[arg(long, global = true, value_name = "PATH")]
    config: Option<PathBuf>,

    /// More logging: -v for debug, -vv for trace (RUST_LOG overrides)
    #[arg(short, long, global = true, action = ArgAction::Count)]
    verbose: u8,

    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Args)]
#[group(required = true, multiple = false)]
struct OrganizeMode {
    /// Print the planned copies and change nothing
    #[arg(long)]
    dry_run: bool,
    /// Copy the documents and re-embed the copies
    #[arg(long)]
    apply: bool,
}

#[derive(Debug, Subcommand)]
enum Filing {
    /// Print the effective `[classify] folders`, `owners` and `shared_owner` as JSON
    Show {
        /// Machine-readable output; required, there is no text mode for this command
        #[arg(long)]
        json: bool,
    },
    /// Read a draft from stdin, validate it, then write the two lists unless --check is set
    Save {
        /// Validate without writing
        #[arg(long)]
        check: bool,
    },
}

#[derive(Debug, Subcommand)]
enum Model {
    /// Probe the local model servers and list what they can run (`model detect --json`)
    Detect {
        /// Probe this one local server instead of the two defaults
        #[arg(long, value_name = "URL")]
        url: Option<String>,
        /// Machine-readable output; there is no text mode for the app contract
        #[arg(long)]
        json: bool,
    },
    /// Ask Ollama to download a model, streaming NDJSON progress lines
    Pull {
        /// Pull from this one local server instead of the Ollama default
        #[arg(long, value_name = "URL")]
        url: Option<String>,
        /// The model to download (after `--`, so a name cannot be read as a flag)
        model: String,
        /// Progress is always line-delimited JSON; the flag is accepted for symmetry
        #[arg(long)]
        json: bool,
    },
    /// Record the choice in the shared `model.toml` (`model save --json --runtime=… --url=… --model=…`)
    Save {
        /// One of ollama, lmstudio or custom
        #[arg(long)]
        runtime: String,
        /// A local model server url
        #[arg(long, value_name = "URL")]
        url: String,
        /// The model name, as the server lists it
        #[arg(long)]
        model: String,
        /// Machine-readable output
        #[arg(long)]
        json: bool,
    },
}

#[derive(Debug, Subcommand)]
enum Setup {
    /// Print the effective `[paths] library_dir` and `[watch] folders` (plus recommendations) as JSON
    Show {
        /// Machine-readable output; required, there is no text mode for this command
        #[arg(long)]
        json: bool,
    },
    /// Read a draft from stdin, validate it, then write the two fields unless --check is set
    Save {
        /// Validate without writing
        #[arg(long)]
        check: bool,
    },
}

#[derive(Debug, Subcommand)]
enum Command {
    /// (Re)build the index from the OCR text files
    Ingest,
    /// Show the passages that best match a query
    Search {
        /// Machine-readable output: `{version, passages:[{source,file,chunk,page,score}]}`,
        /// passage text stays out (the app lists documents, it never shows their contents)
        #[arg(long)]
        json: bool,
        /// How many passages to return (default 5, the number `search` has always shown)
        #[arg(long, value_name = "N", default_value = "5")]
        limit: u64,
        query: String,
    },
    /// Check that each eval question finds its expected document in the top 5
    Eval {
        /// Check `classify` instead: expected type and date per document (evals/classify.jsonl)
        #[arg(long)]
        classify: bool,
    },
    /// Ask the local LLM for each new document's title, type, date, people, issuer and folder
    Classify {
        /// Classify again documents that are already in the database
        #[arg(long)]
        force: bool,
    },
    /// OCR one file, classify it and index it: `add <file>`
    Add {
        /// Machine-readable output: `{version, status, source, file, type, date, chunks,
        /// duplicate_of}`; a failed add is still the non-zero exit with stderr as before
        #[arg(long)]
        json: bool,
        /// The file to add
        file: PathBuf,
    },
    /// Resolve a `documents --json` path to ONE absolute file the app may open: read-only,
    /// prints only `{version, status, kind, path}`, opens nothing
    Locate {
        /// Machine-readable output; required, there is no text mode for this command
        #[arg(long)]
        json: bool,
        /// The path to resolve (the `documents --json` row's `path`)
        path: PathBuf,
    },
    /// Copy each classified original into `library/<folder>/<owner>/<year>/` and re-index the copy
    Organize {
        /// Machine-readable output: the single JSON object `{mode, status, items, counts}`
        #[arg(long)]
        json: bool,
        /// The mode stays exactly one: --dry-run or --apply, never both, never neither
        #[command(flatten)]
        mode: OrganizeMode,
    },
    /// List every classified document as JSON (read-only): `documents --json`
    Documents {
        /// Machine-readable output; required, there is no text mode for this command
        #[arg(long)]
        json: bool,
    },
    /// Is the model answering, and when was the library last synced (read-only): `status --json`
    Status {
        /// Machine-readable output; required, there is no text mode for this command
        #[arg(long)]
        json: bool,
        /// Probe the model itself with one tiny completion (`--answer`): what the
        /// onboarding's Ready check uses; the overview keeps the cheap listing probe
        #[arg(long)]
        answer: bool,
    },
    /// Show or change `[classify] folders` and `owners` through the engine
    Filing {
        #[command(subcommand)]
        command: Filing,
    },
    /// Show or change `[paths] library_dir` and `[watch] folders` through the engine
    Setup {
        #[command(subcommand)]
        command: Setup,
    },
    /// Probe, download, and record the local model (first-run onboarding): `model …`
    Model {
        #[command(subcommand)]
        command: Model,
    },
    /// Serve `search_docs` to an MCP client over stdio
    Mcp,
    /// Answer a question from the documents with a local LLM, with citations
    Ask {
        /// Machine-readable output: `{answer, sources}` instead of answer text plus source lines
        #[arg(long)]
        json: bool,
        question: String,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    init_logging(cli.verbose);
    let path = expand_home(
        cli.config
            .as_deref()
            .unwrap_or(DEFAULT_CONFIG_PATH.as_ref()),
    );
    let shared_path = expand_home(Path::new(shared_model::DEFAULT_PATH));
    let config = Config::load_with_shared(
        &path,
        &shared_model::read(&shared_path),
    )?;
    tracing::debug!(?config, "config loaded from {}", path.display());
    match cli.command {
        Command::Ingest => ingest(&config).await,
        Command::Search { query, json, limit } => search(&config, &query, json, limit).await,
        Command::Eval { classify: false } => eval::run(&config).await,
        Command::Eval { classify: true } => eval::run_classify(&config),
        Command::Classify { force } => classify::run(&config, force).await,
        Command::Add { file, json } => add::run(&config, &file, json).await,
        Command::Locate { path, json } => locate::run(&config, json, &path),
        Command::Organize { json, mode } => {
            organize::run(&config, mode.dry_run, mode.apply, json).await
        }
        Command::Documents { json } => documents::run(&config, json),
        Command::Status { json } => status::run(&config, json).await,
        Command::Filing { command } => match command {
            Filing::Show { json } => filing::show(&config, json),
            Filing::Save { check } => filing::save(&config, &path, check),
        },
        Command::Setup { command } => match command {
            Setup::Show { json } => setup::show(&config, &path, json),
            Setup::Save { check } => setup::save(&config, &path, check),
        },
        Command::Mcp => mcp::run(&config).await,
        Command::Ask { question, json } => ask::run(&config, &question, json).await,
    }
}

/// Rebuilds the index from every `.txt` under the OCR folder (port of `rag.py ingest`).
async fn ingest(config: &Config) -> anyhow::Result<()> {
    let ocr_dir = &config.paths.ocr_dir;
    let embed = EmbedClient::new(&config.embed.url);
    let conn = db::open(&config.paths.db)?;
    let mut files = Vec::new();
    find_txt(ocr_dir, &mut files)?;
    // Path's Ord compares component by component, like Python's sorted() on Paths.
    files.sort();

    // Embed everything first, so a failure midway leaves the old index untouched.
    let mut points = Vec::new();
    // Files whose original is over `[ocr] max_file_mb` are skipped: `add` refuses such a file
    // outright, so a bulk OCR must not have slipped one into the index behind the user's back.
    let max_bytes: u64 = config.ocr.max_file_mb.saturating_mul(1_000_000);
    for path in &files {
        let rel = path.strip_prefix(ocr_dir)?.to_string_lossy();
        let original = classify::original_path(&config.paths.docs_dir, &rel);
        if skips_over_limit(&original, max_bytes) {
            println!(
                "not indexed: over {} MB  {}",
                config.ocr.max_file_mb,
                chunk::source_name(rel.as_ref()),
            );
            continue;
        }
        let text = std::fs::read_to_string(path)
            .with_context(|| format!("cannot read {}", path.display()))?;
        // Without an original or a `classify` row the document is still indexed, minus type/date.
        let doc = match classify::hash_file(&original) {
            Ok(hash) => db::get(&conn, &hash)?,
            Err(_) => None,
        };
        let meta = doc.as_ref().map(|d| &d.meta);
        // document_points embeds "{source}\n{chunk}" per chunk and keys each point by point_id
        // (file, chunk): stable, and shared verbatim with `add`.
        let new = index::document_points(&embed, &rel, text, meta).await?;
        println!("{:>3} chunks  {}", new.len(), chunk::source_name(&rel));
        points.extend(new);
    }

    let qdrant = index::connect(&config.qdrant.url)?;
    let total = points.len();
    index::recreate(&qdrant, &config.qdrant.collection).await?;
    index::upsert(&qdrant, &config.qdrant.collection, points).await?;
    println!("{total} chunks indexed");
    Ok(())
}

/// Collects `*.txt` files under `dir`, recursively (like Python's `rglob("*.txt")`).
fn find_txt(dir: &Path, out: &mut Vec<PathBuf>) -> anyhow::Result<()> {
    let entries =
        std::fs::read_dir(dir).with_context(|| format!("cannot read {}", dir.display()))?;
    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        // file_type() does not follow symlinks, so a link to a folder is not walked (as in rglob).
        if entry.file_type()?.is_dir() {
            find_txt(&path, out)?;
        } else if path.extension().is_some_and(|e| e == "txt") {
            out.push(path);
        }
    }
    Ok(())
}

async fn search(config: &Config, query: &str, json: bool, limit: u64) -> anyhow::Result<()> {
    let embed = EmbedClient::new(&config.embed.url);
    let qdrant = index::connect(&config.qdrant.url)?;
    let hits =
        search::search_docs(&embed, &qdrant, &config.qdrant.collection, query, limit).await?;
    if json {
        // Citation keys only: `{version, passages:[{source,file,chunk,page,score}]}`. Passage
        // text never crosses into the JSON, same rule as every other machine report.
        println!("{}", serde_json::to_string(&search::report_of(&hits))?);
        return Ok(());
    }
    for hit in hits {
        let preview: String = hit.text.chars().take(300).collect();
        println!(
            "\n{:.3}  {}  (chunk {})\n{preview}",
            hit.score, hit.source, hit.chunk
        );
    }
    Ok(())
}

/// Sends `tracing` logs to stderr (stdout is kept for command output).
fn init_logging(verbosity: u8) {
    let default_level = match verbosity {
        0 => "info",
        1 => "debug",
        _ => "trace",
    };
    let filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(default_level));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .init();
}

/// Whether one OCR text file is skipped by `ingest`: its original is over
/// `[ocr] max_file_mb`, so a bulk OCR must not have slipped it into the index behind
/// the user's back (`add` refuses such a file outright). A missing original is NOT
/// "over": the document still indexes, just without a type or date.
fn skips_over_limit(original: &Path, max_bytes: u64) -> bool {
    classify::over_limit(original, max_bytes)
}

#[cfg(test)]
mod tests {
    use clap::Parser;

    use std::fs;

    use super::Cli;
    use super::skips_over_limit;
    use crate::config::Config;

    // `status --json` is the desktop overview's contract: the subcommand parses, but the
    // command itself refuses without `--json` (same rule as `documents`: machine output only).
    #[tokio::test]
    async fn status_requires_json_flag() {
        assert!(
            Cli::try_parse_from(vec![
                "lets-rag-docs".to_string(),
                "status".to_string(),
                "--json".to_string()
            ])
            .is_ok(),
            "`status --json` parses"
        );
        // Without --json the clap side still parses (the flag is optional there); the command
        // refuses at run time, before touching config, with a non-zero exit.
        let config = Config::default();
        let result = super::status::run(&config, false).await;
        assert!(
            result.is_err(),
            "status without --json is refused, not printed by hand"
        );
    }

    // The clap contract the desktop shell and the acceptance tests rely on: `organize --json`
    // alone is not a mode, and adding --json must not have widened the exactly-one group.
    #[test]
    fn organize_requires_exactly_one_mode() {
        let parses = |extra: &[&str]| {
            let mut args: Vec<String> = vec!["lets-rag-docs".to_string()];
            args.extend(extra.iter().map(|a| a.to_string()));
            Cli::try_parse_from(args).is_ok()
        };
        let bad: Vec<Vec<&str>> = vec![
            vec!["organize"],
            vec!["organize", "--json"],
            vec!["organize", "--dry-run", "--apply"],
            vec!["organize", "--dry-run", "--apply", "--json"],
        ];
        for extra in bad {
            assert!(
                !parses(extra.as_slice()),
                "should be rejected: {}",
                extra.join(" ")
            );
        }
        let good: Vec<Vec<&str>> = vec![
            vec!["organize", "--dry-run"],
            vec!["organize", "--apply"],
            vec!["organize", "--dry-run", "--json"],
            vec!["organize", "--apply", "--json"],
        ];
        for extra in good {
            let label: String = extra.join(" ");
            assert!(parses(extra.as_slice()), "should parse: {}", label);
        }
    }

    #[test]
    fn ingest_skips_over_limit_original() {
        // max_file_mb = 1 and a 1,000,001-byte original: `ingest` must skip that OCR text
        // BEFORE embedding, exactly as `add` refuses the file outright.
        let dir = tempfile::tempdir().unwrap();
        let docs = dir.path().join("docs");
        fs::create_dir(&docs).unwrap();
        fs::write(docs.join("big.pdf"), "x".repeat(1_000_001).as_bytes()).unwrap();
        fs::write(docs.join("loan.pdf"), "tiny".as_bytes()).unwrap();
        let limit: u64 = 1u64.saturating_mul(1_000_000);
        assert!(
            skips_over_limit(&docs.join("big.pdf"), limit),
            "the 1,000,001-byte original"
        );
        assert!(
            !skips_over_limit(&docs.join("loan.pdf"), limit),
            "the tiny original"
        );
        // No original at all: not "over" - the document indexes without a type or date.
        assert!(
            !skips_over_limit(&docs.join("gone.pdf"), limit),
            "a missing original"
        );
    }
}
