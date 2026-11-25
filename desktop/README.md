# Let's RAG Docs — desktop

A macOS menu-bar Electron companion for the `lets-rag-docs` Rust engine. It lives in the menu bar
(click the icon to show or focus the window, right-click for Open/Quit), shows the **overview**, **ask**, **filing**
and **settings** screens from the approved RagOverview/RagAsk/RagFiling/RagSettings designs, and calls the engine
one-shot over its command line. It never
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
| Screenshots | `npm run shots` | build, then drive the real page against the fake engine (type, click, save, re-sort) and `capturePage` overview (busy and clear), ask, the 10 RagFiling states and settings (and the 360px views), in light and dark: 44 PNGs under `screenshots/` |
| Compare | `npm run compare -- <baseline> <shots> [out]` | diff `<shots>` against `<baseline>` PNGs with Electron's `nativeImage` (no image library): writes `out/compare-report.md`, `out/compare-report.json` and `out/diff/<name>.png` for changed shots, exits non-zero if anything changed |
| Icons | `npm run icons` | re-render `assets/*.png` from SVG (see below) |

## Engine contract

The desktop builds argv itself; the renderer only sends data. Expected engine states are exit 0 JSON
data; real failures exit non-zero with empty stdout and a reason on stderr.

| Call | Desktop API | Shape |
|---|---|---|
| `documents --json` | `rag.documents()` | `{version, max_file_mb, status, documents:[{path,title,type,date,folder,owner,filed_as,bytes,pages,skipped,dataless}]}` — `dataless:true` marks an iCloud-only file (macOS `SF_DATALESS` bit, read from metadata only, never downloaded) |
| `status --json` | `rag.status()` | `{version, model:{reachable}, last_sync:RFC3339|null}` — the engine probes `GET {base_url}/models` with its own 3 s timeout; `last_sync` is the library database file's mtime |
| `search --json --limit 20 -- <query>` | `rag.search()` | `{version, passages:[{source,file,chunk,page?,score}]}` — citation keys only, never text |
| `ask --json -- <question>` | `rag.ask()` | `{version, answer:string|null, sources:[{source,file,chunk,page?,score}]}` |
| `filing show --json` | `rag.filing()` | `{version, folders, owners, shared_owner}` |
| `filing save [--check]` (stdin JSON draft) | `rag.saveFiling()` | `{version, ok, saved, renamed, folders, owners, errors}` — the draft may add `renames:[{list,from,to}]` (stored copies re-file) and `shared_owner` (a string) |
| `add --json -- <file>` | `rag.addNext()` | `{version, status, source,file,type,date,chunks,duplicate_of}` — picked files queue in main, the renderer gets names only |
| `locate --json -- <path>` | `rag.openDocument()` | `{version, status, kind, path}` — main opens only what the engine vouches for |
| `organize --dry-run --json` | `rag.dryRun()` | `{version, mode, status, items, counts}` |
| `organize --apply --json` | `rag.resort()` | same shape as dry-run; refused unless the last report was a dry-run with `status:"ok"`, with no save and no apply since |

Time budgets: reads 10 s, dry-run 10 min (it hashes every original), apply 60 min (it copies and
re-embeds a batch through the local model), ask 6 min, add 20 min (OCR plus one embedding per file).
A call over budget is stopped and reported as "… timed out", never parsed as half a report.
`ask`, `add` and `apply` share one slot (local LLM and Qdrant writes, concurrency 1); `cancelAsk`
and `cancelAdd` kill the running child.

Binary lookup: `RAG_DOCS_ENGINE_PATH`, then `<resources>/engine/lets-rag-docs`, then
`<repo>/target/debug/lets-rag-docs`. `--config` is added only when `RAG_DOCS_CONFIG` is set.

## Sample data

None. Every value on screen comes from an engine report or from what the user typed; the page has no
demo or sample mode (a test checks). Designed details the engine cannot supply yet are left out and
listed as follow-ups in the PR: page counts and sizes in the library, "not indexed" pills (the design's "unreadable" and "password-protected" reasons need engine data we do not emit yet), page numbers
in citations, "open" for a cited document, the AppBar search and "add documents", editing the shared
owner's name, and a rename that also re-files documents (today they go to unsorted until
`lets-rag-docs classify --force`).

