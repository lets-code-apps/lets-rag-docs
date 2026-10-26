//! The core API: a query in, the best matching passages out. MCP and `ask` build on this.

use qdrant_client::Qdrant;

use crate::embed::{EmbedClient, EmbedError};
use crate::index::{self, IndexError};

/// One retrieved chunk with where it came from.
#[derive(Debug, Clone)]
pub struct Passage {
    pub text: String,
    /// Document name: the OCR file's path without its extensions.
    pub source: String,
    /// OCR file path relative to the OCR folder.
    #[expect(dead_code, reason = "returned by the MCP tool in phase 3")]
    pub file: String,
    /// Chunk number within the file, from 0.
    pub chunk: i64,
    /// RRF fusion score: higher is better, only meaningful relative to other hits.
    pub score: f32,
}

#[derive(Debug, thiserror::Error)]
pub enum SearchError {
    #[error(transparent)]
    Embed(#[from] EmbedError),
    #[error(transparent)]
    Index(#[from] IndexError),
}

pub async fn search_docs(
    embed: &EmbedClient,
    qdrant: &Qdrant,
    collection: &str,
    query: &str,
    limit: u64,
) -> Result<Vec<Passage>, SearchError> {
    let embedding = embed
        .embed(&[query.to_string()])
        .await?
        .pop()
        .expect("embed returns one embedding per text");
    Ok(index::query(qdrant, collection, embedding, limit).await?)
}
