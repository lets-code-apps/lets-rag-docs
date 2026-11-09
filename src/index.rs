//! Qdrant over gRPC: the `documents` collection, laid out exactly like `rag.py` built it.
//!
//! Named vectors `dense` (1024, cosine) and sparse `sparse`; payload `text`, `source`, `file`,
//! `chunk`, plus `type` and `date` for classified documents (for metadata filters). Queries are RRF fusion of a dense and a sparse prefetch.

use std::collections::HashMap;

use sha2::{Digest, Sha256};

use qdrant_client::qdrant::value::Kind;
use qdrant_client::qdrant::{
    Condition, CreateCollectionBuilder, DeletePointsBuilder, Distance, Filter, Fusion,
    NamedVectors, PointStruct, PrefetchQueryBuilder, Query, QueryPointsBuilder,
    SparseVectorParamsBuilder, SparseVectorsConfigBuilder, UpsertPointsBuilder, Value, Vector,
    VectorInput, VectorParamsBuilder, VectorsConfigBuilder,
};
use qdrant_client::{Payload, Qdrant, QdrantError};

use crate::chunk;
use crate::db::Meta;
use crate::embed::{EmbedClient, EmbedError, Embedding};
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
    create(client, collection).await?;
    Ok(())
}

/// Creates the collection only if it is missing; `add` uses this so it never drops an index.
pub async fn ensure_collection(client: &Qdrant, collection: &str) -> Result<(), IndexError> {
    if !client.collection_exists(collection).await? {
        create(client, collection).await?;
    }
    Ok(())
}

