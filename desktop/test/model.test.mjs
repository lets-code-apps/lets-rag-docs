// The renderer's pure view logic (renderer/model.js), on synthetic reports shaped like the
// engine's JSON. Plain JS so the page's own module is imported unchanged.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as m from '../renderer/model.js';

const docs = [
  { path: 'scans/2025-03-14-car-loan.pdf', title: 'Car loan - Repayment schedule', type: 'contract', date: '2025-03-14', folder: 'Finance', owner: 'Alex Example', filed_as: 'Finance/Alex Example/2025/2025-03-14 Car loan - Repayment schedule.pdf' },
  { path: 'scans/2025-05-09-tyre-change.pdf', title: 'Tyre change - Invoice', type: 'invoice', date: '2025-05-09', folder: 'Car', owner: 'Sam Example', filed_as: 'Car/Sam Example/2025/2025-05-09 Tyre change - Invoice.pdf' },
  { path: 'notes/kickoff-notes.md', title: null, type: 'notes', date: null, folder: null, owner: null, filed_as: null },
];
const saved = { version: 1, folders: ['Finance', 'Car', 'Other'], owners: ['Alex Example', 'Sam Example'], shared_owner: 'Shared' };

test('library rows: file name, type, month, and an untitled document still listed', () => {
  const rows = m.libraryRows(docs, []);
  assert.equal(rows.length, 3);
  assert.deepEqual([rows[0].title, rows[0].initials, rows[0].time], ['2025-03-14-car-loan.pdf', 'PDF', 'mar']);
  assert.equal(rows[0].preview, 'Car loan - Repayment schedule · Alex Example');
  assert.deepEqual([rows[2].initials, rows[2].preview, rows[2].time], ['MD', 'no title yet', '']);
});

test('a cited document is marked by the engine source name or OCR file', () => {
  const bySource = [{ source: 'scans/2025-03-14-car-loan', file: 'x.txt', chunk: 2, score: 0.8 }];
  const byFile = [{ source: 'other', file: 'scans/2025-05-09-tyre-change.pdf.text.txt', chunk: 0, score: 0.5 }];
  assert.deepEqual(m.libraryRows(docs, bySource).map((r) => r.cited), [true, false, false]);
  assert.deepEqual(m.libraryRows(docs, byFile).map((r) => r.cited), [false, true, false]);
});

test('citations: one numbered pill per document, answer label counts documents', () => {
  const sources = [
    { source: 'scans/a', file: 'scans/a.pdf.text.txt', chunk: 2, score: 0.9 },
    { source: 'scans/a', file: 'scans/a.pdf.text.txt', chunk: 4, score: 0.7 },
    { source: 'scans/b', file: 'scans/b.pdf.text.txt', chunk: 1, score: 0.5 },
  ];
  assert.deepEqual(m.citations(sources), ['[1] a, chunk 2', '[2] b, chunk 1']);
  assert.equal(m.answerLabel(sources), 'answer from 2 documents');
  assert.equal(m.answerLabel(sources.slice(0, 1)), 'answer from 1 document');
});

test('library states come from the report status', () => {
  assert.match(m.libraryNotice({ version: 1, status: 'no_database', documents: [] }), /ingest/);
  assert.equal(m.libraryNotice({ version: 1, status: 'ok', documents: docs }), null);
  assert.equal(m.libraryMeta({ version: 1, status: 'ok', documents: docs }), '3 documents');
});

test('folder rows count documents, end with unsorted, and mark this session\'s changes', () => {
  const changes = [{ kind: 'rename', list: 'folders', from: 'Car', to: 'Vehicles' }, { kind: 'add', list: 'folders', name: 'Taxes' }];
  const after = { ...saved, folders: ['Finance', 'Vehicles', 'Other', 'Taxes'] };
  const rows = m.filingRows('folders', after, docs, changes, { kind: 'item', index: 0 });
  assert.deepEqual(rows.map((r) => [r.title, r.time, r.pill]), [
    ['Finance', '1 document', ''],
    ['Vehicles', '0 documents', 'was Car'], // documents keep "Car" until re-classified
    ['Other', '0 documents', ''],
    ['Taxes', '0 documents', 'new'],
    ['unsorted', '2 documents', ''],
  ]);
  assert.equal(rows[0].selected, true);
  assert.equal(rows[4].kind, 'unsorted');
});

test('owner rows end with the shared owner, which counts unlisted owners', () => {
  const rows = m.filingRows('owners', saved, docs, [], { kind: 'shared' });
  const shared = rows[rows.length - 1];
  assert.deepEqual([shared.kind, shared.title, shared.time, shared.pill, shared.selected], ['shared', 'Shared', '1 document', 'shared owner', true]);
  assert.equal(m.listMeta('owners', { ...saved, owners: [] }, 3), '3 documents, no owners');
  assert.equal(m.listMeta('folders', saved, 3), '3 documents in 3 folders');
});

