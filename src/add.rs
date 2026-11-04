//! `lets-rag-docs add <file>`: push ONE document through the whole pipeline — land it in `docs_dir`,
//! OCR it (shelling out to `ocr.py`), classify it, index it. The MCP `add_document` tool and the
//! CLI both call `add_file`, so there is exactly one implementation.
//!
//! Steps run in a fixed order (in `prepare`). No document text is returned or logged: the `Added`
//! result and the CLI output carry metadata and counts only.

use std::path::{Path, PathBuf};

use anyhow::{Context, anyhow, bail};
use qdrant_client::Qdrant;
use qdrant_client::qdrant::PointStruct;
use serde::Serialize;
use tokio::process;

use crate::ask::check_base_url;
use crate::chunk;
use crate::classify;
use crate::config::Config;
use crate::db;
use crate::embed::EmbedClient;
use crate::index;

/// Extensions `ocr.py` can read (its `TYPES`), without the leading dot.
const OCR_TYPES: [&str; 7] = ["pdf", "jpg", "jpeg", "png", "heic", "tif", "tiff"];

/// What `add` reports about a document: metadata and counts, never its text or title.
#[derive(Debug, Serialize)]
pub struct Added {
    /// Citation source (what `search` keys passages by), e.g. `invoice-2025`.
    pub source: String,
    /// The document's path relative to `[paths] docs_dir`.
    pub file: String,
    #[serde(rename = "type")]
    pub doc_type: String,
    pub date: Option<String>,
    pub chunks: usize,
    pub duplicate_of: Option<String>,
}

/// Runs `add <file>` for the CLI: build the clients, run the pipeline, print a counts line.
pub async fn run(config: &Config, file: &Path) -> anyhow::Result<()> {
    let embed: EmbedClient = EmbedClient::new(&config.embed.url);
    let qdrant: Qdrant = index::connect(&config.qdrant.url)?;
    let added: Added = add_file(config, &embed, &qdrant, file).await?;
    println!("{:<12} {}", added.doc_type, added.file);
    if let Some(other) = &added.duplicate_of {
        println!("already added as {}", other);
    } else {
        println!("added {}: {} chunks", added.file, added.chunks);
    }
    Ok(())
}

/// The full pipeline for one file: `prepare` (OCR, classify, store, embed) then the Qdrant round
/// trip. Kept whole so `run`, the MCP tool and the end-to-end test share one path.
pub(crate) async fn add_file(
    config: &Config,
    embed: &EmbedClient,
    qdrant: &Qdrant,
    file: &Path,
) -> anyhow::Result<Added> {
    let prepared: Prepared = prepare(config, embed, file).await?;
    if prepared.duplicate {
        return Ok(prepared.added);
    }
    index::ensure_collection(qdrant, &config.qdrant.collection).await?;
    index::delete_file(qdrant, &config.qdrant.collection, &prepared.ocr_file).await?;
    index::upsert(qdrant, &config.qdrant.collection, prepared.points).await?;
    Ok(prepared.added)
}

