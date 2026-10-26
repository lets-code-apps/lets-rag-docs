//! Let's RAG Docs: local, private retrieval over scanned documents.

#[allow(dead_code)] // used by ingest in phase 2b
mod chunk;
mod config;

use std::path::PathBuf;

use clap::{ArgAction, Parser, Subcommand};
use tracing_subscriber::EnvFilter;

use crate::config::{Config, DEFAULT_CONFIG_PATH, expand_home};

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
        Command::Ingest | Command::Search { .. } | Command::Eval => {
            println!("not implemented yet");
        }
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
