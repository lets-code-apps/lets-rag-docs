//! Let's RAG Docs: local, private retrieval over scanned documents.

mod chunk;
mod config;
mod embed;
mod eval;
mod index;
mod mcp;
mod search;

use std::path::{Path, PathBuf};

use anyhow::Context;

use clap::{ArgAction, Parser, Subcommand};
use tracing_subscriber::EnvFilter;

use crate::config::{Config, DEFAULT_CONFIG_PATH, expand_home};
use crate::embed::EmbedClient;

/// Passages `search` prints, as `rag.py` does.
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

#[derive(Debug, Subcommand)]
enum Command {
    /// (Re)build the index from the OCR text files
    Ingest,
    /// Show the passages that best match a query
    Search { query: String },
    /// Check that each eval question finds its expected document in the top 5
    Eval,
    /// Serve `search_docs` to an MCP client over stdio
    Mcp,
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
        Command::Eval => eval::run(&config).await,
        Command::Mcp => mcp::run(&config).await,
    }
}

/// Rebuilds the index from every `.txt` under the OCR folder (port of `rag.py ingest`).
async fn ingest(config: &Config) -> anyhow::Result<()> {
    let ocr_dir = &config.paths.ocr_dir;
    let embed = EmbedClient::new(&config.embed.url);
    let mut files = Vec::new();
    find_txt(ocr_dir, &mut files)?;
    // Path's Ord compares component by component, like Python's sorted() on Paths.
    files.sort();

    // Embed everything first, so a failure midway leaves the old index untouched.
    let mut points = Vec::new();
    for path in &files {
        let rel = path.strip_prefix(ocr_dir)?.to_string_lossy();
        let source = chunk::source_name(&rel);
        let text = std::fs::read_to_string(path)
            .with_context(|| format!("cannot read {}", path.display()))?;
        let parts = chunk::chunks(&text);
        // The document's name goes in front of every chunk, so it is findable in all of them.
        let inputs: Vec<String> = parts.iter().map(|c| format!("{source}\n{c}")).collect();
        let embeddings = embed.embed(&inputs).await?;
        println!("{:>3} chunks  {source}", parts.len());
        for (n, (text, embedding)) in parts.into_iter().zip(embeddings).enumerate() {
            let id = points.len() as u64;
            points.push(index::point(id, text, &source, &rel, n, embedding));
        }
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
