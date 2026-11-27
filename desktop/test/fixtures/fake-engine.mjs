#!/usr/bin/env node
// A stand-in for the real Rust engine, used by smoke and screenshots. Synthetic only: made-up
// names, no documents, no SQLite, no model. It speaks the same JSON contract as the engine.
//
// FAKE_SCENARIO:
//   fixtures   the committed `testdata/desktop` fixtures, byte for byte (the Rust tests lock them)
//   library    (default) a small synthetic library whose lists can be edited
//   no-owners  the same library, before any owner was added
//   clear      the same library with every document owned, indexed and downloaded (all-clear screen)
//   empty      no library database yet
//   outdated   the library was written by an older version of the engine
// FAKE_DRY_RUN_DELAY_MS: make `organize --dry-run` slow (it plans the lists read at its start).
// FAKE_ADD_DELAY_MS: make `add` slow, so the add panel can be caught mid-run.
// FAKE_MODEL=down: `status --json` answers that the model is not reachable (the overview shows
// the danger item; screenshots use it for the busy pass).
// FAKE_STATE_FILE: where `library`/`no-owners` keep the saved lists, filed copies and added files
// between calls (default: a file in the OS temp folder). Delete it to start over.
// The fake library root is /tmp/rag-docs-fake/library — what `locate` resolves paths to.
// First-run onboarding (LET-136), mirroring lets-triage mail's selector names:
// FAKE_MODEL_STATE=found|found-empty|not-found|shared|install: what `model detect` answers (default found).
// FAKE_DETECT_FOUND_AFTER=<n>: the first <n> detects answer not-found (the step re-checks itself).
// FAKE_PULL=ok|hold-42|fail: how `model pull` streams (hold-42 stops at 42% and waits for SIGTERM).
// FAKE_PICK_FOLDER=<path>: the folder the smoke/shots picker host returns (unset: the user cancelled).
// FAKE_ANSWERING=0: `status --json` says the model is reachable but did NOT answer a completion.
// Every engine call appends to state `calls` so smoke can assert exactly what setup saved.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TESTDATA = join(HERE, '..', '..', '..', 'testdata', 'desktop');
const argv = process.argv.slice(2);
// `--config <path>` comes first when RAG_DOCS_CONFIG is set; the fake engine has no config.
const args = argv[0] === '--config' ? argv.slice(2) : argv;
const scenario = process.env.FAKE_SCENARIO || 'library';
const STATE = process.env.FAKE_STATE_FILE || join(tmpdir(), 'lets-rag-docs-fake-engine.json');
const SHARED = 'Shared';
const LIBRARY_ROOT = '/tmp/rag-docs-fake/library';

function print(value) {
  process.stdout.write(`${typeof value === 'string' ? value.trim() : JSON.stringify(value)}\n`);
  process.exit(0);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function fixture(name) {
  return readFileSync(join(TESTDATA, name), 'utf8');
}

function readStdin() {
  return new Promise((resolve) => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { text += chunk; });
    process.stdin.on('end', () => resolve(text));
  });
}

// ---- the committed fixtures, unchanged ----

async function fixtures() {
  if (args[0] === 'documents') print(fixture('documents.json'));
  if (args[0] === 'status') print(fixture('status.json'));
  if (args[0] === 'ask') print(fixture('ask.json'));
  if (args[0] === 'search') print(fixture('search.json'));
  if (args[0] === 'add') {
    print(fixture(args.includes('--dup') ? 'add-duplicate.json' : 'add.json'));
  }
  if (args[0] === 'locate') print(fixture('locate.json'));
  if (args[0] === 'filing' && args[1] === 'show') print(fixture('filing.json'));
  if (args[0] === 'filing' && args[1] === 'save') {
    await readStdin();
    print(fixture(process.env.FAKE_INVALID === '1' ? 'filing-errors.json' : 'filing.json'));
  }
  if (args[0] === 'organize') print(fixture(args.includes('--apply') ? 'organize-apply.json' : 'organize-dry-run.json'));
  if (args[0] === 'setup' && args[1] === 'show') print(fixture('setup-show.json'));
  if (args[0] === 'setup' && args[1] === 'save') {
    await readStdin();
    print(fixture('setup-save.json'));
  }
  if (args[0] === 'model' && args[1] === 'detect') print(fixture('model-detect-found.json'));
  if (args[0] === 'model' && args[1] === 'save') print(fixture('model-save.json'));
  if (args[0] === 'model' && args[1] === 'pull') {
    // The fixture stream: each normalised line, exit 0 (the Rust tests lock these bytes).
    for (const line of fixture('model-pull.jsonl').split('\n')) {
      if (line.trim() !== '') process.stdout.write(`${line}\n`);
    }
    process.exit(0);
  }
}