## Settings

The settings screen owns one setting: `appearance`. It writes a single `settings.json` (just
`{"appearance":"system"|"dark"|"light"}`) into the app's own userData folder, and `nativeTheme` makes
the window follow it through `prefers-color-scheme`. The other row, **open at login**, is the macOS
login item: it is read live from the OS every time the screen paints (so it reflects a change made in
System Settings, and is off by default) and written back with `app.setLoginItemSettings`; we never store
it in our file. `npm run smoke` and `npm run shots` use a throwaway temp file and an in-memory login
item, so a headless run never registers a real login item on the machine.

## Icons

`npm run icons` (`scripts/make-icons.mjs`) renders the PNGs with Electron's own Chromium, no image
library: `assets/menubarTemplate.png` / `@2x` (18 and 36 px, black on transparent) are drawn like Triage
Mail's `menubar.svg` with the RAG emblem's two text lines; `assets/icon.png` (1024 px) is a grain tile
(radius 23%) with the white emblem from `renderer/emblem.svg` at 64%. macOS tints the template through
`nativeImage.setTemplateImage(true)`; the dock icon is set only when running unpackaged.

## CI and the screenshot baseline

`.github/workflows/desktop.yml` runs two macOS jobs on every push to `desktop`/`feature/**` and every
pull request into `desktop` or `main`: `rust` (crate `cargo fmt --all --check`, `cargo clippy --all-targets
-- -D warnings`, `cargo test`) and `desktop` (`npm ci`, `typecheck`, `test`, `smoke`, `shots`, then a
baseline diff). The desktop job installs no Rust and the Rust job installs no Node, so each proves the
other's tests are not secretly load-bearing. The three `#[ignore]`d Rust tests (`src/add.rs`, `src/index.rs`,
`src/organize.rs`) need Qdrant through `docker compose`; macOS runners have no Docker, so `rust` runs the
default set only (noted in the YAML).

**Smoke is blocking and checks layout.** `npm run smoke` prints `SMOKE OK`/`SMOKE FAIL`; CI fails if the
`SMOKE OK` line is missing so a silent skip cannot go green. It also runs `src/geometry.ts` (`GEOMETRY`) on
ask, filing and settings at 1200px and 360px: the settings article sits against the sidebar, the library
search stays at the top of its pane (including with the add panel showing), the app name keeps 132px clear
on both sides of the bar, and every visible control is at least 44px. Any failure is listed in the `SMOKE FAIL`
line. Two controls are drawn under 44px today and are allow-listed in `KNOWN_SHORT` (`.seg button` 38px,
`.nav button` ≈39px); raising them is a separate design follow-up, so this CI change does not touch CSS.

**Reading the PR comment.** After `shots`, CI copies the committed PNGs to a temp baseline, takes fresh
shots, and runs `npm run compare`. If shots match, one comment (marked `<!-- desktop-shots -->`, updated on
each push, not stacked) says all 44 match. If not, it lists the changed shots and links the run artifact
(`desktop-ci-<run id>`) that holds the new `screenshots/*.png`, `smoke.txt`, `shots.txt`, `compare-report.md|json`,
`compare-measured.json`
and `diff/<name>.png` (red where pixels differ). The same markdown also lands in the step summary; on fork PRs
only the summary is written (a fork cannot comment).

**How to update the baseline.** When a change to the app intentionally moves pixels, regenerate and commit
together with that change:
```sh
cd desktop
cp -R screenshots /tmp/base          # snapshot the current baseline
npm run shots                       # re-render desktop/screenshots/ in place
npm run compare -- /tmp/base screenshots   # list what changed; commit only if intended
```
Then commit the new PNGs in the same commit as the change that caused them. If CI still disagrees with your
local render, take the PNGs from that run's `desktop-ci-<run id>` artifact and commit those instead — **the
CI render is the baseline**, not your laptop.

