// The pure comparator for desktop CI (scripts/shot-diff.mjs), on synthetic BGRA buffers built in the test
// — no PNG files, no image library. It covers the four decisions that matter: a pixel only counts when a
// channel moves more than PIXEL_DELTA, a shot is "changed" only above MAX_RATIO (so antialiasing noise is
// ignored), and size/new/removed differences are reported, with renderMarkdown filtering unsafe names.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { diffBitmaps, compareSets, renderMarkdown, PIXEL_DELTA, MAX_RATIO } from '../scripts/shot-diff.mjs';

/** A solid w×h BGRA image, then a helper that darkens exactly `count` pixels on the blue channel. */
function solid(w, h, rgb) {
	const buf = Buffer.alloc(w * h * 4);
	for (let i = 0; i < buf.length; i += 4) {
		buf[i] = rgb[0];
		buf[i + 1] = rgb[1];
		buf[i + 2] = rgb[2];
		buf[i + 3] = 255;
	}
	return buf;
}
function withDiff(w, h, count) {
	const a = solid(w, h, [0, 0, 0]);
	const b = Buffer.from(a);
	for (let i = 0; i < count; i++) b[i * 4] = 200;
	return { a, b };
}

test('identical bitmaps report zero difference', () => {
	const a = solid(4, 4, [10, 20, 30]);
	const res = diffBitmaps(a, Buffer.from(a), 4, 4);
	assert.deepEqual(res, { differing: 0, ratio: 0, changed: false });
});

test('a channel at or under PIXEL_DELTA does not count the pixel', () => {
	const a = solid(4, 4, [10, 20, 30]);
	const b = Buffer.from(a);
	b[0] = 10 + PIXEL_DELTA; // exactly the threshold
	const res = diffBitmaps(a, b, 4, 4);
	assert.equal(res.differing, 0);
});

test('a channel just over PIXEL_DELTA counts that one pixel', () => {
	const a = solid(4, 4, [10, 20, 30]);
	const b = Buffer.from(a);
	b[0] = 10 + PIXEL_DELTA + 1;
	const res = diffBitmaps(a, b, 4, 4);
	assert.equal(res.differing, 1);
});

test('changed flips just past MAX_RATIO (so noise below it is ignored)', () => {
	// MAX_RATIO is 0.002, so over a 1000-pixel image 2 differing pixels are not "changed", 3 are.
	assert.equal(MAX_RATIO, 0.002);
	const { a, b } = withDiff(1000, 1, 2);
	assert.equal(diffBitmaps(a, b, 1000, 1).changed, false);
	const over = withDiff(1000, 1, 3);
	assert.equal(diffBitmaps(over.a, over.b, 1000, 1).changed, true);
});

test('a size change is reported as changed with the reason', () => {
	const rows = compareSets(['ask.png'], ['ask.png'], { 'ask.png': { ratio: 1, reason: 'size changed', size: '2400x1640 vs 1200x820' } });
	assert.equal(rows.length, 1);
	assert.equal(rows[0].status, 'changed');
	assert.equal(rows[0].reason, 'size changed');
});

test('a shot with no baseline and a baseline with no new shot are both reported', () => {
	const rows = compareSets(['gone.png', 'same.png'], ['new.png', 'same.png'], { 'same.png': { ratio: 0 } });
	assert.deepEqual(rows.map((r) => `${r.name}:${r.status}`).sort(), ['gone.png:removed', 'new.png:new']);
});

test('a fully matching set reports nothing and says all match', () => {
	const rows = compareSets(['a.png', 'b.png'], ['a.png', 'b.png'], { 'a.png': { ratio: 0 }, 'b.png': { ratio: 0.0001 } });
	assert.deepEqual(rows, []);
	assert.match(renderMarkdown(rows, 'https://github.com/x/y/actions', 2), /All 2 screenshots match the committed baseline/);
});

test('renderMarkdown keeps the hidden marker and drops unsafe shot names', () => {
	const rows = [
		{ name: 'settings-dark.png', status: 'changed', ratio: 0.05 },
		{ name: '../evil.png', status: 'changed', ratio: 0.5 },
		{ name: 'ask.png', status: 'new' },
	];
	const md = renderMarkdown(rows, 'run-url', 3);
	assert.ok(md.startsWith('<!-- desktop-shots -->'));
	assert.ok(md.includes('settings-dark.png'));
	assert.ok(md.includes('ask.png'));
	assert.equal(md.includes('evil'), false);
});
