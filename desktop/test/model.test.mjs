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

test('page counts: 1 page, n pages, unknown omitted', () => {
  assert.equal(m.pagesLabel(1), '1 page');
  assert.equal(m.pagesLabel(12), '12 pages');
  assert.equal(m.pagesLabel(null), '');
  const [row] = m.libraryRows([{ ...docs[0], pages: 1 }], []);
  assert.equal(row.preview, 'Car loan - Repayment schedule · Alex Example · 1 page · 100 KB');
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

// ---- overview ----

test('sidebar: order overview, ask, filing, settings; count pill and aria label only above 0', () => {
  const rows = m.sidebarItems('overview', 5);
  assert.deepEqual(rows.map((r) => r.section), ['overview', 'ask', 'filing', 'settings']);
  assert.equal(rows[0].current, true);
  assert.equal(rows[0].count, '5');
  assert.equal(rows[0].aria, 'overview, 5 need you');
  assert.equal(rows[1].current, false);
  const zero = m.sidebarItems('overview', 0);
  assert.equal(zero[0].count, '');
  assert.equal(zero[0].aria, 'overview');
});

test('sharedOwnerCount matches the Shared row: null owner, shared owner, unlisted owner', () => {
  const five = [
    { owner: null }, { owner: 'Shared' }, { owner: 'Nobody' }, { owner: 'Alex Example' }, { owner: 'Sam Example' },
  ];
  assert.equal(m.sharedOwnerCount(saved, five), 3);
  assert.equal(m.sharedOwnerCount(saved, null), 0);
});

test('overview figures: toLocaleString counts, indexed excludes skipped, sync label, model pill', () => {
  const [documents, indexed, sync, model] = m.overviewFigures({ max_file_mb: 50, documents: docs.concat(big) }, { model: { reachable: true }, last_sync: '2025-03-09T05:24:00Z' });
  assert.equal(documents.label, 'documents');
  assert.equal(documents.value, '4');
  assert.equal(documents.isPill, false);
  assert.equal(indexed.value, '3'); // the over_limit scan is not indexed
  assert.match(sync.value, /^[0-9]+ \w{3}, \d{2}:\d{2}$/);
  assert.deepEqual([model.value, model.tone, model.isPill], ['connected', 'positive', true]);

  const down = m.overviewFigures(null, { model: { reachable: false }, last_sync: null });
  assert.equal(down[0].value, 'unknown');
  assert.equal(down[2].value, 'never');
  assert.deepEqual([down[3].value, down[3].tone], ['unreachable', 'danger']);

  const failed = m.overviewFigures(null, null);
  assert.deepEqual([failed[3].value, failed[3].tone], ['unknown', 'neutral']);
});

test('overview items: fixed order, each kind appears and disappears on its data', () => {
  const none = m.overviewItems({ status: null, docs: null, saved: null, dry: null });
  assert.deepEqual(none, []);

  const fiveDocs = [
    { path: 'a.pdf', owner: 'Alex Example', skipped: null, dataless: false },
    { path: 'b.pdf', owner: null, skipped: null, dataless: true },
    { path: 'c.pdf', owner: 'Alex Example', skipped: 'over_limit', dataless: false },
  ];
  const all = m.overviewItems({
    status: { model: { reachable: false }, last_sync: null },
    docs: { max_file_mb: 50, documents: fiveDocs },
    saved,
    dry: { status: 'ok', items: [], counts: { would_copy: 2, would_move: 1 } },
  });
  assert.deepEqual(all.map((i) => i.pill), ['model unreachable', 're-sort waiting', 'no known owner', 'not indexed', 'only in iCloud']);
  assert.equal(all[1].title, '3 copies are not where the lists put them');
  assert.equal(all[1].action, 'preview and apply');
  assert.equal(all[2].title, '1 document filed under Shared');
  assert.equal(all[3].title, '1 document can’t be searched');
  assert.equal(all[3].meta, '1 over 50 MB. Ask never uses them.');
  assert.equal(all[4].title, '1 file isn’t on this Mac');

  const up = m.overviewItems({
    status: { model: { reachable: true }, last_sync: null },
    docs: { max_file_mb: 50, documents: fiveDocs },
    saved,
    dry: null,
  });
  assert.deepEqual(up.map((i) => i.pill), ['no known owner', 'not indexed', 'only in iCloud']);

  // The one-copy singular and the clear case: all-clear gives [].
  assert.deepEqual(m.overviewItems({
    status: { model: { reachable: true }, last_sync: '2025-03-09T05:24:00Z' },
    docs: { max_file_mb: 50, documents: [fiveDocs[0]] },
    saved,
    dry: { status: 'ok', items: [], counts: { would_copy: 0, would_move: 0 } },
  }), []);
});

test('syncLabel is month-line or never; plural switches at one', () => {
  assert.equal(m.syncLabel(null), 'never');
  assert.match(m.syncLabel('2025-03-09T05:24:00Z'), /^[0-9]+ \w{3}, \d{2}:\d{2}$/);
  assert.equal(m.plural(1, 'copy', 'copies'), 'copy');
  assert.equal(m.plural(3, 'copy', 'copies'), 'copies');
});

test('all-clear needs a usable library and an ok dry-run, not a present report', () => {
  const saved = { folders: [], owners: ['Piotr'], shared_owner: 'shared' };
  const status = { model: { reachable: true }, last_sync: null };
  const docs = { status: 'ok', max_file_mb: 50, documents: [{ owner: 'Piotr', skipped: null, dataless: false }] };
  const dry = { status: 'ok', items: [], counts: { would_copy: 0, would_move: 0 } };
  const clear = { docs, docsError: null, status, saved, notice: m.libraryNotice(docs), dry, items: [] };
  assert.equal(m.allClear(clear), true);

  // A report can be valid JSON and still describe a library that needs attention: both the recovery
  // notice and a dry-run that cannot answer must keep "nothing needs you" hidden.
  for (const unusable of ['no_database', 'outdated']) {
    const brokenDocs = { status: unusable, max_file_mb: 50, documents: [] };
    assert.equal(m.allClear({ ...clear, docs: brokenDocs, notice: m.libraryNotice(brokenDocs), dry: { status: unusable, items: [], counts: {} } }), false, unusable);
    assert.equal(m.allClear({ ...clear, dry: { status: unusable, items: [], counts: {} } }), false, `${unusable} dry-run`);
  }
  assert.equal(m.allClear({ ...clear, dry: null }), false, 'a dry-run that has not landed or failed');
  assert.equal(m.allClear({ ...clear, notice: 'The library is empty. Add documents and run "lets-rag-docs ingest".' }), false, 'a library notice wins over the clear state');
});

test('a filing preview counts only while its generation is current', () => {
  const saved = { folders: [], owners: ['Piotr'], shared_owner: 'shared' };
  const status = { model: { reachable: true }, last_sync: null };
  const docs = { status: 'ok', max_file_mb: 50, documents: [{ owner: 'Piotr', skipped: null, dataless: false }] };
  const stalePreview = { status: 'ok', items: [], counts: { would_copy: 0, would_move: 0 } };
  const freshMemo = { generation: 4, report: { status: 'ok', items: [], counts: { would_copy: 1, would_move: 0 } } };

  // A zero-move preview taken at generation 3 must not hide the copy the document added at 4 needs.
  const current = m.overviewDryReport({ preview: stalePreview, previewGeneration: 3, memo: freshMemo, generation: 4 });
  assert.equal(current, freshMemo.report);
  assert.deepEqual(m.overviewItems({ status, docs, saved, dry: current }).map((item) => item.pill), ['re-sort waiting']);
  assert.equal(m.overviewDryReport({ preview: stalePreview, previewGeneration: 4, memo: freshMemo, generation: 4 }), stalePreview, 'a current preview is the same pass');
  assert.equal(m.overviewDryReport({ preview: null, previewGeneration: -1, memo: null, generation: 4 }), null, 'nothing current to show');
});

test('callers join a pending dry-run; only a settled failure is retried', async () => {
  let calls = 0;
  let resolveRun;
  const engine = () => {
    calls += 1;
    return new Promise((resolve) => {
      resolveRun = resolve;
    });
  };
  const memo = new m.DryRunMemo(engine, () => 1);
  const first = memo.ensure(1);
  const second = memo.ensure(1);
  assert.equal(second, first, 'the second caller joins the pass already hashing');
  assert.equal(calls, 1, 'one hash pass per library state');
  resolveRun({ ok: true, report: { status: 'ok', items: [], counts: {} } });
  const landed = await first;
  assert.equal(landed.report.status, 'ok');
  assert.equal(memo.ensure(1), first, 'a current pass is reused by later visits');
  assert.equal(calls, 1);

  // A run that settled as a failure is not a result to keep.
  let brokenCalls = 0;
  const broken = new m.DryRunMemo(() => {
    brokenCalls += 1;
    return Promise.resolve({ ok: false, error: 'engine hung up' });
  }, () => 1);
  assert.equal((await broken.ensure(1)).report, null);
  assert.equal(broken.failure(1), 'engine hung up');
  await broken.ensure(1);
  assert.equal(brokenCalls, 2, 'the next visit retries a settled failure');

  // A save while hashing discards that pass rather than caching a report about the old lists.
  const moved = new m.DryRunMemo(() => Promise.resolve({ ok: true, report: { status: 'ok', items: [], counts: {} } }), () => 2);
  assert.equal(await moved.ensure(1), null);
});
