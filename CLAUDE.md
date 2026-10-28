# CLAUDE.md: project memory

Read this first. This repo is **public**: nothing personal goes into tracked files.

## What this is

**Let's RAG Docs**: local, private retrieval over scanned documents. OCR → chunks → bge-m3
(dense + sparse) → Qdrant → hybrid search. Nothing leaves the machine.

- Main use: an **MCP server** with `search_docs` that returns passages plus citations; the calling
  agent's own model writes the answer (in Piotr's setup, the household assistant).
- Also **standalone**: `ask` retrieves, calls a local LLM through any OpenAI-compatible API
  (Ollama by default) and answers with citations.
- In scope: OCR, chunking, embeddings, index, retrieval, retrieval evals, MCP, `ask`. Later: a SQL
  facts layer (dates, amounts) filled at ingestion. Out of scope: voice, conversation memory,
  reminders (those belong to the agent that calls this).
- Name: repo, crate and binary `lets-rag-docs`; GitHub `lets-code-apps/lets-rag-docs`.
- Owner: Piotr, a senior developer **learning Rust** (also via `lets-triage-mail`). Explain Rust
  concepts as they come up; prefer idiomatic, readable code over clever code. Follow the
  conventions of `~/Projects/lets-triage-mail` (tokio, reqwest + rustls, clap, toml config with
  unknown keys rejected, thiserror/anyhow, tracing).
- Docs, comments and commit messages in **English**.

## Hard rules

- **Private data never enters git:** `docs/`, `data/`, `design/`, `tests/oct test/`,
  `evals/rag.jsonl` hold a family's real documents (IDs, medical results, a loan) and are
  gitignored. Never un-ignore them, never quote them in tracked files, commit messages or test
  fixtures. Public samples and evals must be synthetic. Check `git status` before every commit.
- **No cloud.** Qdrant, the embed service and the LLM are local (127.0.0.1 or own LAN). `ask`
  refuses non-local `base_url` unless `allow_remote = true`, as in lets-triage-mail.
- **Document text is untrusted input.** In `ask` prompts, fence passages as data; the model only
  writes an answer, it never triggers actions.

## Shape (decided 2026-10-26)

Rust owns the service; Python stays only where its ecosystem is clearly better.

| Part | Language | Why |
|---|---|---|
| CLI, config, chunking, ingest, search, eval | **Rust** | The service people install: one binary |
| MCP server (`search_docs`) | **Rust**, official `rmcp` SDK, stdio first | The main product; stdio works with Claude Code and local agents. Streamable HTTP later if the household assistant runs as a separate service |
| `ask` | **Rust**, reqwest → OpenAI-compatible `/chat/completions` | Same pattern as lets-triage-mail |
| Qdrant access | **Rust**, `qdrant-client` crate over gRPC (127.0.0.1:6334, already exposed) | |
| **Embeddings** (bge-m3 dense + sparse) | **Python** sidecar `embed_server.py` (FlagEmbedding on the Mac GPU) | Sparse weights need FlagEmbedding; Ollama's bge-m3 is dense-only. One embedding model copy that other Rust services can share |
| OCR | **Python + Swift** (`ocr.py`, `vision_ocr.swift`) for now | Batch step; its contract is the text files in `data/ocr/`. Port later only if it pays off |

Rejected for now: bge-m3 through ONNX in-process (`ort` crate). It would remove Python but needs
a verified dense+sparse export and its Metal performance is unknown. Revisit if the sidecar
becomes a pain for users. Not Docker for the embed service: the Mac GPU (MPS) isn't available
in Docker.

### Contracts

**Embed service** (`embed_server.py`, stdlib `http.server`, binds 127.0.0.1:8100, model loaded
once, requests handled one at a time):

```
POST /embed  {"texts": ["...", ...]}
→ {"dense": [[f32; 1024], ...], "sparse": [{"indices": [u32], "values": [f32]}, ...]}
GET /health  → {"ok": true}
```

Note: it keeps ~2 GB resident. Fine during the day; add idle unload if it gets in the way.

**Qdrant collection** `documents` (same layout `rag.py` built, so the index carried over during the port):
named vectors `dense` (1024, cosine) and sparse `sparse`; payload `text`, `source`, `file`,
`chunk`. Query = RRF fusion of dense and sparse prefetches (limit 20 each).

**Chunking matched `rag.py` exactly; frozen by `testdata/chunk_cases.json`** (the eval baseline depends on it): skip blank lines;
start a new chunk when the current one plus the next line would exceed 1500 chars (Python
`len` = Unicode code points → Rust `chars().count()`, not `len()`); carry the last 3 lines into
the next chunk. Each chunk is embedded as `"{source}\n{chunk}"`. `source` = path relative to
`data/ocr/` with the last three dot-parts removed (`a/b.pdf.text.txt` → `a/b`; Python
`rsplit(".", 3)[0]` → Rust `rsplitn(4, '.').last()`).

**MCP tool** `search_docs(query: string, limit: int = 5)` → list of
`{text, source, file, chunk, score}`. No page numbers yet: OCR output has no page markers
(add page markers to `ocr.py` later).

