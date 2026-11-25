# Setup and usage

## Stack

- **OCR** (`ocr.py`, `vision_ocr.swift`): embedded PDF text when present, otherwise Apple Vision
  (macOS, offline). A PDF with text boxes or filled form fields on top (e.g. added in Preview)
  also goes through Vision, which reads what the page shows. Writes one text file per document to
  `data/ocr/`. Tests: `.venv/bin/python -m unittest test_ocr`.
- **`lets-rag-docs`**: one Rust binary for chunking, ingest, search, evals, the MCP server (stdio),
  `ask` and `add <file>` (one document end to end: OCR, classify, index).
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

Both Let's Code apps also read a shared `~/.config/lets-code/model.toml` for which model to use
(see [guide/MODEL.md](guide/MODEL.md)). If you write `[llm] base_url` or `model` in your own
`config.toml`, that wins and the shared file is ignored.

## Commands

```sh
.venv/bin/python ocr.py <folder> [--only=REL] [--out=DIR]  # extract text into data/ocr/
.venv/bin/python embed_server.py          # keep running: the embedding service (~2 GB resident)

lets-rag-docs ingest                      # (re)build the index from data/ocr/
lets-rag-docs add ~/inbox/invoice.pdf     # one document: copy it in, OCR, classify, index
lets-rag-docs search "when does the warranty end"   # best-matching passages
lets-rag-docs eval                        # did the right document come back? (evals/rag.jsonl)
lets-rag-docs ask "when does the warranty end"      # answer with citations from a local LLM
lets-rag-docs organize --dry-run          # planned copies and moves in library/; changes nothing
lets-rag-docs organize --apply            # copy originals into the library and re-embed the copies
lets-rag-docs mcp                         # MCP server over stdio
```

`ingest` drops the collection and rebuilds it from `data/ocr/`, so never run `add` and `ingest` at
the same time: a rebuild that lands in the middle of an `add` can drop the document `add` is
indexing (the next `ingest` restores it).

`organize --apply` re-indexes each copy under its library name, and the same
rebuild rule applies to it: `ingest` only knows the paths under `data/ocr/`, so it drops the
organized sources. Run `ingest`, then `organize --apply` again - that order, never the other way
round. Evals don't change: `eval` names each hit by its OCR file, which `--apply` keeps, so the
same `evals/rag.jsonl` scores the same before and after organizing.

## The library

The library is laid out for people browsing by hand (Finder, or a phone's file browser):

```
library/<folder>/<owner>/<year>/<date> <matter> - <title>.pdf
library/Finance/Jan Kowalski/2025/2025-03-14 Car loan - Repayment schedule.pdf
```

- **folder** comes from `[classify] folders`, **owner** (whose document it is: a family member or
  the family's own company) from `[classify] owners`. Fixed lists, so one family's documents in
  four languages share one folder each. Anything not on a list goes to `unsorted/` or to
  `shared_owner`. A document without a date skips the year level.
- The **date** comes first so every folder sorts oldest to newest. The **matter** (what the
  document concerns) keeps the name meaningful in search results and attachments, where the
  folder is not shown. `[classify] language` writes titles and matters in one language.
- Words with 8 or more digits (account, card, contract and ID numbers) never go into file names;
  the database keeps the full title.
- When a document's place changes (you edited a list, or re-classified), the next `--apply` moves
  its copy: it writes the new one, then removes the old one and any folder left empty. A copy
  you edited after filing is never removed. Originals are never touched.

After changing a list, or before the first `--apply`: run `classify --force`, then check the
result: `eval --classify` scores type, date, folder and owner against `evals/classify.jsonl`
(delete that file to get a fresh draft), and read the `--dry-run` output.

## MCP server

Register the MCP server with Claude Code (or point any MCP client at the same command):

```sh
claude mcp add lets-rag-docs -- /path/to/lets-rag-docs mcp
```

`search_docs(query, limit = 5)` returns `{text, source, file, chunk, score}` for each passage.
`add_document(path)` files one document (an absolute path) and returns `{source, file, type, date,
chunks, duplicate_of}` - metadata and counts, never document text. `add <file>` runs the same
pipeline from the command line.

## Evals

Evals are JSON lines: `{"id", "lang", "question", "expect", "source"}`; a question passes when its
`source` is among the first 5 distinct documents.

## Privacy, in detail

- Nothing leaves the machine: Qdrant, the embedding service and the LLM all run locally.
- `ask` refuses an LLM `base_url` that isn't on this machine or your own network, unless you set
  `allow_remote = true`.
- Document text is treated as data, never as instructions: `ask` fences passages in the prompt and
  the model only writes an answer.
- Your documents, OCR output and eval questions stay out of git: `docs/`, `data/`, `library/` (the
  copies `organize --apply` files) and `evals/rag.jsonl` are in `.gitignore`.

## Roadmap

- [x] MCP server with `search_docs`
- [x] `ask`: standalone answers with citations through an OpenAI-compatible API
- [x] Classification at ingestion: title, type, date, people, issuer into SQLite (the facts layer)
- [x] `add <file>` and an MCP `add_document` tool (used by Let's Triage Mail)
- [x] `organize`: copy documents into a named folder structure on request, re-indexed
- [ ] Desktop app: browse, search, upload
- [ ] Synthetic sample documents and a public eval set
- [ ] Page markers, so citations name the page (today they name the document only)
- [ ] Reranking (bge-reranker-v2-m3) and metadata filters (document type, date)