// ---- a synthetic library ----

const FOLDERS = ['Identity', 'Health', 'Finance', 'Taxes', 'Insurance', 'Home', 'Car', 'Work', 'Education', 'Purchases', 'Letters', 'Other'];
const OWNERS = ['Alex Example', 'Sam Example'];
const MAX_FILE_MB = 50;

// [path, title, type, date, folder, owner, bytes, pages, skipped, dataless]
// Two of these stand as iCloud-only files (the dataless bit), so the overview can show that item.
const DOCUMENTS = [
  ['scans/2025-03-14-car-loan.pdf', 'Car loan - Repayment schedule', 'contract', '2025-03-14', 'Finance', 'Alex Example', 214_000, 4, null, false],
  ['scans/2025-03-20-loan-terms.pdf', 'Car loan - Terms and conditions', 'contract', '2025-03-20', 'Finance', 'Alex Example', 640_000, 12, null, false],
  ['scans/2025-05-09-tyre-change.pdf', 'Tyre change - Invoice', 'invoice', '2025-05-09', 'Car', 'Alex Example', 96_000, 1, null, false],
  ['scans/2024-11-12-inspection.pdf', 'Inspection - Certificate', 'certificate', '2024-11-12', 'Car', 'Sam Example', 1_400_000, 6, null, false],
  ['scans/2025-02-03-electricity.pdf', 'Electricity - Annual statement', 'statement', '2025-02-03', 'Home', null, 2_300_000, 31, null, true],
  ['scans/2025-01-15-rent.pdf', 'Rent - Contract', 'contract', '2025-01-15', 'Home', 'Sam Example', 188_000, 3, null, false],
  ['scans/2025-04-30-accounting.pdf', 'Accounting - VAT invoice', 'invoice', '2025-04-30', 'Finance', null, 54_000, 1, null, false],
  ['scans/2025-06-02-dentist.pdf', 'Dentist - Receipt', 'receipt', '2025-06-02', 'Health', 'Sam Example', 77_000, 1, null, false],
  ['scans/2024-09-01-passport.pdf', 'Passport - Copy', 'identity', '2024-09-01', 'Identity', 'Alex Example', 322_000, 4, null, false],
  ['scans/2025-04-10-tax-return.pdf', 'Tax return 2024', 'tax', '2025-04-10', 'Taxes', 'Alex Example', 120_000, 2, null, false],
  ['notes/kickoff-notes.md', 'Project kickoff - Notes', 'notes', '2025-02-11', 'Work', 'Sam Example', 9_400, null, null, false],
  ['scans/2025-07-21-laptop.pdf', 'Laptop - Receipt', 'receipt', '2025-07-21', 'Purchases', 'Sam Example', 104_000, 1, null, false],
  ['scans/2025-08-05-letter.pdf', null, 'letter', '2025-08-05', null, null, 41_000, 2, null, true],
];

/** A scanned original past the size limit: it never reaches the index, and the pill says why. */
const BIG_DOC = ['big-scan.pdf', null, 'unsorted', null, null, null, 64_000_000, null, 'over_limit', false];

function initialState() {
  return { folders: [...FOLDERS], owners: scenario === 'no-owners' ? [] : [...OWNERS], filed: null, docs: null, added: [], shared: null, library_dir: null, watch: null, model: null, calls: [], detects: 0 };
}

function load() {
  if (!existsSync(STATE)) return initialState();
  return { ...initialState(), ...JSON.parse(readFileSync(STATE, 'utf8')) };
}

function save(state) {
  writeFileSync(STATE, JSON.stringify(state));
}

/** The library's rows: the fixture set plus anything added through `add`, and the big scan.
 * The `clear` scenario is the same library tidied for the all-clear screenshot: every document
 * has a listed owner, nothing is iCloud-only, and the oversize scan is gone. */
