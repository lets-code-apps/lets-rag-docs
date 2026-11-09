# Advanced RAG: what "RAG From Scratch" teaches and what we take from it

Source: [langchain-ai/rag-from-scratch](https://github.com/langchain-ai/rag-from-scratch), five
notebooks and a [video playlist](https://www.youtube.com/playlist?list=PLfaIDFEXuae2LXbO1_PKyVJiQ23ZztA0x)
(18 parts, early 2024). Read 2026-11-09.

## One correction first

The course uses **LangChain (LCEL chains) with OpenAI, Chroma and LangSmith tracing**. It does not
use **LangGraph** at all. LangGraph only shows up as links in parts 16 (CRAG) and 17 (Self-RAG),
pointing to notebooks in the langgraph repo. Every technique below is just a few LLM calls plus
some glue. The framework only gives that glue a name.

## The map

The course sorts RAG into stages. For each part: what it is, how the notebook does it, and where
we stand.

Legend: ✅ have it · 🟡 partly · ⬜ missing · ➖ not worth it here

### Basics (parts 1-4): indexing, retrieval, generation

| Part | Idea | Notebook | Us |
|---|---|---|---|
| 1 Overview | load → split → embed → store → retrieve → prompt → LLM | WebBaseLoader, RecursiveCharacterTextSplitter (1000/200), Chroma, gpt-3.5 | ✅ OCR → `chunk.rs` → bge-m3 → Qdrant → `ask` |
| 2 Indexing | Token counting, embeddings, cosine similarity | tiktoken, OpenAIEmbeddings | ✅ and better: dense **plus sparse** (hybrid) |
| 3 Retrieval | top-k similarity search | `as_retriever(k=1)` | ✅ RRF of dense+sparse prefetches |
| 4 Generation | "Answer only from this context" prompt | `prompt \| llm \| parser` | ✅ `ask` with fenced passages and citations |

Our baseline is already past the course's basic chain (hybrid search, citations, prompt-injection
fencing).

### Query translation (parts 5-9): rewrite the question before retrieval

**5 Multi-query.** The LLM writes 5 rephrasings, you retrieve for each one, then take the
*unique union*. This helps when the user's words don't match the document's words.

**6 RAG-Fusion.** Same as multi-query, but the result lists are merged with **Reciprocal Rank
Fusion** (`score += 1/(rank+60)` for each list a doc appears in) instead of a plain union. We
already use RRF, but only to fuse dense with sparse for *one* query.

**7 Decomposition.** Split a complex question into sub-questions. There are two ways:
- *recursive*: answer Q1, feed Q1+A1 into Q2, and so on (IRCoT / least-to-most papers);
- *individual*: answer each one separately, then synthesize from the Q+A pairs.

**8 Step-back.** Rewrite to a more generic question (few-shot), retrieve for both the original
and the generic one, and answer from both contexts.

**9 HyDE.** The LLM writes a *hypothetical answer passage* and you embed that instead of the
question, because a fake answer sits closer to real answers in vector space than a question does.

| Part | Fit for scanned family documents |
|---|---|
| 5/6 Multi-query + fusion | 🟢 **Good**, with a twist: our corpus is PL/EN/RU/UK. Let the variants be *translations* of the question. bge-m3 dense is multilingual already, but the **sparse** (lexical) side only matches words in the same language. |
| 7 Decomposition | 🟡 Occasionally useful ("compare the 2024 and 2025 invoices"). Later. |
| 8 Step-back | ➖ Built for world-knowledge questions. Ours are about specific facts in specific papers. |
| 9 HyDE | ➖/🟡 Cheap to try, but a hallucinated "ID card passage" carries invented numbers and names. Low priority, eval-gated. |

### Routing (part 10)

- **Logical routing.** Structured output (function calling) picks a datasource from a `Literal`
  enum. Then plain `if/else` sends the query to the matching chain.
- **Semantic routing.** Embed a few prompt templates, pick the one closest to the question.

Us: ⬜. We have exactly two "datasources" worth routing between: the **SQLite facts table**
(`documents`: title, type, date, people, issuer) and the **Qdrant passages**. "How many invoices
from Orange do I have?" is a SQL question. "What does the loan contract say about early repayment?"
is a vector question. This is logical routing, and it fits the existing classify design.

### Query construction (part 11): natural language → metadata filters

The LLM fills a schema (`content_search`, `earliest_publish_date`, `min_view_count`, ...) with
"only use if explicitly specified" on every filter. Then you run it as a filtered vector search
(LangChain calls it "self-query").

Us: 🟡 **the cheapest big win.** Step 6 (classify) already writes `type` and `date` into the
Qdrant payload, but `search_docs` never filters on them. Questions like "my 2025 medical results"
or "the newest invoice" need a filter, and similarity alone doesn't give one.

### Indexing (parts 12-14)

**12 Multi-representation.** Index an LLM-written **summary** per document, but return the
**full document** when the summary matches (MultiVectorRetriever: summaries in the vector store,
parents in a doc store keyed by `doc_id`). The parent-document retriever is the same idea with
small chunks pointing to big parents.

**13 RAPTOR.** Cluster chunks, summarize clusters, then cluster the summaries, recursively. That
builds a tree of summaries for "high-level" questions. (Link only, no code.)

**14 ColBERT.** One vector **per token**. Score = Σ over query tokens of the max similarity to any
doc token (MaxSim). This is very precise.

| Part | Fit |
|---|---|
| 12 Multi-representation / parent doc | 🟢 Many of our docs are short (IDs, results, invoices). Returning the **whole document** for a hit is often better than one chunk. We also already have a per-document `title` from classify, which works as a ready-made "summary" vector. |
| 13 RAPTOR | ➖ Made for big corpora of long documents with thematic questions. Ours is small and fact-based. |
| 14 ColBERT | 🟡 Nice fact: **bge-m3 already produces ColBERT vectors** (FlagEmbedding `return_colbert_vecs`), and Qdrant supports multivectors with MaxSim. It could be a third prefetch or a reranking stage, without a new model. It needs a reindex, and storage grows a lot. |

### Retrieval: re-ranking and active RAG (parts 15-17)

**15 Re-ranking.** Fetch more than you need (k=10-20), then reorder with a stronger model. The
notebook uses Cohere Rerank (cloud). The local equivalent is the cross-encoder
**bge-reranker-v2-m3**, which is already on our roadmap (step 10).

**16 CRAG (Corrective RAG).** After retrieval, **grade each passage** for relevance (an LLM
yes/no). If too few pass, **rewrite the query** and retrieve again. The original paper falls back
to web search, which we never do.

**17 Self-RAG.** After generation, also check that the **answer is grounded** in the passages
(hallucination grader) and that it **answers the question** (answer grader). If not, regenerate or
re-retrieve.

16 and 17 are the parts where LangGraph actually matters, because the flow has **loops and
branches**, and a linear chain can't express that:

```
retrieve → grade_documents ─(enough relevant)→ generate → grounded? ─yes→ answers question? ─yes→ END
                │                                  │no                       │no
                └─(too few)→ rewrite_query → retrieve        regenerate     rewrite_query → retrieve
```

Us: ⬜. This would be the new "orchestration" in `ask`.

### 18 Long context

Talk only: with 100k+ token windows, do you still need RAG? Answer: yes for cost, latency and
precision, but chunking can get coarser. For us, the corpus is small and many docs are short, so
passing whole documents (part 12) gets the same benefit.

## Glossary: the LangChain company's products

| Name | What it is | Local / open source? |
|---|---|---|
| **LangChain** | Base Python/JS library: prompt templates, model wrappers, retrievers, parsers, loaders, splitters. The course is built on it. | ✅ MIT, free |
| **LCEL** | LangChain Expression Language: the `prompt \| llm \| parser` pipe syntax that joins steps into a chain. Linear, no loops. | ✅ part of LangChain |
| **Integration packages** | `langchain-ollama`, `langchain-qdrant`, `langchain-community`, ...: connect LangChain to a specific model or store (ours: Ollama, Qdrant). | ✅ free |
| **LangGraph** | Library for flows with **loops and branches**: nodes (functions), edges, shared state, checkpoints. Needed for CRAG / Self-RAG. | ✅ MIT, free |
| **LangSmith** | Hosted tracing, datasets, evals, prompt playground. | ❌ cloud SaaS (free tier for one developer, paid beyond; self-hosting is enterprise-only) |
| **LangChain Hub** | Shared prompt library (`hub.pull(...)`), now part of LangSmith. | ❌ needs internet |
| **LangGraph Studio** | Visual debugger for graphs. | ⚠️ needs a LangSmith account |
| **LangGraph Platform** | Managed hosting for LangGraph apps (folded into the LangSmith brand). | ❌ paid cloud |
| **LangServe** | Older way to serve a chain as a REST API. | ✅ but legacy, skip |

Not from that company, but the local replacements for LangSmith:

| Name | What it is | Local / open source? |
|---|---|---|
| **Langfuse** | LLM observability: traces, datasets, evals, prompt management. Has a LangChain/LangGraph callback handler and accepts OpenTelemetry. Self-hosts with docker compose. | ✅ open source, self-hosted |
| **Arize Phoenix** | LLM tracing and evals on OpenTelemetry. `pip install arize-phoenix`, runs as a local process with a web UI. | ✅ open source, local |
| **OpenTelemetry (OTel)** | Vendor-neutral standard for traces. Rust emits it via `tracing-opentelemetry`; both Langfuse and Phoenix ingest it. | ✅ standard |

## Decision (2026-11-09): fully local, no LangSmith

- Orchestration library for learning: **LangChain + LangGraph** (open source, local).
- Tracing and evals: **Langfuse** (self-hosted, primary), **Arize Phoenix** as the lighter
  alternative. **Never LangSmith**, not even for synthetic data, so no habit or config ever
  points at the cloud.
- When copying course code: drop the `LANGCHAIN_TRACING_V2` / `LANGCHAIN_ENDPOINT` /
  `LANGCHAIN_API_KEY` lines and replace `hub.pull(...)` with the prompt text inline.

## Does LangGraph / LangSmith fit this repo?

| Tool | What it is | Conflict with our rules |
|---|---|---|
| **LangGraph** | Open source (MIT), Python/JS. A state machine for LLM flows: `StateGraph`, nodes = functions over shared state, conditional edges, checkpointing, human-in-the-loop. | **Language.** "Rust owns the service." There is no Rust LangGraph. Putting it in the product means a second Python service for orchestration. |
| **LangSmith** | Tracing, datasets, evals, prompt playground. A **cloud SaaS**; self-hosting is an enterprise licence. | **Hard rule "No cloud".** Traces contain the retrieved passages, so family documents (IDs, medical results, the loan) would leave the machine. Not acceptable on real data. |

Local options that teach the same skills:
- **Arize Phoenix**: open source, `pip install` and run locally, OpenTelemetry-based tracing and evals.
- **Langfuse**: open source, self-hosts with docker compose, tracing, datasets and evals.
  Close to LangSmith in workflow.
- Both take **OpenTelemetry**, and Rust can emit that: we already use `tracing`, and
  `tracing-opentelemetry` exports spans. So the Rust service itself gets LangSmith-style traces
  on a local UI.

(Check current licences and versions when we start; this is from memory as of late 2026.)

## Recommendation: two tracks

### Track A: product (Rust, in this repo)

We implement the techniques that fit, as plain Rust. The orchestration is a small explicit state
machine in `ask` (an `enum Step` plus a loop). That *is* what LangGraph is, without the framework,
and it's good Rust practice (enums, `match`, ownership of state across steps).

The MCP tool stays thin. The calling agent (Claude Code, the household assistant) is already an
LLM that can rewrite queries and call `search_docs` again. That's **agentic RAG with the agent as
the orchestrator**. So MCP gets better *primitives* (filters, reranking, whole documents), and the
LLM loops (CRAG, Self-RAG) go into the standalone `ask`.

### Track B: learning (Python, separate, synthetic data only)

`lab/` (or a separate repo): a LangGraph notebook that rebuilds CRAG + Self-RAG on top of **our
own local services**: embed server on :8100, Qdrant, Ollama. It runs against a **synthetic**
collection (`documents_synthetic`, roadmap step 10's sample docs), never `documents`. Traces go to
a **self-hosted Langfuse** (docker compose, ports bound to 127.0.0.1, like Qdrant) via its
LangChain callback handler; Phoenix is the no-docker alternative. This gives the job-relevant
LangGraph + LLM-observability experience (traces, datasets, evals) with nothing in the cloud.

## Implementation plan (Track A)

Each phase is one PR, and none merges unless the eval says it didn't get worse.

### Phase 0: an eval that can show improvement

10/10 is saturated, so it can't show a gain. Before adding anything:
- Grow `evals/rag.jsonl` to ~40-60 questions (private, gitignored, written by Piotr). Include
  metadata questions ("newest invoice from X"), cross-language ones (ask in EN about a PL doc),
  and multi-doc ones.
- `eval` reports **recall@5, MRR** and per-language breakdown, not just pass/fail.
- Optional `eval --answers`: LLM-as-judge for `ask` (grounded? correct?) with expected answer
  facts in the jsonl. This is the local equivalent of a LangSmith dataset + evaluator.

### Phase 1: metadata filters (part 11, query construction)

- `index::query` takes an optional `Filter` (`type` match, `date` range). This is cheap in
  Qdrant: add `.filter()` to the query and each prefetch.
- `search_docs(query, limit, type?, date_from?, date_to?)`: the MCP schema lists the allowed types
  from `[classify] types`, so the calling agent builds the filter itself.
- `ask`: a small "query analyzer" LLM call → strict JSON `{query, type?, date_from?, date_to?}`,
  checked with the same rules as `classify::validate` (type must be in the list, dates must
  parse). If validation fails, search without filters, never with half-trusted ones.

### Phase 2: rerank (part 15)

- `embed_server.py`: `POST /rerank {query, texts} → {scores}` with bge-reranker-v2-m3 (same
  sidecar, one more model, ~2 GB).
- `search_docs`: fetch 20-30 via RRF → rerank → top `limit`. Expose `score` as the reranker score.
- Measure latency on the Mac. Make it a config switch (`[search] rerank = true`) only if the eval
  says it's sometimes worse.

### Phase 3: whole documents for short docs (part 12)

- After ranking, group hits by `file`. If a document has ≤ N chunks (e.g. 3), return the full
  text once instead of overlapping chunks. Dedupe by document, not by chunk.
- Optional: a document-level vector (title + type + first chunk) as an extra prefetch.

### Phase 4: multilingual multi-query + fusion (parts 5/6), in `ask` only

- One LLM call → JSON array of the question in PL/EN/RU/UK (+1 keyword-style variant).
- Retrieve for each, fuse with RRF across queries (a Rust `HashMap<point_id, f32>`, the same 10
  lines as the notebook's `reciprocal_rank_fusion`), then rerank once.
- Embed all variants in one `/embed` request (batching is already supported).

### Phase 5: corrective + self-checking `ask` (parts 16/17), the "graph"

```rust
enum Step { Analyze, Retrieve, Grade, Rewrite, Generate, CheckGrounded, Done }
```
- `Grade`: one LLM call scores all passages at once (JSON list of relevant ids). Grading one by
  one is too slow at LLM concurrency 1.
- Too few relevant → `Rewrite` (max 1-2 retries, a hard cap so it can't loop forever).
- `CheckGrounded`: is every claim backed by a cited passage? If not, regenerate once, else answer
  with a "not sure" note.
- `tracing` span per step with `step`, `retry`, `n_relevant`, and timings, which gives us our
  "LangSmith trace" in the terminal for free.
- Every LLM call still treats passage text as untrusted. Grader outputs are validated JSON, and
  they never pick tools or paths.

### Phase 6: routing to SQL facts (part 10)

- The query analyzer from Phase 1 also returns `route: "facts" | "passages" | "both"`.
- `facts`: a **fixed set** of SQLite queries (count by type, latest by type, list by issuer and
  year) with parameters filled from validated JSON. **Never** model-written SQL.
- MCP: a `list_documents(type?, date_from?, date_to?, issuer?)` tool returning metadata only.

### Phase 7 (optional): OpenTelemetry → local Langfuse (or Phoenix)

- `tracing-opentelemetry` exporter, off by default, endpoint must be local (same check as
  `allow_remote`). Same Langfuse instance as Track B, so Rust and Python traces sit side by side.
- Phoenix works with the same exporter (both ingest OTLP); switching is a config change.

### Not doing (and why)

Step-back (world-knowledge questions), RAPTOR (corpus too small), HyDE until the eval shows a
need (invents facts), ColBERT until reranking has been measured (both solve precision), and any
cloud reranker or tracer (LangSmith, Cohere Rerank).

## Order and size

| Phase | Value | Size | LLM calls added per question |
|---|---|---|---|
| 0 Eval | prerequisite | S | 0 (or judge) |
| 1 Filters | high | S | 0 MCP, 1 `ask` |
| 2 Rerank | high | M | 0 (cross-encoder, not LLM) |
| 3 Whole docs | medium | S | 0 |
| 4 Multi-query | medium | S | 1 |
| 5 CRAG/Self-RAG | medium (learning: high) | M | 2-4 |
| 6 SQL routing | medium | M | 0 (reuses analyzer) |
| 7 OTel | learning | S | 0 |

Track B can start any time in parallel; it only needs the synthetic sample docs.
