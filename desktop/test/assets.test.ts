// The icons must be real PNGs Electron can load: signature, IHDR, and pixel data that inflates
// to exactly height x (1 filter byte + width x 4 RGBA bytes).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { inflateSync } from 'node:zlib';

const ASSETS = join(import.meta.dirname, '..', 'assets');
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function decode(path: string): { width: number; height: number; bitDepth: number; colorType: number; opaque: number } {
	const bytes = readFileSync(join(ASSETS, path));
	assert.deepEqual(bytes.subarray(0, 8), SIGNATURE, `${path} has no PNG signature`);
	const idat: Buffer[] = [];
	let offset = 8;
	let header = { width: 0, height: 0, bitDepth: 0, colorType: 0 };
	while (offset < bytes.length) {
		const length = bytes.readUInt32BE(offset);
		const type = bytes.toString('latin1', offset + 4, offset + 8);
		const data = bytes.subarray(offset + 8, offset + 8 + length);
		if (type === 'IHDR') header = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), bitDepth: data[8], colorType: data[9] };
		if (type === 'IDAT') idat.push(data);
		offset += 12 + length;
	}
	const pixels = inflateSync(Buffer.concat(idat));
	assert.equal(pixels.length, header.height * (1 + header.width * 4), `${path} pixel data does not match its size`);
	// Count rows with any non-transparent pixel cheaply: a blank icon would have none.
	let opaque = 0;
	for (let i = 0; i < pixels.length; i++) if (i % (1 + header.width * 4) !== 0 && i % 4 === 0 && pixels[i] !== 0) opaque++;
	return { ...header, opaque };
}

test('menu template is 18x18 and 36x36 RGBA and not blank', () => {
	const one = decode('menubarTemplate.png');
	const two = decode('menubarTemplate@2x.png');
	assert.deepEqual([one.width, one.height, one.bitDepth, one.colorType], [18, 18, 8, 6]);
	assert.deepEqual([two.width, two.height, two.bitDepth, two.colorType], [36, 36, 8, 6]);
	assert.ok(one.opaque > 0 && two.opaque > 0);
});

test('app icon is 1024x1024 RGBA and not blank', () => {
	const icon = decode('icon.png');
	assert.deepEqual([icon.width, icon.height, icon.bitDepth, icon.colorType], [1024, 1024, 8, 6]);
	assert.ok(icon.opaque > 0);
});
