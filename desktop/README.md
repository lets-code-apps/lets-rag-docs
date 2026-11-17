# Let's RAG Docs — desktop

A macOS menu-bar Electron companion for the `lets-rag-docs` Rust engine. It opens **one hidden window
by default**, shows ask/filing screens, and calls the engine one-shot over its command line. It never
reads the repository's local model, database, config file or document folders itself, and it never
points the app at real data: `npm run smoke` and `npm run shots` hard-set `test/fixtures/fake-engine.mjs`.

## Requirements

- Node 24 and npm. Electron 45.2.3, TypeScript 5.9.3, `@types/node` 24.19.2.
- The desktop needs no Rust to run its unit tests. To use the real engine, build it with `cargo build`
  from the repository root, or set `RAG_DOCS_ENGINE_PATH` to a built binary.

## Commands

Run from this `desktop/` directory.

| Step | Command | Meaning |
|---|---|---|
| Setup | `npm ci` | install from `package-lock.json`; downloads the Electron binary once |
| Typecheck | `npm run typecheck` | `tsc -p tsconfig.json --noEmit` (types only, no output) |
| Test | `npm test` | `node --test test/*.test.ts` — pure logic, no GUI, no real engine |
| Build | `npm run build` | `tsc -p tsconfig.build.json` into `dist/` and copy `preload.cjs` |
| Dev launch | `npm start` | build, then open a visible window (`RAG_DOCS_START_WINDOW=1 electron .`) |
| Smoke | `npm run smoke` | build, then hidden Electron with the fake engine; exits `SMOKE OK` / `SMOKE FAIL` |
| Screenshots | `npm run shots` | build, then Electron `capturePage` writes synthetic light/dark PNGs under `screenshots/` |

## Engine contract

The desktop builds argv itself; the renderer only sends data. Expected engine states are exit 0 JSON
data; real failures exit non-zero with empty stdout and a reason on stderr.

| Call | Desktop API | Shape |
|---|---|---|
| `documents --json` | `rag.documents()` | `{version, status, documents:[{path,title,type,date,folder,owner,filed_as}]}` |
| `ask --json -- <question>` | `rag.ask()` | `{version, answer:string|null, sources:[{source,file,chunk,score}]}` |
| `filing show --json` | `rag.filing()` | `{version, folders, owners, shared_owner}` |
| `filing save [--check]` (stdin JSON draft) | `rag.saveFiling()` | `{version, ok, saved, folders, owners, errors}` |
| `organize --dry-run --json` | `rag.dryRun()` | `{version, mode, status, items, counts}` |
| `organize --apply --json` | `rag.resort()` | same shape as dry-run; apply is refused unless a fresh successful dry-run is cached |

Binary lookup: `RAG_DOCS_ENGINE_PATH`, then `<resources>/engine/lets-rag-docs`, then
`<repo>/target/debug/lets-rag-docs`. `--config` is added only when `RAG_DOCS_CONFIG` is set.

## Sample data

| Key | What the engine supplies today | What the UI marks as sample |
|---|---|---|
| citationSnippet | The engine supplies source, file and chunk numbers, but not page/snippet text. | citation snippet text |
| documentSize | The engine does not supply per-document size. | document size |
| indexHealth | The engine does not expose index freshness/health. | index health |

Every sample element is rendered with a visible `Sample data` pill and `data-sample="true"`.

## Icon generation

Run `node scripts/make-assets.mjs` from `desktop/` to write `assets/menubarTemplate.png`,
`assets/menubarTemplate@2x.png` and `assets/icon.png`. The assets are synthetic PNGs generated locally;
macOS tints the menu-bar glyph through `setTemplateImage(true)`, and the app icon is set only when running
unpackaged.

## Boundary rules

- No network calls from the app: no Node HTTP/TLS/socket/dgram, no `fetch`, no Electron network/session fetch.
- Only `engine.ts` imports `child_process`; it spawns the engine one-shot.
- No database/TOML/HTTP npm dependencies and no Playwright dependency.
- No references to the private document paths inside the desktop source/renderer.
- The renderer is sandboxed, context-isolated, preload-only, CSP `default-src 'none'`, and never uses
  `innerHTML`, `outerHTML`, `insertAdjacentHTML` or `document.write`.
- Smoke/screenshots always use `test/fixtures/fake-engine.mjs` and synthetic fixtures.