/// `prepare` does steps 1-10 and builds the points, but does not touch Qdrant. Splitting the
/// index step out keeps the pipeline testable with no vector store running.
async fn prepare(config: &Config, embed: &EmbedClient, file: &Path) -> anyhow::Result<Prepared> {
    // 1. The LLM must be local before any file is touched (no document text leaves the machine).
    check_base_url(&config.llm)?;

    // 2. Resolve the path (collapsing symlinks and `..`), then require a real, OCR-able file.
    //    The checks run on the RESOLVED path, so a link `x.pdf -> secret.txt` is refused.
    let resolved: PathBuf =
        std::fs::canonicalize(file).with_context(|| format!("cannot find {}", file.display()))?;
    if !resolved.is_file() {
        bail!("{} is not a regular file", resolved.display());
    }
    let ext: String = resolved
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if !OCR_TYPES.contains(&ext.as_str()) {
        bail!(
            "{}: extension {:?} is not one of {:?}",
            resolved.display(),
            ext,
            OCR_TYPES
        );
    }

    // 3. Content hash: the dedup key, same helper `classify` uses.
    let hash: String = classify::hash_file(&resolved)
        .with_context(|| format!("cannot hash {}", resolved.display()))?;

    // 4. Name it under docs_dir: keep the path if it already lives there, else take the base name
    //    (and copy it there in step 6). docs_dir is created if this is the first document.
    std::fs::create_dir_all(&config.paths.docs_dir)
        .with_context(|| format!("cannot create docs_dir {}", config.paths.docs_dir.display()))?;
    let docs_root: PathBuf = std::fs::canonicalize(&config.paths.docs_dir)
        .with_context(|| format!("cannot open docs_dir {}", config.paths.docs_dir.display()))?;
    let copy: bool = !resolved.starts_with(&docs_root);
    let rel: PathBuf = if copy {
        PathBuf::from(resolved.file_name().unwrap().to_string_lossy().to_string())
    } else {
        resolved.strip_prefix(&docs_root).unwrap().to_path_buf()
    };
    let rel_string: String = rel.to_string_lossy().to_string();

    // 5. Same content already filed under a different name => a duplicate: report it, do nothing
    //    else (no copy, no OCR, no LLM, no index). One document per content hash.
    let existing: Option<db::Doc> = lookup(&config.paths.db, &hash)?;
    if let Some(doc) = &existing
        && doc.path != rel_string
    {
        return Ok(Prepared {
            duplicate: true,
            points: Vec::new(),
            ocr_file: String::new(),
            added: Added {
                source: chunk::source_name(&doc.path),
                file: rel_string,
                doc_type: doc.meta.doc_type.clone(),
                date: doc.meta.date.clone(),
                chunks: 0,
                duplicate_of: Some(doc.path.clone()),
            },
        });
    }

    // 6. Copy the original into docs_dir when it is not already there; originals are never moved
    //    or renamed. A different file already using the name is an error, never an overwrite.
    if copy {
        let dest: PathBuf = docs_root.join(&rel);
        if dest.is_file() {
            let dest_hash: String = classify::hash_file(&dest)
                .with_context(|| format!("cannot hash existing {}", dest.display()))?;
            if dest_hash != hash {
                bail!(
                    "a different file named {} is already in docs_dir",
                    rel_string
                );
            }
        } else {
            std::fs::copy(&resolved, &dest)
                .with_context(|| format!("cannot copy into {}", dest.display()))?;
        }
    }

    // 7. OCR just this file: --only so nothing else is touched, --out to ocr_dir. The `=` form
    //    means a leading-dash name (say -x.pdf) is a value, never an option.
    run_ocr(config, &rel).await?;
    let ocr_abs: PathBuf = find_ocr_output(config, &rel)?;
    let ocr_file: String = ocr_abs
        .strip_prefix(&config.paths.ocr_dir)
        .unwrap()
        .to_string_lossy()
        .to_string();

    // 8. Read the text; nothing to index or classify when OCR found no text.
    let text: String = std::fs::read_to_string(&ocr_abs)
        .with_context(|| format!("cannot read OCR output {}", ocr_abs.display()))?;
    if chunk::chunks(&text).is_empty() {
        bail!("no text found in the file");
    }

    // 9. Classify: reuse the stored row's metadata on a re-add, otherwise ask the model. An LLM
    //    error leaves the original and the OCR file in place, with no DB row and nothing indexed.
    let meta: db::Meta = match &existing {
        Some(doc) => doc.meta.clone(),
        None => {
            let system: String = classify::system_prompt(&config.classify.types);
            classify::classify_text(&config.llm, &config.classify.types, &system, &text)
                .await
                .map_err(|e| {
                    anyhow!(
                        "classify failed for {}: {} (re-run add to retry)",
                        rel_string,
                        e
                    )
                })?
        }
    };

    // 10. Store the row before embedding, so a later embed/Qdrant failure keeps the slow LLM answer.
    store(
        &config.paths.db,
        &db::Doc {
            hash,
            path: rel_string.clone(),
            meta: meta.clone(),
        },
    )?;

    // Embed and build the points. The Qdrant write is add_file's, not prepare's.
    let source: String = chunk::source_name(&ocr_file);
    let points: Vec<PointStruct> =
        index::document_points(embed, &ocr_file, text, Some(&meta)).await?;
    let chunks: usize = points.len();

    Ok(Prepared {
        duplicate: false,
        points,
        ocr_file,
        added: Added {
            source,
            file: rel_string,
            doc_type: meta.doc_type,
            date: meta.date,
            chunks,
            duplicate_of: None,
        },
    })
}

