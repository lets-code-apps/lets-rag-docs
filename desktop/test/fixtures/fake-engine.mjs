#!/usr/bin/env node
// A stand-in for the real Rust engine, used by smoke and screenshots. Synthetic only: made-up
// names, no documents, no SQLite, no model. It speaks the same JSON contract as the engine.
//
// FAKE_SCENARIO:
//   fixtures   the committed `testdata/desktop` fixtures, byte for byte (the Rust tests lock them)
//   library    (default) a small synthetic library whose lists can be edited
//   no-owners  the same library, before any owner was added
//   empty      no library database yet
// FAKE_DRY_RUN_DELAY_MS: make `organize --dry-run` slow (it plans the lists read at its start).
// FAKE_STATE_FILE: where `library`/`no-owners` keep the saved lists and filed copies between
// calls (default: a file in the OS temp folder). Delete it to start over.

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

function print(value) {
  process.stdout.write(`${typeof value === 'string' ? value.trim() : JSON.stringify(value)}\n`);
  process.exit(0);
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
  if (args[0] === 'ask') print(fixture('ask.json'));
  if (args[0] === 'filing' && args[1] === 'show') print(fixture('filing.json'));
  if (args[0] === 'filing' && args[1] === 'save') {
    await readStdin();
    print(fixture(process.env.FAKE_INVALID === '1' ? 'filing-errors.json' : 'filing.json'));
  }
  if (args[0] === 'organize') print(fixture(args.includes('--apply') ? 'organize-apply.json' : 'organize-dry-run.json'));
}

// ---- a synthetic library ----

const FOLDERS = ['Identity', 'Health', 'Finance', 'Taxes', 'Insurance', 'Home', 'Car', 'Work', 'Education', 'Purchases', 'Letters', 'Other'];
const OWNERS = ['Alex Example', 'Sam Example'];

// [path, title, type, date, folder, owner]
const DOCUMENTS = [
  ['scans/2025-03-14-car-loan.pdf', 'Car loan - Repayment schedule', 'contract', '2025-03-14', 'Finance', 'Alex Example'],
  ['scans/2025-03-20-loan-terms.pdf', 'Car loan - Terms and conditions', 'contract', '2025-03-20', 'Finance', 'Alex Example'],
  ['scans/2025-05-09-tyre-change.pdf', 'Tyre change - Invoice', 'invoice', '2025-05-09', 'Car', 'Alex Example'],
  ['scans/2024-11-12-inspection.pdf', 'Inspection - Certificate', 'certificate', '2024-11-12', 'Car', 'Sam Example'],
  ['scans/2025-02-03-electricity.pdf', 'Electricity - Annual statement', 'statement', '2025-02-03', 'Home', null],
  ['scans/2025-01-15-rent.pdf', 'Rent - Contract', 'contract', '2025-01-15', 'Home', 'Sam Example'],
  ['scans/2025-04-30-accounting.pdf', 'Accounting - VAT invoice', 'invoice', '2025-04-30', 'Finance', null],
  ['scans/2025-06-02-dentist.pdf', 'Dentist - Receipt', 'receipt', '2025-06-02', 'Health', 'Sam Example'],
  ['scans/2024-09-01-passport.pdf', 'Passport - Copy', 'identity', '2024-09-01', 'Identity', 'Alex Example'],
  ['scans/2025-04-10-tax-return.pdf', 'Tax return 2024', 'tax', '2025-04-10', 'Taxes', 'Alex Example'],
  ['notes/kickoff-notes.md', 'Project kickoff - Notes', 'notes', '2025-02-11', 'Work', 'Sam Example'],
  ['scans/2025-07-21-laptop.pdf', 'Laptop - Receipt', 'receipt', '2025-07-21', 'Purchases', 'Sam Example'],
  ['scans/2025-08-05-letter.pdf', null, 'letter', '2025-08-05', null, null],
];

function initialState() {
  return { folders: [...FOLDERS], owners: scenario === 'no-owners' ? [] : [...OWNERS], filed: null };
}

function load() {
  if (!existsSync(STATE)) return initialState();
  return { ...initialState(), ...JSON.parse(readFileSync(STATE, 'utf8')) };
}

function save(state) {
  writeFileSync(STATE, JSON.stringify(state));
}

function year(date) {
  return date ? date.slice(0, 4) : 'undated';
}

