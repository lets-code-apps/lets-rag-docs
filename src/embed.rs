//! Client for the bge-m3 embedding sidecar (`embed_server.py`): `POST {url}/embed`.

use serde::{Deserialize, Serialize};

/// Texts per request, so one huge document doesn't become one giant request.
const BATCH: usize = 32;

/// bge-m3's two views of one text: a dense vector (meaning) and sparse token weights (keywords).
#[derive(Debug, Clone)]
pub struct Embedding {
    pub dense: Vec<f32>,
    pub sparse: Sparse,
}

/// Sparse vector: token ids and their weights, same order in both lists.
#[derive(Debug, Clone, Deserialize)]
pub struct Sparse {
    pub indices: Vec<u32>,
    pub values: Vec<f32>,
}

#[derive(Debug, thiserror::Error)]
pub enum EmbedError {
    #[error("embed service request failed (is embed_server.py running?): {0}")]
    Http(#[from] reqwest::Error),
    #[error("embed service answered {status}: {body}")]
    Status {
        status: reqwest::StatusCode,
        body: String,
    },
    #[error("embed service returned {got} embeddings for {sent} texts")]
    CountMismatch { sent: usize, got: usize },
}

#[derive(Serialize)]
struct Request<'a> {
    texts: &'a [String],
}

#[derive(Deserialize)]
struct Response {
    dense: Vec<Vec<f32>>,
    sparse: Vec<Sparse>,
}

pub struct EmbedClient {
    http: reqwest::Client,
    url: String,
}

impl EmbedClient {
    pub fn new(base_url: &str) -> Self {
        EmbedClient {
            http: reqwest::Client::new(),
            url: format!("{}/embed", base_url.trim_end_matches('/')),
        }
    }

    /// Embeds `texts` in batches; the result has one `Embedding` per text, in the same order.
    pub async fn embed(&self, texts: &[String]) -> Result<Vec<Embedding>, EmbedError> {
        let mut out = Vec::with_capacity(texts.len());
        for batch in texts.chunks(BATCH) {
            let resp = self
                .http
                .post(&self.url)
                .json(&Request { texts: batch })
                .send()
                .await?;
            let status = resp.status();
            if !status.is_success() {
                let body = resp.text().await.unwrap_or_default();
                return Err(EmbedError::Status { status, body });
            }
            let Response { dense, sparse } = resp.json().await?;
            if dense.len() != batch.len() || sparse.len() != batch.len() {
                return Err(EmbedError::CountMismatch {
                    sent: batch.len(),
                    got: dense.len().min(sparse.len()),
                });
            }
            // into_iter() moves each Vec out of the response instead of copying it.
            out.extend(
                dense
                    .into_iter()
                    .zip(sparse)
                    .map(|(dense, sparse)| Embedding { dense, sparse }),
            );
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, Request as MockRequest, ResponseTemplate};

    #[tokio::test]
    async fn batches_requests_and_keeps_order() {
        let server = MockServer::start().await;
        // Echo service: each text's dense vector is [its length], so order is checkable.
        Mock::given(method("POST"))
            .and(path("/embed"))
            .respond_with(|req: &MockRequest| {
                let body: serde_json::Value = serde_json::from_slice(&req.body).unwrap();
                let texts = body["texts"].as_array().unwrap();
                let dense: Vec<_> = texts
                    .iter()
                    .map(|t| vec![t.as_str().unwrap().len() as f32])
                    .collect();
                let sparse: Vec<_> = texts
                    .iter()
                    .map(|_| serde_json::json!({"indices": [7], "values": [0.5]}))
                    .collect();
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"dense": dense, "sparse": sparse}))
            })
            .expect(2) // 33 texts = one full batch of 32 + one of 1
            .mount(&server)
            .await;

        let texts: Vec<String> = (0..33).map(|n| "x".repeat(n)).collect();
        let got = EmbedClient::new(&server.uri()).embed(&texts).await.unwrap();

        assert_eq!(got.len(), 33);
        for (n, e) in got.iter().enumerate() {
            assert_eq!(e.dense, vec![n as f32]);
            assert_eq!(e.sparse.indices, vec![7]);
        }
    }
}
