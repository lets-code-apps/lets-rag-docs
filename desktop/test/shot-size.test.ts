// The shot-size decisions: the two fixed capture sizes, the bounded wait that confirms a size, the
// one mismatch message, and the PNG-header reader. Pure and Electron-free, so it runs under `node --test`
// with no real sleeping and no browser.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SHOT_SIZES, pngSize, sizeMismatch, waitForSize } from '../src/shot-size.ts';

const WANT = { width: 1200, height: 660 };

test('SHOT_SIZES locks exactly the two fixed capture sizes', () => {
	assert.deepEqual(SHOT_SIZES, { wide: { width: 1200, height: 660 }, narrow: { width: 360, height: 660 } });
});

test('waitForSize returns at once when the size already matches', async () => {
	let sleeps = 0;
	const read = () => ({ width: 1200, height: 660 });
	const got = await waitForSize(read, WANT, { sleep: () => { sleeps += 1; return Promise.resolve(); } });
	assert.deepEqual(got, WANT);
	assert.equal(sleeps, 0);
});

test('waitForSize waits between reads until the size settles', async () => {
	const sizes = [{ width: 1200, height: 674 }, { width: 1200, height: 668 }, { width: 1200, height: 660 }];
	let i = 0;
	let sleeps = 0;
	const got = await waitForSize(() => sizes[i++], WANT, { sleep: () => { sleeps += 1; return Promise.resolve(); } });
	assert.deepEqual(got, WANT);
	assert.equal(i, 3);
	assert.equal(sleeps, 2);
});

test('waitForSize gives up after timeoutMs and returns the last wrong size', async () => {
	const wrong = { width: 1200, height: 674 };
	let sleeps = 0;
	const got = await waitForSize(() => wrong, WANT, { timeoutMs: 100, intervalMs: 25, sleep: () => { sleeps += 1; return Promise.resolve(); } });
	assert.deepEqual(got, wrong);
	assert.ok(sleeps > 0);
});

test('sizeMismatch formats expected vs actual in one line', () => {
	assert.equal(
		sizeMismatch('ask-light capture', { width: 1200, height: 660 }, { width: 1200, height: 674 }),
		'ask-light capture: expected 1200x660, got 1200x674',
	);
});

test('pngSize reads the IHDR width and height from a PNG header', () => {
	const sig = Buffer.from([0x89, 0x50, 0x4e, 0x44, 0x0d, 0x0a, 0x1a, 0x0a]);
	const len = Buffer.alloc(4);
	len.writeUInt32BE(13);
	const type = Buffer.from('IHDR', 'ascii');
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(1200, 0);
	ihdr.writeUInt32BE(660, 4);
	const png = Buffer.concat([sig, len, type, ihdr]);
	assert.deepEqual(pngSize(png), { width: 1200, height: 660 });
});

test('pngSize throws on a buffer that is not a PNG', () => {
	assert.throws(() => pngSize(Buffer.alloc(4))); // too short for an IHDR
	assert.throws(() => pngSize(Buffer.alloc(24))); // long enough but the signature is wrong
});
