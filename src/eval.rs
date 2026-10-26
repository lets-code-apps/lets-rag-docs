//! Retrieval eval: does each question find its expected document in the top 5? (port of `rag.py eval`)

use std::collections::HashSet;

use anyhow::Context;
use serde::Deserialize;

use crate::config::Config;
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
    fn row_ignores_extra_fields() {
        let line = r#"{"id":"x1","lang":"en","question":"q","expect":"e","source":"s"}"#;
        let row: Row = serde_json::from_str(line).unwrap();
        assert_eq!(row.source, "s");
    }
}
