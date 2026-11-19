// The layout rules smoke runs inside the page. GEOMETRY is a string passed to executeJavaScript, so `tsc`
// does not check its body — these tests parse it as an async page function, run it against an empty page
// (so every rule short-circuits to no failure), and assert each rule id is present in the source. The real
// page assertions run in `npm run smoke`; the deliberate red CI run shows one of them firing.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GEOMETRY, APPBAR_CLEAR, MIN_TARGET, TOLERANCE, KNOWN_SHORT } from '../src/geometry.ts';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

test('the geometry constants are the design numbers', () => {
	assert.equal(APPBAR_CLEAR, 132);
	assert.equal(MIN_TARGET, 44);
	assert.equal(TOLERANCE, 1);
	assert.deepEqual(KNOWN_SHORT, ['.seg button', '.nav button']);
});

test('GEOMETRY parses as an async page function', () => {
	const fn = new AsyncFunction('document', 'window', GEOMETRY);
	assert.equal(typeof fn, 'function');
});

test('GEOMETRY returns { ok, failures } on an empty page and names every rule', async () => {
	const fn = new AsyncFunction('document', 'window', GEOMETRY);
	const emptyPage = { querySelector: () => null, querySelectorAll: () => [] };
	const result = await fn(emptyPage, { innerWidth: 1200 });
	assert.equal(result.ok, true);
	assert.deepEqual(result.failures, []);
	for (const id of ['settings-article', 'library-search', 'appbar-clear', 'control-height']) {
		assert.ok(GEOMETRY.includes(id), `GEOMETRY missing rule id ${id}`);
	}
});
