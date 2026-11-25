# The shared model setting

Let's RAG Docs and Let's Triage Mail talk to the same local model server, so they share one
small file that says which one. This page is identical in both repos.

Decided 2026-11-24.

## The file

`~/.config/lets-code/model.toml`, next to each app's own config (`~/.config/lets-rag-docs/` and
`~/.config/lets-triage-mail/`). TOML. Nothing secret is ever stored in it.

```toml
runtime = "ollama"
url = "http://localhost:11434"
model = "qwen3:8b"
set_by = "rag docs"
updated = "2026-11-25T09:00:00+01:00"
```

| key | meaning |
|---|---|
| `runtime` | `ollama`, `lmstudio` or `custom` |
| `url` | the server's address, without a path. Both apps add `/v1` (the OpenAI-compatible API); a trailing `/v1` is accepted too |
| `model` | the chat and classify model's name, for example `qwen3:8b` |
| `set_by` | the app that wrote it: `rag docs` or `triage mail` |
| `updated` | when it was written, as an RFC 3339 timestamp |

Every key is optional. Keys an app does not know are ignored, so a newer version of one app
never breaks the other. Only `url` and `model` change what an app calls; `runtime`, `set_by`
and `updated` are for people and for the apps' screens.

## Which model an app uses

1. **The app's own config wins.** If `[llm]` in the app's `config.toml` sets `base_url` or
   `model`, the shared file is not looked at at all. That app keeps the setup you chose, and
   everyone who already has a config keeps working unchanged.
2. **Otherwise the shared file**, one key at a time: a missing or blank `url` or `model` falls
   back to the next step.
3. **Otherwise the app's built-in default** (Ollama on `127.0.0.1:11434`).

A missing, unreadable or invalid file counts as an empty one (an invalid file also logs a
warning). The apps' privacy rule still applies to the result: a model server outside this machine
and your own network is refused unless the app's own config sets `allow_remote = true`. The
shared file cannot switch that on.

## Who writes it

Only the model step of onboarding and the model row in each app's settings. A write replaces the
whole file: it goes to a temporary file in the same folder, is flushed to disk and renamed over
the old one, so the other app never reads half a file. Writing refuses an unknown `runtime` or
`set_by`, an empty `url` or `model`, and a `url` that carries a user name or password.

## The recommended model

If the detected runtime already has a usable chat model, onboarding preselects it, with no
download. Otherwise it suggests one by the Mac's memory:

| memory | model |
|---|---|
| 8 GB | `qwen3:4b` |
| 16 GB | `qwen3:8b` |
| 32 GB or more | `qwen3:14b` |

These are placeholders until each size has been tested.

## Embeddings stay per app

Let's RAG Docs keeps its embedding model, bge-m3, in its own Python sidecar and downloads it
there, not through Ollama. Let's Triage Mail has no embedding model. Neither is part of this file.
