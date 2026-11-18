//! The core API: a query in, the best matching passages out. MCP and `ask` build on this.

use qdrant_client::Qdrant;
use serde::Serialize;

use crate::embed::{EmbedClient, EmbedError};
use crate::index::{self, IndexError};

/// One retrieved chunk with where it came from.
#[derive(Debug, Clone, Serialize)]
pub struct Passage {
    pub text: String,
    /// Document name: the OCR file's path without its extensions.
    pub source: String,
    /// OCR file path relative to the OCR folder.
    pub file: String,
    /// Chunk number within the file, from 0.
    pub chunk: i64,
    /// Page within the document (1-based), only when the OCR text carries page markers.
    /// Omitted from the JSON of documents OCR'd before markers existed, so old MCP output
    /// is byte-identical.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page: Option<i64>,
    /// RRF fusion score: higher is better, only meaningful relative to other hits.
    pub score: f32,
}

/// `search --json`: passages as data — the citation keys, never the passage text.
#[derive(Serialize)]
pub(crate) struct Report {
    /// Wire format version: a consumer that speaks 1 refuses anything else.
    version: u8,
    passages: Vec<Hit>,
}

#[derive(Serialize)]
pub(crate) struct Hit {
    source: String,
    file: String,
    chunk: i64,
    page: Option<i64>,
    score: f32,
}

/// Pure so the fixture-lock test needs no Qdrant: the JSON body as a value.
pub fn report_of(passages: &[Passage]) -> Report {
    Report {
        version: 1,
        passages: passages
            .iter()
            .map(|p| Hit {
                source: p.source.to_string(),
                file: p.file.to_string(),
                chunk: p.chunk,
                page: p.page,
                score: p.score,
            })
            .collect(),
    }
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