function fileName([path, title, , date]) {
  const ext = path.slice(path.lastIndexOf('.'));
  return `${date ?? 'undated'} ${title ?? 'Untitled'}${ext}`;
}

/** Where `organize` would file a copy under the given lists (unlisted names: unsorted / Shared). */
function target(doc, lists) {
  const [, , , date, folder, owner] = doc;
  if (folder === null) return null; // not classified yet
  const f = lists.folders.includes(folder) ? folder : 'unsorted';
  const o = owner !== null && lists.owners.includes(owner) ? owner : SHARED;
  return `${f}/${o}/${year(date)}/${fileName(doc)}`;
}

/** The copies on disk: the original lists filed everything, until an apply moves them. */
function filed(state) {
  if (state.filed) return state.filed;
  const base = { folders: FOLDERS, owners: scenario === 'no-owners' ? [] : OWNERS };
  return Object.fromEntries(DOCUMENTS.map((doc) => [doc[0], target(doc, base)]));
}

function documents(state) {
  const copies = filed(state);
  return {
    version: 1,
    status: 'ok',
    documents: DOCUMENTS.map((doc) => ({
      path: doc[0], title: doc[1], type: doc[2], date: doc[3], folder: doc[4], owner: doc[5], filed_as: copies[doc[0]],
    })),
  };
}

// The same rule as `classify::safe_folder` + `check_names`.
function safe(name) {
  return name.length > 0 && [...name].length <= 60 && /^[\p{L}\p{N} \-_.']+$/u.test(name)
    && !name.startsWith('.') && !name.endsWith('.') && !name.includes('..');
}

function checkNames(draft) {
  const errors = [];
  const bad = 'the name must be one safe path segment, and an owner may not be the shared owner';
  if (draft.folders.length === 0) errors.push({ list: 'folders', index: null, name: null, code: 'empty_list', message: 'folders must not be empty' });
  for (const list of ['folders', 'owners']) {
    const seen = new Set();
    draft[list].forEach((name, index) => {
      if (!safe(name) || (list === 'owners' && name.toLowerCase() === SHARED.toLowerCase())) {
        errors.push({ list, index, name, code: 'invalid_name', message: bad });
      } else if (seen.has(name.toLowerCase())) {
        errors.push({ list, index, name, code: 'duplicate', message: 'the name is used twice in this list' });
      }
      seen.add(name.toLowerCase());
    });
  }
  return errors;
}

function plan(state, mode) {
  const copies = filed(state);
  const counts = { would_copy: 0, would_reuse: 0, would_move: 0, copied: 0, already: 0, moved: 0, failed: 0, duplicate: 0, not_classified: 0, missing: 0 };
  const items = [];
  const next = { ...copies };
  for (const doc of DOCUMENTS) {
    const to = target(doc, state);
    const from = copies[doc[0]];
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
    { source: 'scans/2025-03-14-car-loan', file: 'scans/2025-03-14-car-loan.pdf.text.txt', chunk: 2, score: 0.82 },
    { source: 'scans/2025-03-20-loan-terms', file: 'scans/2025-03-20-loan-terms.pdf.text.txt', chunk: 5, score: 0.64 },
  ],
};

async function library() {
  const state = load();
  if (args[0] === 'documents') print(documents(state));
  if (args[0] === 'ask') print(ANSWER);
  if (args[0] === 'filing' && args[1] === 'show') print({ version: 1, folders: state.folders, owners: state.owners, shared_owner: SHARED });
  if (args[0] === 'filing' && args[1] === 'save') {
    let draft;
    try {
      draft = JSON.parse((await readStdin()).trim());
    } catch {
      process.stderr.write('fake engine: stdin must be one JSON object\n');
      process.exit(1);
    }
    const errors = checkNames(draft);
    if (errors.length > 0) print({ version: 1, ok: false, saved: false, folders: draft.folders, owners: draft.owners, errors });
    const changed = JSON.stringify([draft.folders, draft.owners]) !== JSON.stringify([state.folders, state.owners]);
    if (!args.includes('--check') && changed) save({ ...state, folders: draft.folders, owners: draft.owners, filed: filed(state) });
    print({ version: 1, ok: true, saved: !args.includes('--check') && changed, folders: draft.folders, owners: draft.owners, errors: [] });
  }
  if (args[0] === 'organize') {
    const apply = args.includes('--apply');
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
} else await library();

process.stderr.write(`fake engine: unknown call ${args.join(' ')}\n`);
process.exit(2);
