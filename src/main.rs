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
mod mcp;
mod organize;
mod search;

use std::path::{Path, PathBuf};

use anyhow::Context;

use clap::{ArgAction, Args, Parser, Subcommand};
use tracing_subscriber::EnvFilter;

use crate::config::{Config, DEFAULT_CONFIG_PATH, expand_home};
use crate::embed::EmbedClient;

/// Passages `search` prints, as `rag.py` did.
const TOP: u64 = 5;

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
enum Command {
    /// (Re)build the index from the OCR text files
    Ingest,
    /// Show the passages that best match a query
    Search { query: String },
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
        /// The file to add
        file: PathBuf,
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
    /// Show or change `[classify] folders` and `owners` through the engine
    Filing {
        #[command(subcommand)]
        command: Filing,
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
    let config = Config::load(&path)?;
    tracing::debug!(?config, "config loaded from {}", path.display());
    match cli.command {
        Command::Ingest => ingest(&config).await,
        Command::Search { query } => search(&config, &query).await,
        Command::Eval { classify: false } => eval::run(&config).await,
        Command::Eval { classify: true } => eval::run_classify(&config),
        Command::Classify { force } => classify::run(&config, force).await,
        Command::Add { file } => add::run(&config, &file).await,
        Command::Organize { json, mode } => {
            organize::run(&config, mode.dry_run, mode.apply, json).await
        }
        Command::Documents { json } => documents::run(&config, json),
        Command::Filing { command } => match command {
            Filing::Show { json } => filing::show(&config, json),
            Filing::Save { check } => filing::save(&config, &path, check),
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
    for path in &files {
        let rel = path.strip_prefix(ocr_dir)?.to_string_lossy();
        let text = std::fs::read_to_string(path)
            .with_context(|| format!("cannot read {}", path.display()))?;
        // Without an original or a `classify` row the document is still indexed, minus type/date.
        let doc = match classify::hash_file(&classify::original_path(&config.paths.docs_dir, &rel))
        {
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

async fn search(config: &Config, query: &str) -> anyhow::Result<()> {
    let embed = EmbedClient::new(&config.embed.url);
    let qdrant = index::connect(&config.qdrant.url)?;
    let hits = search::search_docs(&embed, &qdrant, &config.qdrant.collection, query, TOP).await?;
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

#[cfg(test)]
mod tests {
    use clap::Parser;

    use super::Cli;

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
}