function docsOf(state) {
  const base = state.docs ?? DOCUMENTS;
  const added = state.added.map((obj) => [obj.path, obj.title, obj.type, obj.date, obj.folder, obj.owner, obj.bytes, obj.pages, obj.skipped, false]);
  if (scenario === 'clear') {
    return [...base, ...added].map((doc) => {
      const copy = [...doc];
      if (copy[5] === null) copy[5] = OWNERS[0];
      copy[9] = false;
      return copy;
    });
  }
  return [...base, ...added, BIG_DOC];
}

function year(date) {
  return date ? date.slice(0, 4) : 'undated';
}

function fileName(doc) {
  const [path, title, , date] = doc;
  const ext = path.slice(path.lastIndexOf('.'));
  return `${date ?? 'undated'} ${title ?? 'Untitled'}${ext}`;
}

/** Where `organize` would file a copy under the given lists (unlisted names: unsorted / shared). */
function target(doc, state) {
  const [path, title, , date, folder, owner] = doc;
  if (folder === null) return null; // not classified yet
  const shared = state.shared ?? SHARED;
  const f = state.folders.includes(folder) ? folder : 'unsorted';
  const o = owner !== null && state.owners.includes(owner) ? owner : shared;
  return `${f}/${o}/${year(date)}/${fileName(doc)}`;
}

/** The copies on disk: the original lists filed everything, until an apply moves them. */
function filed(state) {
  if (state.filed) return state.filed;
  // What the ORIGINAL lists filed against the ORIGINAL rows: edits since (a rename, a new shared
  // owner) show up as moves. Files added later have no copy on disk yet.
  const base = { folders: FOLDERS, owners: scenario === 'no-owners' ? [] : OWNERS, shared: SHARED, docs: null };
  const source = scenario === 'clear' ? docsOf(initialState()) : DOCUMENTS; // tidy rows file where the tidy rows put them
  return Object.fromEntries(source.map((doc) => [doc[0], target(doc, base)]));
}

function documents(state) {
  const copies = filed(state);
  return {
    version: 1,
    max_file_mb: MAX_FILE_MB,
    status: 'ok',
    documents: docsOf(state).map((doc) => ({
      path: doc[0], title: doc[1], type: doc[2], date: doc[3], folder: doc[4], owner: doc[5],
      filed_as: copies[doc[0]], bytes: doc[6], pages: doc[7], skipped: doc[8], dataless: doc[9],
    })),
  };
}