**Eval** `evals/rag.jsonl` lines: `{"id", "lang", "question", "expect", "source"}`. Pass = the
expected `source` is among the first 5 distinct sources. **Baseline 2026-10-26: 10/10**
(PL/EN/RU/UK), measured with `rag.py`. The Rust port must match it: **Rust 10/10 on
2026-10-27** (one rank differs, 3 vs 2, likely fp16 batching: Rust embeds 32 texts per request,
`rag.py` a whole file per call).

### Config

`~/.config/lets-rag-docs/config.toml`, with a commented `config.example.toml` in the repo:
`[qdrant] url, collection`, `[embed] url`, `[paths] ocr_dir, evals`, `[llm] base_url, model,
max_tokens, timeout_seconds, allow_remote` (default model `qwen3:30b-a3b`, which is already
installed in Ollama; strip Qwen3 `<think>` blocks from answers).

### Planned layout

```
Cargo.toml
src/main.rs     clap: ingest | search <q> | eval | mcp | ask <q>
src/config.rs
src/chunk.rs    port of rag.py chunks() + source naming, tested against testdata/chunk_cases.json
src/embed.rs    client for the embed service
src/index.rs    Qdrant: create collection, upsert, hybrid RRF query
src/search.rs   core API: search_docs(query, limit) -> Vec<Passage>; MCP and ask build on it
src/eval.rs
src/mcp.rs
src/ask.rs
embed_server.py
ocr.py, vision_ocr.swift
```

## Implementation plan

1. `embed_server.py` + `requirements.txt`. Checked: its vectors equalled what `rag.py` computed.
2. Rust crate: config, chunk (tests compare with `rag.py`), embed client, index, search, eval.
   Done when `lets-rag-docs ingest && lets-rag-docs eval` gives 10/10. Phases, one commit each:
   - **2a** `Cargo.toml`, `config.example.toml`, `src/main.rs` (clap: ingest | search | eval),
     `src/config.rs`, `src/chunk.rs`. Committed tests use synthetic text only (incl. Cyrillic,
     a line over 1500 chars, blank lines); expected values produced by `rag.py`'s `chunks()`.
     The comparison against real `data/ocr/` files was an `#[ignore]` test that read them at
     run time and never copied their text anywhere tracked (removed with `rag.py` in step 5).
   - **2b** `src/embed.rs` (reqwest client for the embed service, wiremock test),
     `src/index.rs` (qdrant-client gRPC: recreate collection, upsert, RRF query),
     `src/search.rs` (`search_docs`), wire `ingest` and `search`.
   - **2c** `src/eval.rs`, wire `eval`. Ran `rag.py ingest && rag.py eval`, then
     `cargo run -- ingest && cargo run -- eval`; both were 10/10.
3. `lets-rag-docs mcp` (`rmcp`, stdio). Register it in Claude Code and try real questions.
4. `lets-rag-docs ask` with citations through Ollama.
5. Remove `rag.py`; update README (stack, usage, roadmap). **Done 2026-10-28.**
6. **Classify at ingestion** (decided 2026-10-28; this is the SQL facts layer). After OCR, send
   the first few thousand chars to the local LLM and ask for strict JSON: `title`, `type`, `date`,
   `people`, `issuer`, `folder`. `type` comes from a fixed list in `config.toml` (`[classify]
   types`), not free text. Validate the output (document text is untrusted): anything invalid →
   type `unsorted`, never a path built from raw model output. Store in SQLite keyed by a hash of
   the document's content (`documents` table: hash, path, title, type, date, people, issuer,
   folder); copy `type`/`date` into the Qdrant payload for metadata filters. Originals are never
   renamed or moved here; title and folder are metadata only. Backfilling the existing documents
   is a night job. Needs its own eval (expected type + date for each document) before
   `organize` is trusted.
7. **`lets-rag-docs add <file>`**: OCR one file (calls `ocr.py`), classify, index. Single entry
   point for the CLI, the MCP tool and the app. Same MCP server gets an `add_document` tool;
   Let's Triage Mail calls it (as an MCP client) for mail it marked "keep" (e.g. invoices).
8. **`lets-rag-docs organize --dry-run | --apply`**: explicit only. Copies originals into
   `<library>/<folder>/<title>.<ext>` and re-indexes them under the new path: delete the
   document's points, re-embed (`source` is part of the embedded text, so updating the payload
   alone isn't enough). One document per content hash, so the copy and the original never show
   up as duplicates. Eval `source` values change after `organize`; match evals by hash or update
   `evals/rag.jsonl` in the same run.
9. **Desktop app**: browse by folder, ask a question and see the best-matching documents,
   upload (→ `add`). Electron (owner's preference) or Tauri; both use a web UI, decide when we
   get there. With Electron the backend is the `lets-rag-docs` binary (MCP over stdio, the same
   server the agents use).
10. Later: synthetic sample docs + public eval set, page markers, reranking (bge-reranker-v2-m3).

## Environment

- Mac Studio (M5 Ultra, 96 GB). Ollama runs as a Homebrew service at 127.0.0.1:11434 and is
  shared with other local services (voice assistant, lets-triage-mail). Keep LLM concurrency at 1.
- Daytime: the machine belongs to client work. Keep big models off it during the day and schedule
  heavy batch jobs for the night.
- Qdrant: `docker compose up -d` (compose project `lets-rag-docs`, ports bound to 127.0.0.1).
- Python: `.venv` in the repo root (`python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`).
- System-wide model plan: `~/Projects/smart-home/Smart Home/local-model-stack.md`.
