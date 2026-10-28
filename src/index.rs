//! Qdrant over gRPC: the `documents` collection, laid out exactly like `rag.py` built it.
//!
//! Named vectors `dense` (1024, cosine) and sparse `sparse`; payload `text`, `source`, `file`,
//! `chunk`, plus `type` and `date` for classified documents (for metadata filters). Queries are RRF fusion of a dense and a sparse prefetch.

use std::collections::HashMap;

use qdrant_client::qdrant::value::Kind;
use qdrant_client::qdrant::{
    CreateCollectionBuilder, Distance, Fusion, NamedVectors, PointStruct, PrefetchQueryBuilder,
    Query, QueryPointsBuilder, SparseVectorParamsBuilder, SparseVectorsConfigBuilder,
    UpsertPointsBuilder, Value, Vector, VectorInput, VectorParamsBuilder, VectorsConfigBuilder,
};
use qdrant_client::{Payload, Qdrant, QdrantError};

use crate::db::Meta;
use crate::embed::Embedding;
use crate::search::Passage;

const DENSE: &str = "dense";
const SPARSE: &str = "sparse";
const DIM: u64 = 1024;
/// Candidates each prefetch (dense, sparse) hands to the fusion step, as in `rag.py`.
const PREFETCH: u64 = 20;
/// Points per upsert request; keeps each gRPC message well under Qdrant's size limit.
const UPSERT_BATCH: usize = 256;

#[derive(Debug, thiserror::Error)]
pub enum IndexError {
    #[error("Qdrant request failed (is `docker compose up -d` running?): {0}")]
    Qdrant(#[from] QdrantError),
    #[error("search hit has no valid `{0}` in its payload")]
    Payload(&'static str),
}

pub fn connect(url: &str) -> Result<Qdrant, IndexError> {
    Ok(Qdrant::from_url(url).build()?)
}

/// Drops the collection if it exists and creates it empty.
///
/// shortcut: full rebuild every run (fine for tens of docs), go incremental by file hash at hundreds.
pub async fn recreate(client: &Qdrant, collection: &str) -> Result<(), IndexError> {
    if client.collection_exists(collection).await? {
        client.delete_collection(collection).await?;
    }
    let mut vectors = VectorsConfigBuilder::default();
    vectors.add_named_vector_params(DENSE, VectorParamsBuilder::new(DIM, Distance::Cosine));
    let mut sparse = SparseVectorsConfigBuilder::default();
    sparse.add_named_vector_params(SPARSE, SparseVectorParamsBuilder::default());
    client
        .create_collection(
            CreateCollectionBuilder::new(collection)
                .vectors_config(vectors)
                .sparse_vectors_config(sparse),
        )
        .await?;
    Ok(())
}

/// One chunk as a Qdrant point. Takes `text` and `embedding` by value: they move into the
/// point instead of being copied. `meta` is the document's row from `classify`, if any.
pub fn point(
    id: u64,
    text: String,
    source: &str,
    file: &str,
    chunk: usize,
    embedding: Embedding,
    meta: Option<&Meta>,
) -> PointStruct {
    let vectors = NamedVectors::default()
        .add_vector(DENSE, Vector::new_dense(embedding.dense))
        .add_vector(
            SPARSE,
            Vector::new_sparse(embedding.sparse.indices, embedding.sparse.values),
        );
    let mut payload = Payload::new();
    payload.insert("text", text);
    payload.insert("source", source);
    payload.insert("file", file);
    payload.insert("chunk", chunk as i64);
    if let Some(meta) = meta {
        payload.insert("type", meta.doc_type.as_str());
        if let Some(date) = &meta.date {
            payload.insert("date", date.as_str());
        }
    }
    PointStruct::new(id, vectors, payload)
}

pub async fn upsert(
    client: &Qdrant,
    collection: &str,
    points: Vec<PointStruct>,
) -> Result<(), IndexError> {
    // by_ref() lets take() borrow the iterator, so each loop moves the next batch out (no clones).
    let mut points = points.into_iter();
    loop {
        let batch: Vec<PointStruct> = points.by_ref().take(UPSERT_BATCH).collect();
        if batch.is_empty() {
            return Ok(());
        }
        client
            .upsert_points(UpsertPointsBuilder::new(collection, batch).wait(true))
            .await?;
    }
}

/// Hybrid search: meaning (dense) and keywords (sparse), merged by rank (RRF).
pub async fn query(
    client: &Qdrant,
    collection: &str,
    embedding: Embedding,
    limit: u64,
) -> Result<Vec<Passage>, IndexError> {
    let Embedding { dense, sparse } = embedding;
    let request = QueryPointsBuilder::new(collection)
        .add_prefetch(
            PrefetchQueryBuilder::default()
                .query(Query::new_nearest(VectorInput::new_dense(dense)))
                .using(DENSE)
                .limit(PREFETCH),
        )
        .add_prefetch(
            PrefetchQueryBuilder::default()
                .query(Query::new_nearest(VectorInput::new_sparse(
                    sparse.indices,
                    sparse.values,
                )))
                .using(SPARSE)
                .limit(PREFETCH),
        )
        .query(Query::new_fusion(Fusion::Rrf))
        .limit(limit)
        .with_payload(true); // the Python client sends this by default, gRPC does not
    let hits = client.query(request).await?.result;
    hits.into_iter()
        .map(|mut hit| {
            Ok(Passage {
                text: take_string(&mut hit.payload, "text")?,
                source: take_string(&mut hit.payload, "source")?,
                file: take_string(&mut hit.payload, "file")?,
                chunk: match hit.payload.get("chunk").and_then(|v| v.kind.as_ref()) {
                    Some(Kind::IntegerValue(n)) => *n,
                    _ => return Err(IndexError::Payload("chunk")),
                },
                score: hit.score,
            })
        })
        .collect()
}

/// Moves a string out of the payload map (no copy); errors if it's missing or not a string.
fn take_string(
    payload: &mut HashMap<String, Value>,
    key: &'static str,
) -> Result<String, IndexError> {
    match payload.remove(key).and_then(|v| v.kind) {
        Some(Kind::StringValue(s)) => Ok(s),
        _ => Err(IndexError::Payload(key)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::embed::Sparse;

    fn payload_keys(meta: Option<&Meta>) -> Vec<String> {
        let embedding = Embedding {
            dense: vec![0.0],
            sparse: Sparse {
                indices: vec![],
                values: vec![],
            },
        };
        let p = point(0, "t".into(), "s", "f", 0, embedding, meta);
        let mut keys: Vec<String> = p.payload.into_keys().collect();
        keys.sort();
        keys
    }

    #[test]
    fn payload_gets_type_and_known_date() {
        assert_eq!(payload_keys(None), ["chunk", "file", "source", "text"]);
        let mut meta = Meta {
            title: None,
            doc_type: "invoice".into(),
            date: Some("2025-03-14".into()),
            people: vec![],
            issuer: None,
            folder: None,
        };
        assert_eq!(
            payload_keys(Some(&meta)),
            ["chunk", "date", "file", "source", "text", "type"]
        );
        meta.date = None;
        assert_eq!(
            payload_keys(Some(&meta)),
            ["chunk", "file", "source", "text", "type"]
        );
    }
}
