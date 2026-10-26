# Let's RAG Docs

Local, private RAG over your scanned documents. It turns PDFs and photos into searchable text, finds the
passages that answer a question, and returns them with their source. Nothing leaves your machine.

> Status: early. OCR, indexing, search and retrieval evals work as CLI scripts. The MCP server and
> `ask` are planned (see [Roadmap](#roadmap)).

## What it is

Two ways to use it:

1. **As a tool for LLMs** (main use). An MCP server exposes `search_docs`. Any agent that speaks MCP
   (your own agent, a chat UI, a voice assistant) calls it and gets back passages plus the document
   and page they came from. The agent's own model writes the answer.
2. **Standalone.** `ask` retrieves passages, builds the prompt and calls a local LLM through any
   OpenAI-compatible API (Ollama by default), then answers with citations. No other services needed.

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

Later: extracting facts (dates, amounts, rates) into a small SQL table at ingestion, because vector
search alone is unreliable for questions like "when does this loan end?".

## Stack

- OCR: embedded PDF text when present, otherwise Apple Vision (macOS)
- Embeddings: [bge-m3](https://huggingface.co/BAAI/bge-m3), dense + sparse, multilingual
  (tested with Polish, Russian and English)
- Vector DB: [Qdrant](https://qdrant.tech) in Docker, bound to localhost
- LLM for `ask`: any OpenAI-compatible endpoint, e.g. [Ollama](https://ollama.com)

## Usage

```sh
docker compose up -d                      # Qdrant, dashboard at http://localhost:6333/dashboard
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt

.venv/bin/python ocr.py <folder>          # extract text into data/ocr/
.venv/bin/python rag.py ingest            # (re)build the index
.venv/bin/python rag.py search "question" # show the best matching chunks
.venv/bin/python rag.py eval              # did the right document come back? (evals/rag.jsonl)
```

## Privacy

Your documents, OCR output and eval questions stay out of git: `docs/`, `data/` and
`evals/rag.jsonl` are in `.gitignore`. Qdrant only listens on 127.0.0.1.

## Roadmap

- [ ] MCP server with `search_docs`
- [ ] `ask`: standalone answers with citations through an OpenAI-compatible API
- [ ] Synthetic sample documents and a public eval set
- [ ] Reranking and metadata filters (document type, date)
- [ ] Structured facts layer (SQL) for dates and amounts
