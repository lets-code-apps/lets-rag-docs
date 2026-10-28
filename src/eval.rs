//! Retrieval eval: does each question find its expected document in the top 5? (port of `rag.py eval`)
//! Classification eval (`eval --classify`): did `classify` get each document's type and date?

use std::collections::HashSet;

use anyhow::Context;
use serde::{Deserialize, Serialize};

use crate::config::Config;
use crate::db;
use crate::embed::EmbedClient;
use crate::index;
use crate::search::{self, Passage};

/// Hits fetched per question; the top 5 distinct documents are picked from these.
const HITS: u64 = 20;
const TOP_DOCS: usize = 5;

/// One line of the eval file. Other fields (`id`, `expect`) are ignored, not rejected.
#[derive(Debug, Deserialize)]
struct Row {
    lang: String,
    question: String,
    source: String,
}

/// The first `TOP_DOCS` distinct sources, in hit order (`dict.fromkeys(...)[:5]` in rag.py).
fn top_docs(hits: &[Passage]) -> Vec<&str> {
    let mut seen = HashSet::new();
    hits.iter()
        .map(|h| h.source.as_str())
        .filter(|s| seen.insert(*s))
        .take(TOP_DOCS)
        .collect()
}

/// Runs every eval question and prints the result; fails if any question missed.
pub async fn run(config: &Config) -> anyhow::Result<()> {
    let path = &config.paths.evals;
    let text =
        std::fs::read_to_string(path).with_context(|| format!("cannot read {}", path.display()))?;
    let rows = text
        .lines()
        .filter(|l| !l.trim().is_empty())
        .enumerate()
        .map(|(n, l)| {
            serde_json::from_str(l)
                .with_context(|| format!("{}: bad line {}", path.display(), n + 1))
        })
        .collect::<anyhow::Result<Vec<Row>>>()?;

    let embed = EmbedClient::new(&config.embed.url);
    let qdrant = index::connect(&config.qdrant.url)?;
    let mut found = 0;
    for r in &rows {
        let hits = search::search_docs(
            &embed,
            &qdrant,
            &config.qdrant.collection,
            &r.question,
            HITS,
        )
        .await?;
        let docs = top_docs(&hits);
        let rank = docs.iter().position(|d| *d == r.source).map(|i| i + 1);
        let shown = rank.map_or("-".to_string(), |n| n.to_string());
        println!(
            "{:<4} rank={shown}  [{}] {}",
            if rank.is_some() { "ok" } else { "MISS" },
            r.lang,
            r.question
        );
        match rank {
            Some(_) => found += 1,
            None => println!("       expected: {}\n       got:      {docs:?}", r.source),
        }
    }
    println!("\nright document in top {TOP_DOCS}: {found}/{}", rows.len());
    if found < rows.len() {
        anyhow::bail!(
            "{} of {} eval questions missed",
            rows.len() - found,
            rows.len()
        );
    }
    Ok(())
}

/// One line of `evals/classify.jsonl`, matched to the database by `hash`.
#[derive(Debug, Serialize, Deserialize)]
struct ClassifyRow {
    hash: String,
    /// The original's path, only to help whoever corrects the file.
    source: String,
    #[serde(rename = "type")]
    doc_type: String,
    date: Option<String>,
}

/// Compares the database with the expected type and date of each document. Without an eval
/// file, writes a draft from the database for the owner to correct.
pub fn run_classify(config: &Config) -> anyhow::Result<()> {
    // shortcut: fixed name next to the retrieval evals, add a [paths] key if it must live elsewhere.
    let path = config.paths.evals.with_file_name("classify.jsonl");
    let conn = db::open(&config.paths.db)?;
    if !path.exists() {
        let docs = db::all(&conn)?;
        if docs.is_empty() {
            anyhow::bail!("no classified documents yet: run `lets-rag-docs classify` first");
        }
        let mut out = String::new();
        for d in docs {
            let row = ClassifyRow {
                hash: d.hash,
                source: d.path,
                doc_type: d.meta.doc_type,
                date: d.meta.date,
            };
            out.push_str(&serde_json::to_string(&row)?);
            out.push('\n');
        }
        if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(&path, out).with_context(|| format!("cannot write {}", path.display()))?;
        println!(
            "draft written to {} — correct it by hand, then rerun",
            path.display()
        );
        return Ok(());
    }

    let text = std::fs::read_to_string(&path)
        .with_context(|| format!("cannot read {}", path.display()))?;
    let (mut types_ok, mut dates_ok, mut total) = (0, 0, 0);
    for (n, line) in text.lines().filter(|l| !l.trim().is_empty()).enumerate() {
        let want: ClassifyRow = serde_json::from_str(line)
            .with_context(|| format!("{}: bad line {}", path.display(), n + 1))?;
        let got = db::get(&conn, &want.hash)?.map(|d| d.meta);
        let type_ok = got.as_ref().is_some_and(|m| m.doc_type == want.doc_type);
        let date_ok = got.as_ref().is_some_and(|m| m.date == want.date);
        let mark = |ok| if ok { "ok  " } else { "MISS" };
        println!(
            "type {}  date {}  {}",
            mark(type_ok),
            mark(date_ok),
            want.source
        );
        total += 1;
        types_ok += usize::from(type_ok);
        dates_ok += usize::from(date_ok);
    }
    println!("type {types_ok}/{total}, date {dates_ok}/{total}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hit(source: &str) -> Passage {
        Passage {
            text: String::new(),
            source: source.to_string(),
            file: String::new(),
            chunk: 0,
            score: 0.0,
        }
    }

    #[test]
    fn top_docs_keeps_first_five_distinct_in_order() {
        let hits: Vec<Passage> = ["b", "a", "b", "c", "a", "d", "e", "f"]
            .into_iter()
            .map(hit)
            .collect();
        assert_eq!(top_docs(&hits), ["b", "a", "c", "d", "e"]);
    }

    #[test]
    fn classify_eval_writes_a_draft_then_scores_it() {
        let dir = tempfile::tempdir().unwrap();
        let config = Config {
            paths: crate::config::PathsConfig {
                evals: dir.path().join("evals/rag.jsonl"),
                db: dir.path().join("db.sqlite"),
                ..Default::default()
            },
            ..Config::default()
        };
        let conn = db::open(&config.paths.db).unwrap();
        // No documents: no empty draft.
        assert!(run_classify(&config).is_err());
        let meta = db::Meta {
            title: None,
            doc_type: "bank".into(),
            date: Some("2025-01-31".into()),
            people: vec![],
            issuer: None,
            folder: None,
        };
        db::put(
            &conn,
            &db::Doc {
                hash: "h1".into(),
                path: "a.pdf".into(),
                meta,
            },
        )
        .unwrap();

        run_classify(&config).unwrap();
        let draft = dir.path().join("evals/classify.jsonl");
        let line = std::fs::read_to_string(&draft).unwrap();
        assert_eq!(
            line,
            "{\"hash\":\"h1\",\"source\":\"a.pdf\",\"type\":\"bank\",\"date\":\"2025-01-31\"}\n"
        );
        // Scoring the draft against the same database passes; a corrected line can miss.
        run_classify(&config).unwrap();
        std::fs::write(&draft, line.replace("bank", "loan")).unwrap();
        run_classify(&config).unwrap();
    }

    #[test]
    fn row_ignores_extra_fields() {
        let line = r#"{"id":"x1","lang":"en","question":"q","expect":"e","source":"s"}"#;
        let row: Row = serde_json::from_str(line).unwrap();
        assert_eq!(row.source, "s");
    }
}
