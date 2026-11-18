// The renderer's pure view logic (renderer/model.js), on synthetic reports shaped like the
// engine's JSON. Plain JS so the page's own module is imported unchanged.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as m from '../renderer/model.js';

const docs = [
  { path: 'scans/2025-03-14-car-loan.pdf', title: 'Car loan - Repayment schedule', type: 'contract', date: '2025-03-14', folder: 'Finance', owner: 'Alex Example', filed_as: 'Finance/Alex Example/2025/2025-03-14 Car loan - Repayment schedule.pdf', bytes: 100_352, pages: 2, skipped: null },
  { path: 'scans/2025-05-09-tyre-change.pdf', title: 'Tyre change - Invoice', type: 'invoice', date: '2025-05-09', folder: 'Car', owner: 'Sam Example', filed_as: 'Car/Sam Example/2025/2025-05-09 Tyre change - Invoice.pdf', bytes: 5_400_000, pages: null, skipped: null },
  { path: 'notes/kickoff-notes.md', title: null, type: 'notes', date: null, folder: null, owner: null, filed_as: null, bytes: null, pages: null, skipped: null },
];
const big = { path: 'big-scan.pdf', title: null, type: 'unsorted', date: null, folder: null, owner: null, filed_as: null, bytes: 64_000_000, pages: null, skipped: 'over_limit' };
const saved = { version: 1, folders: ['Finance', 'Car', 'Other'], owners: ['Alex Example', 'Sam Example'], shared_owner: 'Shared' };

test('library rows: file name, type, month, and an untitled document still listed', () => {
  const rows = m.libraryRows(docs, []);
  assert.equal(rows.length, 3);
  assert.deepEqual([rows[0].title, rows[0].initials, rows[0].time], ['2025-03-14-car-loan.pdf', 'PDF', 'mar']);
  assert.equal(rows[0].preview, 'Car loan - Repayment schedule · Alex Example · 2 pages · 100 KB');
  assert.deepEqual([rows[2].initials, rows[2].preview, rows[2].time], ['MD', 'no title yet', '']);
});

test('sizes are decimal and the over-limit row carries its reason', () => {
  assert.equal(m.formatBytes(6), '6 B');
  assert.equal(m.formatBytes(100_352), '100 KB');
  assert.equal(m.formatBytes(5_400_000), '5.4 MB');
  assert.equal(m.formatBytes(1_500_000_000), '1.5 GB');
  assert.equal(m.formatBytes(null), '');
  const rows = m.libraryRows([...docs, big], []);
  assert.equal(rows[3].overLimit, true);
  assert.equal(m.overLimitLabel(50), 'not indexed: over 50 MB');
  assert.equal(m.overLimitLabel(null), 'not indexed');
  // an engine without the size limit: unknown, not a fake 50
  assert.equal(m.overLimitLabel(null), 'not indexed');
});

test('citations show the page when the first passage has one', () => {
  const paged = [{ source: 'scans/a.pdf.vision.txt', file: 'x', chunk: 2, page: 4, score: 0.9 }];
  // The engine names the passage by its stem; the page beats the chunk number.
  assert.deepEqual(m.citations(paged), ['[1] a, p. 4']);
  const unmarked = [{ source: 'scans/b', file: 'y', chunk: 1, score: 0.5 }];
  assert.deepEqual(m.citations(unmarked), ['[1] b, chunk 1']);
});

test('add progress: one row per picked file and a 2-of-3 count', () => {
  const picked = ['loan.pdf', 'loan-dup.pdf', 'broken.pdf'];
  const results = [{ state: 'added', type: 'contract' }, { state: 'duplicate' }, { state: 'failed', error: 'no text found' }];
  const rows = m.addRows(picked, results);
  assert.deepEqual(rows.map((r) => r.preview), ['added (contract)', 'already added', 'failed: no text found']);
  assert.equal(m.addMeta(results, false), 'done');
  const waiting = m.addRows(picked, picked.map(() => ({ state: 'waiting' })));
  assert.deepEqual(waiting.map((r) => r.preview), ['waiting', 'waiting', 'waiting']);
  assert.equal(m.addMeta([{ state: 'added' }, { state: 'adding' }, { state: 'waiting' }], false), '1 of 3');
  assert.equal(m.addMeta([], true), 'cancelled');
});

test('open buttons name cited library documents, ranked order, at most 3', () => {
  const sources = [
    { source: 'notes/kickoff-notes', file: 'n.txt', chunk: 0, score: 0.9 },
    { source: 'scans/2025-03-14-car-loan', file: 'c.txt', chunk: 1, score: 0.8 },
    { source: 'ghost', file: 'g.txt', chunk: 0, score: 0.7 },
    { source: 'scans/2025-05-09-tyre-change', file: 't.txt', chunk: 0, score: 0.6 },
  ];
  assert.deepEqual(m.openTargets(docs, sources).map((t) => t.path), [
    'notes/kickoff-notes.md',
    'scans/2025-03-14-car-loan.pdf',
    'scans/2025-05-09-tyre-change.pdf',
  ]);
  assert.equal(m.openTargets(docs, sources)[0].label, 'open kickoff-notes');
});

test('the re-sort notice says renames re-file; removals still warn', () => {
  assert.equal(m.resortNote([{ kind: 'rename', list: 'folders', from: 'Car', to: 'Vehicles' }]),
    'Documents keep a renamed name, so re-sorting moves their copies to the new folder.');
  assert.match(m.resortNote([{ kind: 'remove', list: 'folders', name: 'Car' }]), /until `classify --force`/);
  assert.equal(m.resortNote([{ kind: 'add', list: 'folders', name: 'Taxes' }]), '');
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
    ['Vehicles', '0 documents', 'was Car'], // these docs still say "Car"; the engine re-files on save
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

test('drafts: renames re-file, the shared owner is an editable op', () => {
  assert.deepEqual(m.draftFor(saved, 'folders', { kind: 'rename', index: 1, name: ' Vehicles ' }), {
    folders: ['Finance', 'Vehicles', 'Other'],
    owners: saved.owners,
    renames: [{ list: 'folders', from: 'Car', to: 'Vehicles' }],
  });
  assert.deepEqual(m.draftFor(saved, 'owners', { kind: 'rename', index: 0, name: 'Alex Exampleson' }).renames,
    [{ list: 'owners', from: 'Alex Example', to: 'Alex Exampleson' }]);
  assert.deepEqual(m.draftFor(saved, 'owners', { kind: 'shared', name: ' Household ' }), {
    folders: saved.folders,
    owners: saved.owners,
    shared_owner: 'Household',
  });
  assert.deepEqual(m.draftFor(saved, 'owners', { kind: 'add', name: 'Example Studio' }).owners, ['Alex Example', 'Sam Example', 'Example Studio']);
  assert.deepEqual(m.draftFor(saved, 'folders', { kind: 'remove', index: 0 }).folders, ['Car', 'Other']);
  assert.equal('shared_owner' in m.draftFor(saved, 'folders', { kind: 'remove', index: 0 }), false);
  assert.equal('renames' in m.draftFor(saved, 'folders', { kind: 'add', name: 'Taxes' }), false);
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
  assert.equal(m.changeSummary([...changes, { kind: 'shared', list: 'shared_owner', from: 'Shared', name: 'Household' }]), 'You renamed Car to Vehicles, added the owner Example Studio and set the shared owner to Household.');
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
