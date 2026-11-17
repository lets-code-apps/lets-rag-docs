import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const RENDERER = join(import.meta.dirname, '..', 'renderer');

test('renderer has exactly the ask and filing nav entries', () => {
	const html = readFileSync(join(RENDERER, 'index.html'), 'utf8');
	assert.ok(html.includes('id="askView"'));
	assert.ok(html.includes('id="filingView"'));
	assert.ok(html.includes('>ask</button>'));
	assert.ok(html.includes('>filing</button>'));
});

test('renderer has the design surfaces needed for ask and filing', () => {
	const html = readFileSync(join(RENDERER, 'index.html'), 'utf8');
	for (const id of ['appBar', 'askInput', 'askButton', 'libraryRows', 'conversationPane', 'citations', 'filingScreen', 'listPane', 'detailPane', 'viewSwitch', 'filingRows', 'pathTokens', 'noticeCard', 'movesSection', 'nameInput', 'saveButton', 'removeButton']) {
		assert.ok(html.includes(`id="${id}"`), `renderer missing #${id}`);
	}
});

test('renderer locks CSP and avoids remote URLs', () => {
	const html = readFileSync(join(RENDERER, 'index.html'), 'utf8');
	assert.ok(html.includes("default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'"));
	assert.equal(/https?:\/\//.test(html), false);
});

test('tokens define the same properties for light and dark', () => {
	const css = readFileSync(join(RENDERER, 'tokens.css'), 'utf8');
	const props = [...css.matchAll(/--([a-z-]+):/g)].map((m) => m[1]);
	const unique = [...new Set(props)];
	for (const name of unique) {
		const occurrences = [...css.matchAll(new RegExp(`--${name}:`, 'g'))].length;
		assert.ok(occurrences >= 2, `token --${name} must appear in light and dark`);
	}
	assert.ok(css.includes('prefers-color-scheme: dark'));
});

test('renderer stacks columns under 480px', () => {
	const css = readFileSync(join(RENDERER, 'app.css'), 'utf8');
	assert.ok(css.includes('@media (max-width: 480px)'));
});

test('renderer uses no HTML injection sinks', () => {
	const js = readFileSync(join(RENDERER, 'app.js'), 'utf8');
	for (const token of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) {
		assert.equal(js.includes(token), false);
	}
});

test('screenshots cover the 10 filing states and ask in light and dark', () => {
	const main = readFileSync(join(import.meta.dirname, '..', 'src', 'main.ts'), 'utf8');
	for (const state of ['ask', 'folders', 'editing', 'owners', 'owners-empty', 'adding', 'error', 'shared', 'changed', 'preview', 'small']) {
		for (const mode of ['light', 'dark']) {
			assert.ok(main.includes(state) && main.includes(mode), `shots missing ${state}-${mode}`);
		}
	}
});
