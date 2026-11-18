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

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use super::{Passage, report_of};

    #[test]
    fn search_json_shape() {
        // The shape only: built from Passages directly, so the fixture lock needs no Qdrant.
        // The first passage has a page (markers present), the second proves the key is absent.
        let passages: [Passage; 2] = [
            Passage {
                text: "the loan was paid off".to_string(),
                source: "car loan".to_string(),
                file: "home/car-loan-invoice.pdf.vision.txt".to_string(),
                chunk: 1,
                page: Some(4),
                score: 0.5,
            },
            Passage {
                text: "a manual page".to_string(),
                source: "manual".to_string(),
                file: "manual.pdf.text.txt".to_string(),
                chunk: 0,
                page: None,
                score: 0.3,
            },
        ];
        lock(
            "search.json".to_string(),
            serde_json::to_string(&report_of(&passages))
                .unwrap()
                .to_string(),
        );
    }

    // Fixture lock shared with the TS tests and the fake engine (see documents.rs).
    fn lock(name: String, actual: String) {
        let path: PathBuf = PathBuf::from("testdata/desktop").join(name);
        if std::env::var("LOCK_FIXTURES")
            .map(|v| v == "1")
            .unwrap_or(false)
        {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, actual).unwrap();
            return;
        }
        let want: String = fs::read_to_string(&path)
            .expect("fixture missing: run the tests once with LOCK_FIXTURES=1");
        assert_eq!(actual, want, "JSON shape changed (or the fixture is stale)");
    }
}