/// The intermediate state of `prepare`: the metadata-only result plus the points that `add_file`
/// writes to Qdrant (empty for a duplicate).
struct Prepared {
    added: Added,
    points: Vec<PointStruct>,
    ocr_file: String,
    duplicate: bool,
}

/// rusqlite's Connection is not `Sync`, so it must never straddle an `await`. These tiny sync
/// helpers open the DB, run one statement and return an owned value: the MCP handler's future stays
/// `Send` (and so does this pipeline's).
fn lookup(db_path: &Path, hash: &str) -> anyhow::Result<Option<db::Doc>> {
    let conn = db::open(db_path)?;
    Ok(db::get(&conn, hash)?)
}

fn store(db_path: &Path, doc: &db::Doc) -> anyhow::Result<()> {
    let conn = db::open(db_path)?;
    db::put(&conn, doc)?;
    Ok(())
}

/// Runs `ocr.py` for one file. `python` and `script` come from `[ocr]`. Arguments go to the
/// program one at a time (no shell), so there is no quoting or injection; `kill_on_drop` stops the
/// child if an MCP call is cancelled.
async fn run_ocr(config: &Config, rel: &Path) -> anyhow::Result<()> {
    let mut cmd: process::Command = process::Command::new(&config.ocr.python);
    cmd.arg(&config.ocr.script);
    cmd.arg(&config.paths.docs_dir);
    cmd.arg(format!("--only={}", rel.to_string_lossy()));
    cmd.arg(format!("--out={}", config.paths.ocr_dir.to_string_lossy()));
    cmd.stdin(std::process::Stdio::null());
    cmd.kill_on_drop(true);
    let output = cmd
        .output()
        .await
        .with_context(|| format!("cannot run OCR ({})", config.ocr.python.display()))?;
    if !output.status.success() {
        let code: i32 = output.status.code().unwrap_or(-1);
        let err: String = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let chars: Vec<char> = err.chars().collect();
        let tail: String = chars[chars.len().saturating_sub(500)..].iter().collect();
        bail!("OCR failed (exit {}): {}", code, tail);
    }
    Ok(())
}