test('the path example follows the name field and has " /" separators', () => {
  const levels = m.examplePath('folders', saved, docs, [], { original: 'Car', value: 'Vehicles', placeholder: '' });
  assert.deepEqual(levels.map((l) => l.val), ['library', 'Vehicles', 'Sam Example', '2025', '2025-05-09 Tyre change - Invoice.pdf']);
  assert.deepEqual(levels.map((l) => l.sep), [' /', ' /', ' /', ' /', '']);
  assert.deepEqual(levels.map((l) => l.on), [false, true, false, false, false]);
  const owners = m.examplePath('owners', saved, docs, [], { original: null, value: 'Example Studio', placeholder: '' });
  assert.equal(owners[2].val, 'Example Studio');
  assert.equal(owners[2].on, true);
});

test('with no filed copy the example names the levels instead of inventing a document', () => {
  const levels = m.examplePath('folders', saved, [docs[2]], [], { original: null, value: '', placeholder: '' });
  assert.equal(levels[4].val, 'date, matter - title.pdf');
  assert.equal(levels[2].val, 'Shared');
});

test('drafts change exactly one list and never carry the shared owner', () => {
  assert.deepEqual(m.draftFor(saved, 'folders', { kind: 'rename', index: 1, name: ' Vehicles ' }), { folders: ['Finance', 'Vehicles', 'Other'], owners: saved.owners });
  assert.deepEqual(m.draftFor(saved, 'owners', { kind: 'add', name: 'Example Studio' }).owners, ['Alex Example', 'Sam Example', 'Example Studio']);
  assert.deepEqual(m.draftFor(saved, 'folders', { kind: 'remove', index: 0 }).folders, ['Car', 'Other']);
  assert.equal('shared_owner' in m.draftFor(saved, 'folders', { kind: 'remove', index: 0 }), false);
  assert.equal(m.editedIndex(saved, 'owners', { kind: 'add', name: 'x' }), 2);
  assert.deepEqual(saved.folders, ['Finance', 'Car', 'Other'], 'the saved lists are not mutated');
});

test('engine validation issues read like the design', () => {
  const issue = (code, name, list = 'owners') => ({ list, index: 2, name, code, message: 'engine text' });
  assert.match(m.friendlyError(issue('invalid_name', 'Example/Studio'), 'Shared'), /^Take out the "\/"\. The name becomes a folder/);
  assert.match(m.friendlyError(issue('invalid_name', 'shared'), 'Shared'), /shared owner already/);
  assert.match(m.friendlyError(issue('invalid_name', '.hidden'), 'Shared'), /start or end with a dot/);
  assert.equal(m.friendlyError(issue('duplicate', 'Car', 'folders'), 'Shared'), 'That name is already on the list.');
  assert.match(m.friendlyError({ list: 'folders', index: null, name: null, code: 'empty_list', message: '' }, 'Shared'), /at least one folder/);
  assert.equal(m.friendlyError(issue('something_new', 'x'), 'Shared'), 'engine text');
});

test('change summary and the dry-run as "what will move" rows', () => {
  const changes = [{ kind: 'rename', list: 'folders', from: 'Car', to: 'Vehicles' }, { kind: 'add', list: 'owners', name: 'Example Studio' }];
  assert.equal(m.changeSummary(changes), 'You renamed Car to Vehicles and added the owner Example Studio.');
  const report = {
    version: 1, mode: 'dry_run', status: 'ok',
    items: [
      { action: 'move', from: 'Car/Sam Example/2025/Tyre.pdf', to: 'unsorted/Sam Example/2025/Tyre.pdf' },
      { action: 'copy', from: 'scans/new.pdf', to: 'Finance/Shared/2025/New.pdf' },
      { action: 'already_there', from: 'a', to: 'a' },
      { action: 'missing_original', from: 'gone.pdf', to: null },
    ],
    counts: { would_copy: 1, would_move: 1 },
  };
  const plan = m.movePlan(report);
  assert.equal(plan.count, 2);
  assert.deepEqual(plan.rows[0], { title: 'Tyre.pdf', to: 'to unsorted / Sam Example / 2025', from: 'from Car / Sam Example / 2025', pill: '' });
  assert.equal(plan.rows[1].pill, 'new copy');
  assert.equal(m.dryRunProblem(report), null);
  assert.match(m.dryRunProblem({ ...report, status: 'outdated' }), /ingest/);
  assert.match(m.applySummary({ ...report, mode: 'apply', counts: { moved: 1, copied: 1, failed: 0 } }), /moved 1 copy and made 1 copy/);
});
