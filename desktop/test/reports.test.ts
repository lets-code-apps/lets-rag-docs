import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { parseAsk, parseDocuments, parseFilingSave, parseFilingShow, parseOrganize } from '../src/reports.ts';

const FIXTURES = join(import.meta.dirname, '..', '..', 'testdata', 'desktop');
const read = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

test('fixture reports parse', () => {
	const docs = parseDocuments(read('documents.json'), []);
	assert.ok(docs.ok);
	assert.equal(docs.value.documents[0].path, 'home/car-loan-invoice.pdf');

	const ask = parseAsk(read('ask.json'), []);
	assert.ok(ask.ok);
	assert.equal(ask.value.answer, 'Blue. [manual, chunk 2]');

	const show = parseFilingShow(read('filing.json'), []);
	assert.ok(show.ok);
	assert.equal(show.value.shared_owner, 'Shared');

	const save = parseFilingSave(read('filing-errors.json'), []);
	assert.ok(save.ok);
	assert.equal(save.value.errors[0].code, 'invalid_name');

	const dry = parseOrganize(read('organize-dry-run.json'), []);
	assert.ok(dry.ok);
	assert.equal(dry.value.counts.would_copy, 1);
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