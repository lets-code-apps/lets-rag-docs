import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ASSETS = join(import.meta.dirname, '..', 'assets');

function ihdr(path: string): { width: number; height: number; bitDepth: number; colorType: number } {
	const bytes = readFileSync(join(ASSETS, path));
	return {
		width: bytes.readUInt32BE(16),
		height: bytes.readUInt32BE(20),
		bitDepth: bytes[24],
		colorType: bytes[25],
	};
}

test('menu template is 18x18 and 36x36 RGBA', () => {
	const one = ihdr('menubarTemplate.png');
	const two = ihdr('menubarTemplate@2x.png');
	assert.deepEqual([one.width, one.height, one.bitDepth, one.colorType], [18, 18, 8, 6]);
	assert.deepEqual([two.width, two.height, two.bitDepth, two.colorType], [36, 36, 8, 6]);
});

test('app icon is 1024x1024 RGBA', () => {
	const icon = ihdr('icon.png');
	assert.deepEqual([icon.width, icon.height, icon.bitDepth, icon.colorType], [1024, 1024, 8, 6]);
});