// The same rule as `classify::safe_folder` + `check_names`.
function safe(name) {
  return name.length > 0 && [...name].length <= 60 && /^[\p{L}\p{N} \-_.']+$/u.test(name)
    && !name.startsWith('.') && !name.endsWith('.') && !name.includes('..');
}

function checkNames(draft, shared) {
  const errors = [];
  const bad = 'the name must be one safe path segment, and an owner may not be the shared owner';
  if (draft.folders.length === 0) errors.push({ list: 'folders', index: null, name: null, code: 'empty_list', message: 'folders must not be empty' });
  for (const list of ['folders', 'owners']) {
    const seen = new Set();
    draft[list].forEach((name, index) => {
      if (!safe(name) || (list === 'owners' && name.toLowerCase() === shared.toLowerCase())) {
        errors.push({ list, index, name, code: 'invalid_name', message: bad });
      } else if (seen.has(name.toLowerCase())) {
        errors.push({ list, index, name, code: 'duplicate', message: 'the name is used twice in this list' });
      }
      seen.add(name.toLowerCase());
    });
  }
  if (draft.shared_owner !== undefined && !safe(draft.shared_owner)) {
    errors.push({ list: 'shared_owner', index: null, name: draft.shared_owner, code: 'invalid_name', message: bad });
  }
  return errors;
}

/** A rename re-files: the rows' folder/owner follow the new name (like the engine's DB rows),
 * so the counts move at once; the copies on disk move with the re-sort the preview shows. */
function applyRename(state, rename) {
  state.docs = (state.docs ?? DOCUMENTS).map((doc) => {
    const field = rename.list === 'folders' ? 4 : 5;
    if (doc[field] !== rename.from) return doc;
    const copy = [...doc];
    copy[field] = rename.to;
    return copy;
  });
}

function plan(state, mode) {
  const copies = filed(state);
  const counts = { would_copy: 0, would_reuse: 0, would_move: 0, copied: 0, already: 0, moved: 0, failed: 0, duplicate: 0, not_classified: 0, missing: 0 };
  const items = [];
  const next = { ...copies };
  for (const doc of docsOf(state)) {
    if (doc[8] === 'over_limit') { counts.skipped = (counts.skipped ?? 0) + 1; continue; }
    const to = target(doc, state);
    const from = copies[doc[0]] ?? null; // files added later have no copy on disk yet
    if (to === null) {
      counts.not_classified += 1;
    } else if (from === null) {
      items.push({ action: 'copy', from: doc[0], to });
      counts.would_copy += 1;
      if (mode === 'apply') { counts.copied += 1; next[doc[0]] = to; }
    } else if (from !== to) {
      items.push({ action: 'move', from, to });
      counts.would_move += 1;
      if (mode === 'apply') { counts.moved += 1; next[doc[0]] = to; }
    } else {
      items.push({ action: 'already_there', from, to });
      counts.already += 1;
    }
  }
  if (mode === 'apply') save({ ...state, filed: next });
  return { version: 1, mode: mode === 'apply' ? 'apply' : 'dry_run', status: 'ok', items, counts };
}

const ANSWER = {
  version: 1,
  answer: 'The last repayment is due on 14 March 2028 [2025-03-14-car-loan, chunk 2]. You can repay early without a fee after the first year [2025-03-20-loan-terms, chunk 5].',
  sources: [
    { source: 'scans/2025-03-14-car-loan', file: 'scans/2025-03-14-car-loan.pdf.vision.txt', chunk: 2, page: 4, score: 0.82 },
    { source: 'scans/2025-03-20-loan-terms', file: 'scans/2025-03-20-loan-terms.pdf.text.txt', chunk: 5, score: 0.64 },
  ],
};

/** `search --json --limit N -- <query>`: a title-word match, same passage keys as the engine. */
function searchReport(query, limit) {
  const word = query.toLowerCase();
  const passages = docsOf(load())
    .filter((doc) => doc[8] !== 'over_limit')
    .flatMap((doc) => {
      const haystack = `${doc[1] ?? ''} ${doc[0]}`.toLowerCase();
      if (!haystack.includes(word)) return [];
      return [{
        source: doc[0].slice(0, doc[0].lastIndexOf('.')),
        file: `${doc[0]}.vision.txt`,
        chunk: 1,
        page: doc[7] ?? 1,
        score: 0.7,
      }];
    })
    .slice(0, limit);
  return { version: 1, passages };
}

/** `add --json -- <file>`: name decides the outcome, so smoke can drive ok / duplicate / failed. */
async function addReport() {
  const file = args[3] ?? '';
  const name = file.split('/').pop() ?? '';
  const delay = Number(process.env.FAKE_ADD_DELAY_MS || 0);
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  if (name.includes('broken')) fail(`Error: no text found in the file ${name}`);
  if (name.includes('big')) fail(`Error: ${name} is larger than max_file_mb (${MAX_FILE_MB} MB); not added`);
  const state = load();
  if (name.includes('dup')) {
    print({ version: 1, status: 'duplicate', source: null, file: name, type: null, date: null, chunks: 0, duplicate_of: 'tax.return.2025.pdf' });
  }
  const added = {
    path: `scans/${name}`,
    title: name.replace(/\.pdf$/, '').replace(/-/g, ' '),
    type: 'receipt',
    date: '2025-09-01',
    folder: 'Purchases',
    owner: 'Sam Example',
    bytes: 150_000,
    pages: 2,
    skipped: null,
  };
  save({ ...state, added: [...state.added, added] });
  print({ version: 1, status: 'added', source: name.replace(/\.pdf$/, ''), file: name, type: added.type, date: added.date, chunks: 4, duplicate_of: null });
}

/** `locate --json -- <path>`: the copy the OS should open, like the engine resolves it. */
function locateReport() {
  const wanted = args[3] ?? '';
  const state = load();
  for (const doc of docsOf(state)) {
    if (doc[0] !== wanted) continue;
    const copy = filed(state)[doc[0]];
    if (copy) print({ version: 1, status: 'ok', kind: 'filed', path: `${LIBRARY_ROOT}/${copy}` });
    print({ version: 1, status: 'ok', kind: 'original', path: `${LIBRARY_ROOT}/${doc[0]}` });
  }
  print({ version: 1, status: 'missing', kind: null, path: null });
}

// ---- first-run onboarding (LET-136): setup show/save, model detect/save/pull ----
// Same shapes as the Rust engine (`src/setup.rs`, `src/model_setup.rs`); every write call lands in
// state `calls` so smoke can assert exactly what setup wrote and what it never did.

const HOME_PATH = /^(~|~\/|\/)/;
const RECOMMENDED_LIBRARY = '~/Documents/library';
const RECOMMENDED_WATCH = ['~/Downloads', '~/Desktop'];

function setupShowReport(state) {
  const set = typeof state.library_dir === 'string' && state.library_dir !== '';
  const watchSet = Array.isArray(state.watch);
  print({
    version: 1,
    library_dir: set ? state.library_dir : RECOMMENDED_LIBRARY,
    library_dir_set: set,
    recommended_library_dir: RECOMMENDED_LIBRARY,
    watch_folders: watchSet ? state.watch : [],
    watch_folders_set: watchSet,
    recommended_watch_folders: [...RECOMMENDED_WATCH],
  });
}

function validSetupPath(v) {
  return typeof v === 'string' && v.length > 0 && v.length <= 4096 && !v.includes('\u0000') && HOME_PATH.test(v);
}

async function setupSaveCmd() {
  let draft;
  try {
    draft = JSON.parse((await readStdin()).trim());
  } catch {
    fail('fake engine: stdin must be one JSON object');
  }
  const state = load();
  const errors = [];
  if (!validSetupPath(draft.library_dir)) {
    errors.push({ field: 'library_dir', message: 'library_dir must be an absolute path or start with ~/ and hold no control characters' });
  }
  const watch = draft.watch_folders;
  if (!Array.isArray(watch) || watch.length > 20 || watch.some((p) => !validSetupPath(p)) || new Set(watch).size !== watch.length) {
    errors.push({ field: 'watch_folders', message: 'watch_folders must be at most 20 unique absolute or ~/ paths' });
  }
  if (errors.length > 0) print({ version: 1, ok: false, saved: false, errors });
  const changed = state.library_dir !== draft.library_dir || JSON.stringify(state.watch ?? null) !== JSON.stringify(watch);
  const next = { ...state, library_dir: draft.library_dir, watch };
  if (!args.includes('--check') && changed) save({ ...next, calls: [...(state.calls ?? []), `setup save ${draft.library_dir} ${watch.join(',')}`] });
  print({ version: 1, ok: true, saved: !args.includes('--check') && changed, errors: [] });
}

function flagValue(prefix) {
  const found = args.find((a) => a.startsWith(prefix));
  return found === undefined ? undefined : found.slice(prefix.length);
}

function modelDetectCmd() {
  const state = load();
  const detects = (state.detects ?? 0) + 1;
  save({ ...state, detects });
  const mode = process.env.FAKE_MODEL_STATE || 'found';
  const after = Number(process.env.FAKE_DETECT_FOUND_AFTER || 0);
  const custom = flagValue('--url=');
  const dead = (runtime, url) => ({ runtime, url, reachable: false, models: [], usable: [], error: `no server at ${new URL(url).host}` });
  const alive = (runtime, url, models, usable) => ({ runtime, url, reachable: true, models, usable, error: null });
  const config = { model: state.model ?? '', overridden: false };
  if (mode === 'install') {
    // Guided install (review finding 6, LET-165): the first FAKE_DETECT_FOUND_AFTER detects are not-found (no
    // runtime); after that Ollama appears but is empty (reachable, only an embedding model), so the step sees
    // found-empty after a not-found and the page auto-starts the recommended pull exactly once.
    const nf = Number(process.env.FAKE_DETECT_FOUND_AFTER || 1);
    if (detects <= nf) {
      print({ ok: true, runtimes: [dead('ollama', 'http://127.0.0.1:11434'), dead('lmstudio', 'http://127.0.0.1:1234')], shared: null, config });
    }
    print({ ok: true, runtimes: [alive('ollama', 'http://127.0.0.1:11434', ['bge-m3:latest'], []), dead('lmstudio', 'http://127.0.0.1:1234')], shared: null, config });
  }
  if (after > 0 && detects <= after) {
    print({ ok: true, runtimes: [dead('ollama', 'http://127.0.0.1:11434'), dead('lmstudio', 'http://127.0.0.1:1234')], shared: null, config });
  }
  if (custom !== undefined) {
    const reach = mode === 'not-found' ? [] : ['qwen3:8b'];
    print({ ok: true, runtimes: [alive('custom', custom, reach, reach)], shared: null, config });
  }
  if (mode === 'found-empty') {
    print({ ok: true, runtimes: [alive('ollama', 'http://127.0.0.1:11434', ['bge-m3:latest'], []), dead('lmstudio', 'http://127.0.0.1:1234')], shared: null, config });
  }
  if (mode === 'shared') {
    print({
      ok: true,
      runtimes: [alive('ollama', 'http://127.0.0.1:11434', ['qwen3:8b'], ['qwen3:8b']), dead('lmstudio', 'http://127.0.0.1:1234')],
      shared: { runtime: 'ollama', url: 'http://127.0.0.1:11434', model: 'qwen3:8b', set_by: 'triage mail', reachable: true },
      config,
    });
  }
  if (mode === 'not-found') {
    print({ ok: true, runtimes: [dead('ollama', 'http://127.0.0.1:11434'), dead('lmstudio', 'http://127.0.0.1:1234')], shared: null, config });
  }
  print({
    ok: true,
    runtimes: [alive('ollama', 'http://127.0.0.1:11434', ['qwen3:8b', 'llama3.2:3b'], ['qwen3:8b', 'llama3.2:3b']), dead('lmstudio', 'http://127.0.0.1:1234')],
    shared: null,
    config,
  });
}

function modelSaveCmd() {
  const runtime = flagValue('--runtime=') ?? '';
  const url = flagValue('--url=') ?? '';
  const model = flagValue('--model=') ?? '';
  const state = load();
  save({ ...state, model, calls: [...(state.calls ?? []), `model save ${runtime} ${model}`] });
  print({ ok: true, runtime, url, model });
}

async function modelPullCmd() {
  // One normalised line per update, flushed as it "arrives" (stdout is a pipe to main). The bytes
  // belong to the recommended qwen3:8b: 5.2 GB on the 16 GiB smoke/shots machine.
  const size = Math.round(5.2 * 1024 ** 3);
  const say = (line) => {
    process.stdout.write(`${JSON.stringify(line)}\n`);
  };
  say({ stage: 'pulling manifest' });
  const mode = process.env.FAKE_PULL || 'ok';
  const steps = mode === 'ok' ? [0.1, 0.25, 0.42, 0.75, 1] : mode === 'fail' ? [0.1, 0.3] : [0.1, 0.25, 0.42];
  // FAKE_PULL_STEP_MS: pause between lines, so the stream stays open long enough for smoke to continue
  // past it (the plan's "continue during a download" case needs a stream that outlives the click).
  const stepMs = Number(process.env.FAKE_PULL_STEP_MS || 0);
  for (const part of steps) {
    say({ stage: 'downloading', total: size, completed: Math.round(size * part) });
    if (stepMs > 0) await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  if (mode === 'fail') {
    say({ stage: 'error', error: 'no space left on device' });
    process.exit(1);
  }
  if (mode === 'hold-42') {
    // Stop at 42% and wait for main's SIGTERM (the page's cancel button); the stream ends without
    // a success line, exactly as a cancelled real pull does. The interval is not decoration: with no
    // pending I/O left, node exits on its own ("unsettled top-level await") and the hold becomes a
    // premature failure instead of a download that really is still running.
    const busy = setInterval(() => { }, 1000);
    await new Promise((resolve) => {
      process.on('SIGTERM', () => {
        clearInterval(busy);
        resolve();
      });
    });
    process.exit(1);
  }
  say({ stage: 'success' });
  process.exit(0);
}


async function library() {
  const state = load();
  if (args[0] === 'documents') print(documents(state));
  if (args[0] === 'status') {
    // Same shape and same probe ARGS as the real Rust `status`. The overview's cheap `status --json` reports
    // `answering: null` (no completion was asked). Only when `--answer` is on the command line does the probe
    // run: then `answering` is true for a reachable model, false when FAKE_ANSWERING=0 (a reachable model whose
    // tiny completion never answers — the empty/malformed-completion case). The `--url`/`--model` the onboarding
    // passes identify WHICH model was probed; the fake only ever uses local endpoints, matching the engine's
    // local-only rule (it would refuse a public url there). This is why the smoke download can now reach Ready:
    // the step passes `--answer --url --model`, and the probe answers.
    const reachable = process.env.FAKE_MODEL !== 'down';
    const wantsAnswer = args.includes('--answer');
    const answering = wantsAnswer && reachable && process.env.FAKE_ANSWERING !== '0';
    print({ version: 1, model: { reachable, answering: wantsAnswer ? answering : null }, last_sync: '2025-03-09T09:24:00Z' });
  }
  if (args[0] === 'search') {
    const limit = Number(args[args.indexOf('--limit') + 1] || 20);
    const query = args[args.indexOf('--') + 1] ?? '';
    print(searchReport(query, limit));
  }
  if (args[0] === 'add') await addReport();
  if (args[0] === 'locate') locateReport();
  if (args[0] === 'ask') print(ANSWER);
  if (args[0] === 'filing' && args[1] === 'show') {
    // FAKE_FILING_FAIL: the lists never load, so the overview must show an error and stay not-all-clear.
    if (process.env.FAKE_FILING_FAIL === '1') fail('fake engine: filing show failed');
    print({ version: 1, folders: state.folders, owners: state.owners, shared_owner: state.shared ?? SHARED });
  }
  if (args[0] === 'filing' && args[1] === 'save') {
    let draft;
    try {
      draft = JSON.parse((await readStdin()).trim());
    } catch {
      fail('fake engine: stdin must be one JSON object');
    }
    const shared = draft.shared_owner ?? state.shared ?? SHARED;
    const errors = checkNames(draft, shared);
    if (errors.length > 0) print({ version: 1, ok: false, saved: false, renamed: 0, folders: draft.folders, owners: draft.owners, errors });
    const next = { ...state, folders: draft.folders, owners: draft.owners, shared: draft.shared_owner ?? state.shared ?? SHARED };
    let renamed = 0;
    for (const rename of draft.renames ?? []) {
      if (rename.list !== 'folders' && rename.list !== 'owners') continue;
      applyRename(next, rename);
      renamed += 1;
    }
    const changed = JSON.stringify([draft.folders, draft.owners]) !== JSON.stringify([state.folders, state.owners])
      || renamed > 0
      || draft.shared_owner !== undefined && draft.shared_owner !== state.shared;
    if (!args.includes('--check') && changed) save({ ...next, calls: [...(state.calls ?? []), 'filing save'] });
    print({ version: 1, ok: true, saved: !args.includes('--check') && changed, renamed, folders: draft.folders, owners: draft.owners, shared_owner: shared, errors: [] });
  }
  if (args[0] === 'setup' && args[1] === 'show') setupShowReport(state);
  if (args[0] === 'setup' && args[1] === 'save') await setupSaveCmd();
  if (args[0] === 'model' && args[1] === 'detect') modelDetectCmd();
  if (args[0] === 'model' && args[1] === 'save') modelSaveCmd();
  if (args[0] === 'model' && args[1] === 'pull') await modelPullCmd();
  if (args[0] === 'organize') {
    const apply = args.includes('--apply');
    // FAKE_ORGANIZE_FAIL: the dry-run fails, so the overview must show an error and stay not-all-clear
    // until the next visit retries it (finding 5).
    if (!apply && process.env.FAKE_ORGANIZE_FAIL === '1') fail('fake engine: organize dry-run failed');
    // FAKE_DRY_RUN_DELAY_MS: a slow dry-run of the lists as they were when it started (race tests).
    const delay = Number(process.env.FAKE_DRY_RUN_DELAY_MS || 0);
    if (!apply && delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    print(plan(state, apply ? 'apply' : 'dry_run'));
  }
}

if (scenario === 'fixtures') await fixtures();
else if (scenario === 'empty') {
  if (args[0] === 'documents') print(fixture('documents-no-database.json'));
  if (args[0] === 'ask') print(fixture('ask-no-passages.json'));
  if (args[0] === 'organize') print(fixture('organize-no-database.json'));
  await library();
} else if (scenario === 'outdated') {
  // Every report is valid JSON and says the library must be rebuilt before anything can use it.
  if (args[0] === 'documents') print(fixture('documents-outdated.json'));
  if (args[0] === 'ask') print(fixture('ask-no-passages.json'));
  if (args[0] === 'organize' && !args.includes('--apply'))
    print({ version: 1, mode: 'dry_run', status: 'outdated', items: [], counts: { would_copy: 0, would_reuse: 0, would_move: 0, copied: 0, already: 0, moved: 0, failed: 0, duplicate: 0, not_classified: 0, missing: 0 } });
  await library();
} else await library();

process.stderr.write(`fake engine: unknown call ${args.join(' ')}\n`);
process.exit(2);