/// `ocr.py` writes `<rel>.<method>.txt` under ocr_dir: the text method for a digital PDF, vision
/// for a scan or photo. This std has no mtime access, so when both exist (the file was OCR'd before
/// with a different result) `.text.txt` wins; only the one `add` just needed is read.
fn find_ocr_output(config: &Config, rel: &Path) -> anyhow::Result<PathBuf> {
    let ocr: PathBuf = config.paths.ocr_dir.clone();
    let rel_s: String = rel.to_string_lossy().to_string();
    let text: PathBuf = ocr.join(format!("{}.text.txt", rel_s));
    let vision: PathBuf = ocr.join(format!("{}.vision.txt", rel_s));
    let chosen: PathBuf = if text.is_file() {
        text
    } else if vision.is_file() {
        vision
    } else {
        bail!("no OCR output for {}", rel_s)
    };
    Ok(chosen)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{EmbedConfig, LlmConfig, OcrConfig, PathsConfig};
    use qdrant_client::qdrant::CountPointsBuilder;
    use serde_json::{Value, json};
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, Request as MockRequest, ResponseTemplate};

    /// The JSON a good LLM answer returns for our synthetic OCR text (folder is kept: it is safe).
    const GOOD: &str = "{\"title\": \"Receipt\", \"type\": \"receipt\", \"date\": \"2025-05-01\", \
        \"people\": [], \"issuer\": \"ACME\", \"folder\": \"Home\"}";

    /// A sh script that stands in for `ocr.py`: it reads `--only=`/`--out=`, logs its own args, and
    /// writes one synthetic `.text.txt` (incl. a Cyrillic line). So `cargo test` needs no Python,
    /// Swift or GPU. `LOG` is replaced with the log file's real path.
    fn fake_ocr(root: &Path, log: &Path) -> PathBuf {
        let script: PathBuf = root.join("fake_ocr.sh");
        let body: &str = r#"#!/bin/sh
rel="${2#--only=}"
out="${3#--out=}"
printf '%s\n' "$2 $3 $1" >> "LOG"
out_dir="$out/$(dirname "$rel")"
mkdir -p "$out_dir"
printf '%s\n' "Receipt ACME 42/2025" "Total 12 EUR" "Scan Скан 3" > "$out/$rel.text.txt"
"#;
        std::fs::write(&script, body.replace("LOG", log.to_string_lossy().as_ref())).unwrap();
        script
    }

    /// A sh script that stands in for an `ocr.py` that fails: stderr plus a non-zero exit.
    fn fake_ocr_fail(root: &Path) -> PathBuf {
        let script: PathBuf = root.join("fail_ocr.sh");
        std::fs::write(&script, "#!/bin/sh\necho bad ocr >&2\nexit 1\n").unwrap();
        script
    }

    /// A sh script that stands in for an `ocr.py` whose output is only whitespace.
    fn fake_ocr_empty(root: &Path, log: &Path) -> PathBuf {
        let script: PathBuf = root.join("empty_ocr.sh");
        let body: &str = r#"#!/bin/sh
rel="${2#--only=}"
out="${3#--out=}"
printf '%s\n' "$2 $3 $1" >> "LOG"
out_dir="$out/$(dirname "$rel")"
mkdir -p "$out_dir"
printf '%s\n' "   " > "$out/$rel.text.txt"
"#;
        std::fs::write(&script, body.replace("LOG", log.to_string_lossy().as_ref())).unwrap();
        script
    }

    /// A wiremock embed service: dense is `[text length]`, so one vector per text, order preserved.
    async fn embed_mock() -> MockServer {
        let server: MockServer = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/embed"))
            .respond_with(|req: &MockRequest| {
                let body: Value = serde_json::from_slice(&req.body).unwrap();
                let texts = body["texts"].as_array().unwrap();
                let dense: Vec<Vec<f64>> = texts
                    .iter()
                    .map(|t| vec![t.as_str().unwrap().len() as f64])
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

    /// A wiremock Ollama-style chat server returning `GOOD`; `calls` is how often the LLM must be hit.
    async fn llm_mock(calls: u64) -> MockServer {
        let server: MockServer = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({"choices": [{"message": {"content": GOOD}}]})),
            )
            .expect(calls)
            .mount(&server)
            .await;
        server
    }

    /// A fresh tempdir with empty docs/ocr and the fake OCR installed (no Qdrant needed here).
    struct Setup {
        dir: tempfile::TempDir,
        docs: PathBuf,
        ocr: PathBuf,
        db: PathBuf,
        log: PathBuf,
        script: PathBuf,
    }

    fn setup() -> Setup {
        let dir: tempfile::TempDir = tempfile::tempdir().unwrap();
        let root: PathBuf = dir.path().to_path_buf();
        let docs: PathBuf = root.join("docs");
        let ocr: PathBuf = root.join("ocr");
        std::fs::create_dir_all(&docs).unwrap();
        std::fs::create_dir_all(&ocr).unwrap();
        let database: PathBuf = root.join("data/db.sqlite");
        let log: PathBuf = root.join("ocr_args.log");
        let script: PathBuf = fake_ocr(&root, &log);
        Setup {
            dir,
            docs,
            ocr,
            db: database,
            log,
            script,
        }
    }

    /// A Config pointing at the two mocks and a fresh tempdir.
    fn config(s: &Setup, llm: &MockServer, embed: &MockServer) -> Config {
        Config {
            embed: EmbedConfig {
                url: embed.uri().to_string(),
            },
            paths: PathsConfig {
                ocr_dir: s.ocr.clone(),
                docs_dir: s.docs.clone(),
                db: s.db.clone(),
                ..PathsConfig::default()
            },
            llm: LlmConfig {
                base_url: format!("{}/v1", llm.uri()),
                ..LlmConfig::default()
            },
            ocr: OcrConfig {
                python: PathBuf::from("sh"),
                script: s.script.clone(),
            },
            ..Config::default()
        }
    }

    fn rows(s: &Setup) -> Vec<db::Doc> {
        let conn = db::open(&s.db).unwrap();
        db::all(&conn).unwrap()
    }

    /// What OCR was asked to do, one line per run (empty when it never ran).
    fn log_lines(s: &Setup) -> Vec<String> {
        if !s.log.is_file() {
            return Vec::new();
        }
        std::fs::read_to_string(&s.log)
            .unwrap()
            .lines()
            .map(String::from)
            .collect()
    }

    #[tokio::test]
    async fn adds_a_new_file() {
        let s: Setup = setup();
        let source: PathBuf = s.dir.path().join("receipt.pdf");
        std::fs::write(&source, "not-a-real-pdf").unwrap();
        let embed_srv: MockServer = embed_mock().await;
        let llm_srv: MockServer = llm_mock(1).await;
        let embed: EmbedClient = EmbedClient::new(&embed_srv.uri());
        let cfg: Config = config(&s, &llm_srv, &embed_srv);
        let prepared: Prepared = prepare(&cfg, &embed, &source).await.unwrap();

        // The original was copied into docs_dir under its own name.
        assert!(s.docs.join("receipt.pdf").is_file());
        // OCR ran for this one file only: --only=<name>, not the whole folder.
        assert!(
            log_lines(&s)
                .iter()
                .any(|l| l.contains("--only=receipt.pdf"))
        );
        // One DB row: hash, docs_dir-relative path, validated metadata from the LLM.
        let stored: Vec<db::Doc> = rows(&s);
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].path, "receipt.pdf");
        assert_eq!(stored[0].meta.doc_type, "receipt");
        assert_eq!(stored[0].meta.folder, Some("Home".into()));
        // The result is counts plus citation keys, never document text.
        assert!(!prepared.duplicate);
        assert_eq!(prepared.added.file, "receipt.pdf");
        assert_eq!(prepared.added.source, "receipt");
        assert!(prepared.added.chunks > 0);
        assert_eq!(prepared.added.duplicate_of, None);
        assert!(prepared.points.len() == prepared.added.chunks);
    }

    #[tokio::test]
    async fn dash_leading_name_is_not_an_option() {
        let s: Setup = setup();
        let source: PathBuf = s.dir.path().join("-x.pdf");
        std::fs::write(&source, "not-a-real-pdf").unwrap();
        let embed_srv: MockServer = embed_mock().await;
        let llm_srv: MockServer = llm_mock(1).await;
        let embed: EmbedClient = EmbedClient::new(&embed_srv.uri());
        let prepared: Prepared = prepare(&config(&s, &llm_srv, &embed_srv), &embed, &source)
            .await
            .unwrap();
        // It reached the script as a value `--only=-x.pdf`, never as a bare option.
        assert!(log_lines(&s).iter().any(|l| l.contains("--only=-x.pdf")));
        assert!(prepared.added.chunks > 0);
    }

    #[tokio::test]
    async fn file_already_in_docs_dir_is_used_in_place() {
        let s: Setup = setup();
        std::fs::create_dir_all(s.docs.join("sub")).unwrap();
        let inside: PathBuf = s.docs.join("sub/in.pdf");
        std::fs::write(&inside, "in place").unwrap();
        let embed_srv: MockServer = embed_mock().await;
        let llm_srv: MockServer = llm_mock(1).await;
        let embed: EmbedClient = EmbedClient::new(&embed_srv.uri());
        prepare(&config(&s, &llm_srv, &embed_srv), &embed, &inside)
            .await
            .unwrap();
        let stored: Vec<db::Doc> = rows(&s);
        // Its name keeps the subfolder; nothing was copied (it is already under docs_dir).
        assert_eq!(stored[0].path, "sub/in.pdf");
        assert_eq!(s.docs.join("sub/in.pdf"), inside);
        assert!(
            log_lines(&s)
                .iter()
                .any(|l| l.contains("--only=sub/in.pdf"))
        );
    }

    #[tokio::test]
    async fn re_add_skips_the_llm() {
        let s: Setup = setup();
        let source: PathBuf = s.dir.path().join("x.pdf");
        std::fs::write(&source, "one pdf").unwrap();
        let embed_srv: MockServer = embed_mock().await;
        let llm_srv: MockServer = llm_mock(1).await; // only the first add calls the model
        let embed: EmbedClient = EmbedClient::new(&embed_srv.uri());
        let cfg: Config = config(&s, &llm_srv, &embed_srv);
        prepare(&cfg, &embed, &source).await.unwrap();
        // Second add: the hash is known, so its stored metadata is reused (no new LLM request).
        let second: Prepared = prepare(&cfg, &embed, &source).await.unwrap();
        assert!(!second.duplicate);
        assert!(second.added.chunks > 0);
        assert_eq!(rows(&s).len(), 1);
    }

    #[tokio::test]
    async fn same_content_other_name_is_a_duplicate() {
        let s: Setup = setup();
        let a: PathBuf = s.dir.path().join("one.pdf");
        let b: PathBuf = s.dir.path().join("two.pdf");
        std::fs::write(&a, "identical bytes").unwrap();
        std::fs::write(&b, "identical bytes").unwrap();
        let embed_srv: MockServer = embed_mock().await;
        let llm_srv: MockServer = llm_mock(1).await; // the duplicate does not call the model
        let embed: EmbedClient = EmbedClient::new(&embed_srv.uri());
        let cfg: Config = config(&s, &llm_srv, &embed_srv);
        prepare(&cfg, &embed, &a).await.unwrap();
        let dup: Prepared = prepare(&cfg, &embed, &b).await.unwrap();
        assert!(dup.duplicate);
        assert_eq!(dup.added.duplicate_of, Some("one.pdf".into()));
        assert_eq!(dup.added.chunks, 0);
        // No two.pdf landed in docs_dir, OCR never ran for it, and no second row exists.
        assert!(!s.docs.join("two.pdf").is_file());
        assert_eq!(log_lines(&s).len(), 1);
        assert_eq!(rows(&s).len(), 1);
    }

    #[tokio::test]
    async fn refuses_bad_input() {
        let s: Setup = setup();
        let embed_srv: MockServer = embed_mock().await;
        let llm_srv: MockServer = llm_mock(0).await; // every case bails before the model
        let embed: EmbedClient = EmbedClient::new(&embed_srv.uri());
        let cfg: Config = config(&s, &llm_srv, &embed_srv);
        let root: PathBuf = s.dir.path().to_path_buf();

        // a .txt is not OCR-able
        std::fs::write(root.join("a.txt"), "hi").unwrap();
        assert!(prepare(&cfg, &embed, &root.join("a.txt")).await.is_err());

        // a directory
        std::fs::create_dir(root.join("adir")).unwrap();
        assert!(prepare(&cfg, &embed, &root.join("adir")).await.is_err());

        // a missing file
        assert!(prepare(&cfg, &embed, &root.join("gone.pdf")).await.is_err());

        // a symlink x.pdf -> y.txt: checks run on the resolved path, so the .pdf is refused
        std::fs::write(root.join("y.txt"), "secret").unwrap();
        std::os::unix::fs::symlink(root.join("y.txt"), root.join("x.pdf")).unwrap();
        assert!(prepare(&cfg, &embed, &root.join("x.pdf")).await.is_err());

        // a name in docs_dir already used by different content is never overwritten
        std::fs::write(s.docs.join("dup.pdf"), "first").unwrap();
        std::fs::write(root.join("dup.pdf"), "second").unwrap();
        let err: String = prepare(&cfg, &embed, &root.join("dup.pdf"))
            .await
            .err()
            .unwrap()
            .to_string();
        assert!(err.contains("already in docs_dir"));
        assert_eq!(
            std::fs::read_to_string(s.docs.join("dup.pdf")).unwrap(),
            "first"
        );
    }

    #[tokio::test]
    async fn remote_llm_is_refused_before_any_work() {
        let s: Setup = setup();
        let source: PathBuf = s.dir.path().join("r.pdf");
        std::fs::write(&source, "hi").unwrap();
        let embed_srv: MockServer = embed_mock().await;
        let llm_srv: MockServer = llm_mock(0).await;
        let embed: EmbedClient = EmbedClient::new(&embed_srv.uri());
        let mut cfg: Config = config(&s, &llm_srv, &embed_srv);
        cfg.llm.base_url = "http://example.com/v1".to_string(); // a public host
        assert!(prepare(&cfg, &embed, &source).await.is_err());
        // Nothing was copied, OCR never ran.
        assert!(!s.docs.join("r.pdf").is_file());
        assert_eq!(log_lines(&s).len(), 0);
    }

    #[tokio::test]
    async fn ocr_failure_is_reported() {
        let s: Setup = setup();
        let source: PathBuf = s.dir.path().join("x.pdf");
        std::fs::write(&source, "hi").unwrap();
        let embed_srv: MockServer = embed_mock().await;
        let llm_srv: MockServer = llm_mock(0).await;
        let embed: EmbedClient = EmbedClient::new(&embed_srv.uri());
        let mut cfg: Config = config(&s, &llm_srv, &embed_srv);
        cfg.ocr.script = fake_ocr_fail(s.dir.path());
        let err: String = prepare(&cfg, &embed, &source)
            .await
            .err()
            .unwrap()
            .to_string();
        assert!(err.contains("OCR failed"));
        assert!(err.contains("bad ocr"));
        // No row: the run is retryable.
        assert_eq!(rows(&s).len(), 0);
    }

    #[tokio::test]
    async fn empty_ocr_text_is_an_error() {
        let s: Setup = setup();
        let source: PathBuf = s.dir.path().join("x.pdf");
        std::fs::write(&source, "hi").unwrap();
        let embed_srv: MockServer = embed_mock().await;
        let llm_srv: MockServer = llm_mock(0).await; // no text means no model call
        let embed: EmbedClient = EmbedClient::new(&embed_srv.uri());
        let mut cfg: Config = config(&s, &llm_srv, &embed_srv);
        cfg.ocr.script = fake_ocr_empty(s.dir.path(), &s.log);
        let err: String = prepare(&cfg, &embed, &source)
            .await
            .err()
            .unwrap()
            .to_string();
        assert!(err.contains("no text found"));
        assert_eq!(rows(&s).len(), 0);
    }

    #[tokio::test]
    async fn llm_failure_leaves_no_row() {
        let s: Setup = setup();
        let source: PathBuf = s.dir.path().join("x.pdf");
        std::fs::write(&source, "hi").unwrap();
        let embed_srv: MockServer = embed_mock().await;
        let embed: EmbedClient = EmbedClient::new(&embed_srv.uri());
        // The model answers 500: the original and the OCR file stay, but no row is stored.
        let llm_srv: MockServer = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(500).set_body_string("boom"))
            .expect(1)
            .mount(&llm_srv)
            .await;
        let cfg: Config = config(&s, &llm_srv, &embed_srv);
        assert!(prepare(&cfg, &embed, &source).await.is_err());
        assert_eq!(rows(&s).len(), 0);
        assert!(s.docs.join("x.pdf").is_file()); // original kept
    }

    #[ignore]
    #[tokio::test]
    async fn add_file_end_to_end() {
        // Needs a real Qdrant: run by hand with `cargo test -- --ignored` after starting it.
        let s: Setup = setup();
        let source: PathBuf = s.dir.path().join("scan.pdf");
        std::fs::write(&source, "a scan").unwrap();
        let embed_srv: MockServer = embed_1024().await;
        let llm_srv: MockServer = llm_mock(1).await;
        let embed: EmbedClient = EmbedClient::new(&embed_srv.uri());
        let mut cfg: Config = config(&s, &llm_srv, &embed_srv);
        cfg.qdrant.collection = "test-add-roundtrip".to_string();
        let qdrant: Qdrant = index::connect(&cfg.qdrant.url).unwrap();

        let first: Added = add_file(&cfg, &embed, &qdrant, &source).await.unwrap();
        let count: u64 = qdrant
            .count(CountPointsBuilder::new(cfg.qdrant.collection.clone()).exact(true))
            .await
            .unwrap()
            .result
            .unwrap()
            .count;
        assert_eq!(count, first.chunks as u64);

        // Re-add the same file: delete-then-upsert keeps the point count unchanged.
        let second: Added = add_file(&cfg, &embed, &qdrant, &source).await.unwrap();
        assert_eq!(second.chunks, first.chunks);
        qdrant
            .delete_collection(&cfg.qdrant.collection)
            .await
            .unwrap();
    }

    /// A 1024-dim embed mock (the real model's size), for the Qdrant end-to-end test.
    async fn embed_1024() -> MockServer {
        let server: MockServer = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/embed"))
            .respond_with(|req: &MockRequest| {
                let body: Value = serde_json::from_slice(&req.body).unwrap();
                let n: usize = body["texts"].as_array().unwrap().len();
                let dense: Vec<Vec<f64>> = (0..n).map(|_| vec![0.0; 1024]).collect();
                let sparse: Vec<Value> = (0..n)
                    .map(|_| json!({"indices": [1], "values": [1.0]}))
                    .collect();
                ResponseTemplate::new(200).set_body_json(json!({"dense": dense, "sparse": sparse}))
            })
            .mount(&server)
            .await;
        server
    }
}
