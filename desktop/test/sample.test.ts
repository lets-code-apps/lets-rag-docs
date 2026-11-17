import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { SAMPLE } from '../src/models.ts';

test('every SAMPLE key has a visible marked renderer slot', () => {
	const html = readFileSync(join(import.meta.dirname, '..', 'renderer', 'index.html'), 'utf8');
	for (const key of Object.keys(SAMPLE)) {
		assert.ok(html.includes(`data-sample="true" data-key="${key}"`), `missing sample element for ${key}`);
	}
});

test('README lists exactly the sample keys', () => {
	const readme = readFileSync(join(import.meta.dirname, '..', 'README.md'), 'utf8');
	for (const key of Object.keys(SAMPLE)) {
		assert.ok(readme.includes(`| ${key} |`), `README sample table missing ${key}`);
	}
	assert.ok(readme.includes('## Sample data'));
});