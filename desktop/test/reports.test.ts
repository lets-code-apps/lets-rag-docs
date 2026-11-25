import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
	errorLine,
	parseAdd,
	parseAsk,
	parseDocuments,
	parseFilingSave,
	parseFilingShow,
	parseLocate,
	parseOrganize,
	parseSearch,
	parseStatus,
} from '../src/reports.ts';

const FIXTURES = join(import.meta.dirname, '..', '..', 'testdata', 'desktop');
const read = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

test('fixture reports parse', () => {
	const docs = parseDocuments(read('documents.json'), []);
	assert.ok(docs.ok);
	assert.equal(docs.value.documents[0].path, 'big-scan.pdf');

	const ask = parseAsk(read('ask.json'), []);
	assert.ok(ask.ok);
	assert.equal(ask.value.answer, 'Blue. [manual, chunk 2]');

	const show = parseFilingShow(read('filing.json'), []);
	assert.ok(show.ok);
	assert.equal(show.value.shared_owner, 'Shared');

	const save = parseFilingSave(read('filing-errors.json'), []);
	assert.ok(save.ok);
	assert.equal(save.value.errors[0].code, 'invalid_name');
	// The save report carries the shared owner in effect, so a save can repaint the row.
	assert.equal(save.value.shared_owner, 'Shared');

	const dry = parseOrganize(read('organize-dry-run.json'), []);
	assert.ok(dry.ok);
	assert.equal(dry.value.counts.would_copy, 1);
});

test('sizes, pages and the skip reason parse; an older engine reads as null', () => {
	const docs = parseDocuments(read('documents.json'), []);
	assert.ok(docs.ok);
	assert.equal(docs.value.max_file_mb, 50);
	// The over-limit original: a size, no title, and the reason it was never OCR'd.
	const big = docs.value.documents[0];
	assert.equal(big.bytes, 51_000_000);
	assert.equal(big.pages, null);
	assert.equal(big.skipped, 'over_limit');
	// A small OCR'd original: its own byte count and its page count from the markers.
	const scanned = docs.value.documents.find((r) => r.path === 'scans/scan.pdf');
	assert.ok(scanned !== undefined);
	assert.equal(scanned.bytes, 6);
	assert.equal(scanned.pages, 2);
	assert.equal(scanned.skipped, null);
	const old = parseDocuments('{"version":1,"status":"ok","documents":[{"path":"a.pdf","type":"invoice","title":null,"date":null,"folder":null,"owner":null,"filed_as":null}]}', []);
	assert.ok(old.ok);
	assert.equal(old.value.max_file_mb, null);
	assert.equal(old.value.documents[0].bytes, null);
	assert.equal(old.value.documents[0].pages, null);
	assert.equal(old.value.documents[0].skipped, null);
});

test('search, add and locate reports parse', () => {
	const search = parseSearch(read('search.json'), []);
	assert.ok(search.ok);
	assert.equal(search.value.passages[0].page, 4);
	// An old OCR file has no page: the key may be absent, which is unknown, not page 1.
	const noPage = parseSearch('{"version":1,"passages":[{"source":"a","file":"a.pdf.text.txt","chunk":0,"score":0.5}]}', []);
	assert.ok(noPage.ok);
	assert.equal(noPage.value.passages[0].page, null);

	const added = parseAdd(read('add.json'), []);
	assert.ok(added.ok);
	assert.equal(added.value.status, 'added');
	const dup = parseAdd(read('add-duplicate.json'), []);
	assert.ok(dup.ok);
	assert.equal(dup.value.status, 'duplicate');
	assert.equal(dup.value.duplicate_of, 'tax.return.2025.pdf');

	const filed = parseLocate(read('locate.json'), []);
	assert.ok(filed.ok);
	assert.equal(filed.value.status, 'ok');
	assert.equal(filed.value.kind, 'filed');
	const missing = parseLocate(read('locate-missing.json'), []);
	assert.ok(missing.ok);
	assert.equal(missing.value.status, 'missing');
	assert.equal(missing.value.path, null);
});

test('ask sources carry the page, null when unknown', () => {
	const ask = parseAsk(read('ask.json'), []);
	assert.ok(ask.ok);
	assert.equal(ask.value.sources[0].page, null);
	const paged = parseAsk('{"version":1,"answer":"x","sources":[{"source":"a","file":"a.pdf.vision.txt","chunk":3,"page":4,"score":0.5}]}', []);
	assert.ok(paged.ok);
	assert.equal(paged.value.sources[0].page, 4);
});

