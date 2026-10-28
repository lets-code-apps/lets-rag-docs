# Let's RAG Docs

Local, private RAG over your scanned documents. It turns PDFs and photos into searchable text, finds the
passages that answer a question, and returns them with their source. Nothing leaves your machine.

> Status: early, but the whole path works: OCR, indexing, hybrid search, retrieval evals, the MCP
> server and `ask`.

## What it is

Two ways to use it:

1. **As a tool for LLMs** (main use). An MCP server exposes `search_docs`. Any agent that speaks MCP
   (your own agent, a chat UI, a voice assistant) calls it and gets back passages plus the document
   they came from. The agent's own model writes the answer.
2. **Standalone.** `ask` retrieves passages, builds the prompt and calls a local LLM through any
   OpenAI-compatible API (Ollama by default), then answers with citations.

```
documents ─► OCR ─► chunks ─► bge-m3 (dense + sparse) ─► Qdrant
                                                            │
             question ─► hybrid retrieval ◄─────────────────┘
                              │
              ┌───────────────┴───────────────┐
        MCP: search_docs                 ask (standalone)
     passages + citations          passages ─► local LLM ─► answer + citations
       → your agent's LLM
```

## Scope

In scope: OCR, chunking, embeddings, the vector index, retrieval (hybrid search, filters, reranking),
retrieval evals, the MCP server and the standalone `ask`.

Out of scope: voice, conversation memory, reminders and other assistant features. Those belong to
the agent that calls this tool.

## Stack

- **OCR** (`ocr.py`, `vision_ocr.swift`): embedded PDF text when present, otherwise Apple Vision
  (macOS, offline). Writes one text file per document to `data/ocr/`.
- **`lets-rag-docs`**: one Rust binary for chunking, ingest, search, evals, the MCP server (stdio)
  and `ask`.
- **Embeddings** (`embed_server.py`): [bge-m3](https://huggingface.co/BAAI/bge-m3), dense + sparse,
  multilingual (tested with Polish, English, Russian and Ukrainian). A small Python sidecar on
  127.0.0.1:8100, using the Mac GPU.
- **Vector DB**: [Qdrant](https://qdrant.tech) in Docker, bound to 127.0.0.1. Hybrid search fuses
  the dense and sparse results (RRF).
- **LLM for `ask`**: any OpenAI-compatible endpoint, e.g. [Ollama](https://ollama.com)
  (default model `qwen3:30b-a3b`).

## Setup

```sh
docker compose up -d                      # Qdrant, dashboard at http://localhost:6333/dashboard
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cargo build --release                     # → target/release/lets-rag-docs

mkdir -p ~/.config/lets-rag-docs
cp config.example.toml ~/.config/lets-rag-docs/config.toml   # optional; the defaults work locally
```

Relative paths in the config (`data/ocr`, `evals/rag.jsonl`) resolve against the current
directory, so run the commands below from the repo root or make them absolute.

## Usage

```sh
.venv/bin/python ocr.py <folder>          # extract text into data/ocr/ (unchanged files are skipped)
.venv/bin/python embed_server.py          # keep running: the embedding service (~2 GB resident)

lets-rag-docs ingest                      # (re)build the index from data/ocr/
lets-rag-docs search "when does the warranty end"   # best-matching passages
lets-rag-docs eval                        # did the right document come back? (evals/rag.jsonl)
lets-rag-docs ask "when does the warranty end"      # answer with citations from a local LLM
lets-rag-docs mcp                         # MCP server over stdio
```

Register the MCP server with Claude Code (or point any MCP client at the same command):

```sh
claude mcp add lets-rag-docs -- /path/to/lets-rag-docs mcp
```

`search_docs(query, limit = 5)` returns `{text, source, file, chunk, score}` for each passage.
Evals are JSON lines: `{"id", "lang", "question", "expect", "source"}`; a question passes when its
`source` is among the first 5 distinct documents.

## Privacy

- Nothing leaves the machine: Qdrant, the embedding service and the LLM all run locally.
- `ask` refuses an LLM `base_url` that isn't on this machine or your own network, unless you set
  `allow_remote = true`.
- Document text is treated as data, never as instructions: `ask` fences passages in the prompt and
  the model only writes an answer.
- Your documents, OCR output and eval questions stay out of git: `docs/`, `data/` and
  `evals/rag.jsonl` are in `.gitignore`.

## Roadmap

- [x] MCP server with `search_docs`
- [x] `ask`: standalone answers with citations through an OpenAI-compatible API
- [ ] Classification at ingestion: title, type, date, people, issuer into SQLite (the facts layer)
- [ ] `add <file>` and an MCP `add_document` tool (used by Let's Triage Mail)
- [ ] `organize`: copy documents into a named folder structure on request, re-indexed
- [ ] Desktop app: browse, search, upload
- [ ] Synthetic sample documents and a public eval set
- [ ] Page markers, so citations name the page (today they name the document only)
- [ ] Reranking (bge-reranker-v2-m3) and metadata filters (document type, date)