**Thresholds and noise.** `PIXEL_DELTA = 12` (a per-channel change of up to 12/255 does not count a pixel);
a shot is **changed** when over `MAX_RATIO = 0.002` (0.2%) of its pixels differ, on a size mismatch, or when a
pair is missing (`new`/`removed`). These are a starting point: run the CI job twice on an unchanged tree, record
the largest ratio you saw, keep `MAX_RATIO` at least 3× that and at most 0.5%, and write the measured noise here.
Every run also uploads `compare-measured.json` (the ratio of all 44 shots, green or red), which is where these
numbers come from. Measured on the fixed workflow, two runs against a CI-rendered baseline: run 44420909156 had
6 of 38 shots with any differing pixels, run 44421965171 had 5, and the largest ratio in either run was **0.0000258
(0.0026%)**. `MAX_RATIO = 0.002` is therefore ~77× the observed noise and still under the 0.5% ceiling — keep it
unless a real render change pushes the numbers up (the sizes already agree, so this is antialiasing noise only).
For #23 the baseline is regenerated at a fixed content size (1200×660 / 360×660); the two green runs of that
re-baseline (linked in the PR) re-measured this as antialiasing noise only — the per-shot numbers are in those
runs' `compare-measured.json` — so `PIXEL_DELTA = 12` and `MAX_RATIO = 0.002` are left unchanged.

**Known local-vs-CI differences.** The committed baseline is the **CI render**, not a Retina laptop. Shots are
sized by **content** (`setContentSize`), not by the outer window frame: **1200×660** (wide) and **360×660** (narrow),
under the macOS runner's visible screen height, so a window taller than the screen is never squeezed (a `setSize`
frame that was too tall used to be squeezed to ~677, which is what made the old captures disagree). `runShots`
waits for `getContentSize()` to match before driving and again right before capture, and fails a shot that never
settles with **expected vs actual** (plus the display's work area) in `shots.txt`. The written PNG's own pixel
size is checked against content size × the display's scale factor before it is written, so the CI render is
**1200×660 / 360×660 at 1×** and a Retina Mac's `npm run shots` captures exactly **2400×1320 / 720×1320 (2×)**.
A laptop still differs from the baseline in pixel size, so `npm run shots` + `npm run compare` there reports every
shot as changed — expected, because your laptop is not the reference. Regenerate the baseline by taking the PNGs
from a `desktop-ci-<run id>` artifact (they are the runner's render) and committing those; the runner re-renders
them identically, so CI goes green. Fonts are bundled (Poppins woff2) and controls use `font: inherit`, so within
the CI render text is stable; a runner macOS image bump can still shift antialiased pixels and force a re-baseline
from the artifact. Baseline updates add ~6.7 MB of PNG history each time, so keep them rare.

**Privacy.** CI adds no third-party service, cookie or personal data to the app. Smoke and shots hard-set
`test/fixtures/fake-engine.mjs` (a test checks this), so the artifacts and logs hold only synthetic output —
never document text.

## Boundary rules

- The model probe lives in the engine: `status --json` is how the app learns whether the model answers and when the library was last synced. The app itself makes no network calls and reads no config or database: Electron only spawns the engine.

- No network calls from the app: no Node HTTP/TLS/socket/dgram, no `fetch`, no Electron network/session fetch.
- Only `engine.ts` imports `child_process`; it spawns the engine one-shot.
- No database/TOML/HTTP npm dependencies and no Playwright dependency.
- No references to the private document paths inside the desktop source/renderer.
- The renderer is sandboxed, context-isolated, preload-only, CSP `default-src 'none'`, and never uses
  `innerHTML`, `outerHTML`, `insertAdjacentHTML` or `document.write`.
- Search, add and open cross through main: `rag.search`, `rag.pickFiles`, `rag.addNext`,
  `rag.cancelAdd`, `rag.openDocument`. Picked paths stay in main's queue (the page gets counts and
  names); the single `shell.openPath` call runs only on the `locate --json` result. The picker and
  opener are host seams: smoke/shots record paths in memory and hand back synthetic temp files.
- Smoke/screenshots always use `test/fixtures/fake-engine.mjs` and synthetic fixtures.
- The real macOS login item is touched only through the Electron host; `app.setLoginItemSettings` appears
  in that one host, and smoke/shots swap in an in-memory login item, so an unattended run registers nothing.