/// The shared layout both `ingest` and `add` need: named `dense` (cosine) and `sparse` vectors.
async fn create(client: &Qdrant, collection: &str) -> Result<(), IndexError> {
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

/// A point's stable id: the first 8 bytes (big-endian) of SHA-256 of `"{file}\0{chunk}"`.
///
/// Same file + chunk => same id, so `ingest` and `add` agree and a re-add overwrites its own
/// points. Numbering points 0..N (as `ingest` used to) would let one document clobber another's.
pub fn point_id(file: &str, chunk: usize) -> u64 {
    let mut digest = Sha256::new();
    digest.update(file.as_bytes());
    digest.update(b"\x00");
    digest.update(format!("{chunk}").as_bytes());
    // finalize() is exactly 32 bytes, so a slice of 8 always converts: the unwrap never panics.
    u64::from_be_bytes(digest.finalize()[..8].try_into().unwrap())
}

/// Embeds and builds the points for one document: every chunk embedded as `"{source}\n{chunk}"`,
/// each point keyed by `point_id(file, chunk)`. Shared by `ingest` and `add`; `file` is the OCR
/// path relative to `ocr_dir` (what `delete_file` later matches on).
pub async fn document_points(
    embed: &EmbedClient,
    file: &str,
    text: String,
    meta: Option<&Meta>,
) -> Result<Vec<PointStruct>, EmbedError> {
    let source = chunk::source_name(file);
    let parts = chunk::chunks(&text);
    // The document's name fronts every chunk, so each chunk is findable by document name too.
    let inputs: Vec<String> = parts.iter().map(|c| format!("{source}\n{c}")).collect();
    let embeddings = embed.embed(&inputs).await?;
    Ok(parts
        .into_iter()
        .zip(embeddings)
        .enumerate()
        .map(|(n, (text, embedding))| {
            point(point_id(file, n), text, &source, file, n, embedding, meta)
        })
        .collect())
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

/// Deletes every point whose payload `file` equals `file` (one document's chunks). A re-`add`
/// runs delete-then-upsert, so it stays idempotent even when the chunk count changed.
pub async fn delete_file(client: &Qdrant, collection: &str, file: &str) -> Result<(), IndexError> {
    client
        .delete_points(
            DeletePointsBuilder::new(collection)
                .points(Filter::must([Condition::matches("file", file.to_string())]))
                .wait(true),
        )
        .await?;
    Ok(())
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
    use qdrant_client::qdrant::{CountPointsBuilder, Vectors};
    use serde_json::{Value, json};
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, Request as MockRequest, ResponseTemplate};

    fn payload_string(p: &PointStruct, key: &str) -> String {
        match p.payload.get(key).and_then(|v| v.kind.as_ref()) {
            Some(Kind::StringValue(s)) => s.to_string(),
            _ => panic!("payload has no string {key}"),
        }
    }

    /// The point's dense vector as plain floats (prost oneof: Vectors -> NamedVectors -> Vector
    /// -> Dense). Tests use it to see what was actually embedded.
    fn dense_of(p: &PointStruct) -> Vec<f32> {
        let vectors: Vectors = p.vectors.clone().unwrap();
        let named: NamedVectors = match vectors.vectors_options.clone().unwrap() {
            qdrant_client::qdrant::vectors::VectorsOptions::Vectors(named) => named,
            _ => panic!("expected named vectors"),
        };
        let vector: Vector = named.vectors.get(DENSE).unwrap().clone();
        match vector.vector.clone().unwrap() {
            qdrant_client::qdrant::vector::Vector::Dense(dense) => dense.data,
            _ => panic!("expected dense vector"),
        }
    }

    #[test]
    fn point_id_is_stable_and_distinct() {
        // Same file + chunk => the same id: that is what lets ingest and add agree, and a
        // re-add overwrite its own points.
        assert_eq!(point_id("a.pdf.text.txt", 3), point_id("a.pdf.text.txt", 3));
        assert_ne!(point_id("a.pdf.text.txt", 3), point_id("a.pdf.text.txt", 4));
        assert_ne!(point_id("a.pdf.text.txt", 3), point_id("b.pdf.text.txt", 3));
        // The \0 separator: without it, file "a" chunk 0 and file "a0" chunk "" would hash the
        // same characters; distinct inputs stay distinct.
        assert_ne!(point_id("a", 0), point_id("a0", 0));
    }

    #[tokio::test]
    async fn document_points_embeds_source_and_chunk() {
        let server: MockServer = embed_len_mock().await;
        let embed: EmbedClient = EmbedClient::new(&server.uri());
        let file = "sub/scan.pdf.text.txt".to_string();
        // Cyrillic on purpose: code points differ from bytes, so a wrong count would show.
        let text = "Invoice ACME 2025-05-01\nTotal 42 EUR\nScan Сkan".to_string();
        let meta: Meta = Meta {
            title: None,
            doc_type: "receipt".into(),
            date: Some("2025-05-01".into()),
            people: vec![],
            issuer: None,
            folder: None,
        };
        let points: Vec<PointStruct> = document_points(&embed, &file, text.clone(), Some(&meta))
            .await
            .unwrap();
        let parts = chunk::chunks(&text);
        let source = chunk::source_name(&file);
        assert_eq!(parts.len(), 1);
        assert_eq!(points.len(), 1);
        let p: PointStruct = points[0].clone();
        // The mock returns dense = [code points of the text it received], so the vector reveals
        // exactly what was embedded: the chunk fronted by the source name, never the bare chunk.
        let first = parts[0].as_str();
        let embedded = format!("{source}\n{first}");
        assert_eq!(dense_of(&p), vec![embedded.chars().count() as f32]);
        // The point carries ids from point_id and payload keys search needs (incl. type/date).
        let expected_id = point(
            point_id(&file, 0),
            "x".into(),
            "x",
            &file,
            0,
            Embedding {
                dense: vec![0.0],
                sparse: Sparse {
                    indices: vec![],
                    values: vec![],
                },
            },
            None,
        )
        .id;
        assert_eq!(p.id, expected_id);
        assert_eq!(payload_string(&p, "text"), parts[0]);
        assert_eq!(payload_string(&p, "source"), source);
        assert_eq!(payload_string(&p, "file"), file);
        assert_eq!(payload_string(&p, "type"), "receipt");
        assert_eq!(payload_string(&p, "date"), "2025-05-01");
    }

    #[ignore]
    #[tokio::test]
    async fn delete_file_removes_only_that_document() {
        // Needs a real Qdrant at 127.0.0.1:6334 (`docker compose up -d`): this repo has no CI,
        // so run it by hand with `cargo test -- --ignored`.
        let client: Qdrant = connect("http://127.0.0.1:6334").unwrap();
        let coll = "test-delete-file".to_string();
        if client.collection_exists(&coll).await.unwrap() {
            client.delete_collection(&coll).await.unwrap(); // start from empty
        }
        ensure_collection(&client, &coll).await.unwrap();
        let embedding: Embedding = Embedding {
            dense: vec![0.0; 1024],
            sparse: Sparse {
                indices: vec![1],
                values: vec![1.0],
            },
        };
        let one = "one.pdf.text.txt".to_string();
        let two = "two.pdf.text.txt".to_string();
        let points: Vec<PointStruct> = [
            point(
                point_id(&one, 0),
                "t".into(),
                "src",
                &one,
                0,
                embedding.clone(),
                None,
            ),
            point(
                point_id(&one, 1),
                "t".into(),
                "src",
                &one,
                1,
                embedding.clone(),
                None,
            ),
            point(
                point_id(&two, 0),
                "t".into(),
                "src",
                &two,
                0,
                embedding,
                None,
            ),
        ]
        .to_vec();
        upsert(&client, &coll, points).await.unwrap();
        let total: u64 = client
            .count(CountPointsBuilder::new(coll.clone()).exact(true))
            .await
            .unwrap()
            .result
            .unwrap()
            .count;
        assert_eq!(total, 3);
        // One document's chunks go; the other document's point survives.
        delete_file(&client, &coll, "one.pdf.text.txt")
            .await
            .unwrap();
        let after: u64 = client
            .count(CountPointsBuilder::new(coll.clone()).exact(true))
            .await
            .unwrap()
            .result
            .unwrap()
            .count;
        assert_eq!(after, 1);
        // Re-running the delete, and a name no point carries, are fine, not errors.
        delete_file(&client, &coll, "one.pdf.text.txt")
            .await
            .unwrap();
        delete_file(&client, &coll, "never-indexed.pdf.text.txt")
            .await
            .unwrap();
        delete_file(&client, &coll, "two.pdf.text.txt")
            .await
            .unwrap();
        let zero: u64 = client
            .count(CountPointsBuilder::new(coll.clone()).exact(true))
            .await
            .unwrap()
            .result
            .unwrap()
            .count;
        assert_eq!(zero, 0);
        client.delete_collection(&coll).await.unwrap();
    }

    /// Embed mock: dense is [code points of the text it was sent], one sparse per text. Lets a
    /// test see exactly which strings reached the model.
    async fn embed_len_mock() -> MockServer {
        let server: MockServer = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/embed"))
            .respond_with(|req: &MockRequest| {
                let body: Value = serde_json::from_slice(&req.body).unwrap();
                let texts = body["texts"].as_array().unwrap();
                let dense: Vec<Vec<f32>> = texts
                    .iter()
                    .map(|t| vec![t.as_str().unwrap().chars().count() as f32])
                    .collect();
                let sparse: Vec<Value> = texts
                    .iter()
                    .map(|_| json!({"indices": [7], "values": [0.5]}))
                    .collect();
                ResponseTemplate::new(200).set_body_json(json!({"dense": dense, "sparse": sparse}))
            })
            .mount(&server)
            .await;
        server
    }

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