test('a save report carries the shared owner it just saved', () => {
	const withShared = parseFilingSave(
		'{"version":1,"ok":true,"saved":true,"renamed":0,"folders":["Home"],"owners":["Alex Example"],"shared_owner":"Household","errors":[]}',
		[],
	);
	assert.ok(withShared.ok);
	assert.equal(withShared.value.shared_owner, 'Household');
	const older = parseFilingSave('{"version":1,"ok":true,"saved":true,"renamed":0,"folders":["Home"],"owners":["Alex Example"],"errors":[]}', []);
	assert.ok(older.ok);
	assert.equal(older.value.shared_owner, null);
});

test('a save report counts the renamed rows', () => {
	const save = parseFilingSave(read('filing-errors.json'), []);
	assert.ok(save.ok);
	assert.equal(save.value.renamed, 0);
	const renamed = parseFilingSave('{"version":1,"ok":true,"saved":true,"renamed":3,"folders":["Home"],"owners":["Alex Example"],"errors":[]}', []);
	assert.ok(renamed.ok);
	assert.equal(renamed.value.renamed, 3);
});

test('errorLine finds the Error: line past the log noise', () => {
	const tail = ['INFO tracing: starting', 'Error: no text found in the file'];
	assert.equal(errorLine(tail), 'Error: no text found in the file');
	// No Error: line: the last line is the engine's best word.
	assert.equal(errorLine(['first log', 'engine died']), 'engine died');
	assert.equal(errorLine([]), '');
});

test('wrong version is refused', () => {
	const bad = parseDocuments('{"version":2,"status":"ok","documents":[]}', []);
	assert.ok(!bad.ok);
	assert.match(bad.error, /version/);
});

test('missing key is refused', () => {
	const bad = parseDocuments('{"version":1,"status":"ok"}', []);
	assert.ok(!bad.ok);
	assert.match(bad.error, /documents/);
});

test('empty stdout uses the engine\'s stderr reason', () => {
	const bad = parseDocuments('', ['ask: cannot read config']);
	assert.ok(!bad.ok);
	assert.equal(bad.error, 'ask: cannot read config');
});
test('an untitled document keeps the whole library readable', () => {
	const report = JSON.parse(read('documents.json')) as { documents: { title: unknown }[] };
	report.documents[0].title = null;
	const parsed = parseDocuments(JSON.stringify(report), []);
	assert.ok(parsed.ok);
	assert.equal(parsed.value.documents.length, 2);
	assert.equal(parsed.value.documents[0].title, null);
	report.documents[0].title = 42;
	assert.equal(parseDocuments(JSON.stringify(report), []).ok, false);
});

test('status report parses; reachable:false and last_sync:null are data, not failures', () => {
	const status = parseStatus(read('status.json'), []);
	assert.ok(status.ok);
	assert.equal(status.value.model.reachable, true);
	assert.equal(status.value.last_sync, '2024-02-29T00:00:00Z');
	const down = parseStatus('{"version":1,"model":{"reachable":false},"last_sync":null}', []);
	assert.ok(down.ok);
	assert.equal(down.value.model.reachable, false);
	assert.equal(down.value.last_sync, null);
});

test('status: wrong version, missing model, and empty stdout are refused', () => {
	const badVersion = parseStatus('{"version":2,"model":{"reachable":true}}', []);
	assert.ok(!badVersion.ok);
	assert.match(badVersion.error, /version/);
	const noModel = parseStatus('{"version":1,"last_sync":null}', []);
	assert.ok(!noModel.ok);
	assert.match(noModel.error, /model/);
	const empty = parseStatus('', ['status: cannot read config']);
	assert.ok(!empty.ok);
	assert.equal(empty.error, 'status: cannot read config');
});

test('documents: the dataless bit parses; an older engine reads as false', () => {
	const docs = parseDocuments(read('documents.json'), []);
	assert.ok(docs.ok);
	assert.equal(docs.value.documents[0].dataless, false, 'the locked fixture is a normal disk');
	const marked = parseDocuments(read('documents.json').replace('"skipped":null,"dataless":false}', '"skipped":null,"dataless":true}'), []);
	assert.ok(marked.ok);
	assert.equal(marked.value.documents[1].dataless, true, 'an iCloud-only original');
	const old = parseDocuments('{"version":1,"status":"ok","documents":[{"path":"a.pdf","type":"invoice","title":null,"date":null,"folder":null,"owner":null,"filed_as":null}]}', []);
	assert.ok(old.ok);
	assert.equal(old.value.documents[0].dataless, false, 'absent means "not known to be dataless", not unknown');
});
