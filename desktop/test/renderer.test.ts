import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const RENDERER = join(import.meta.dirname, '..', 'renderer');

test('renderer has exactly the ask, filing and settings nav entries', () => {
	const html = readFileSync(join(RENDERER, 'index.html'), 'utf8');
	const sections = [...html.matchAll(/data-section="([a-z]+)"/g)].map((match) => match[1]);
	assert.deepEqual(sections, ['ask', 'filing', 'settings']);
	// Each entry has its 18px design glyph left of the label: search, archive, settings (last).
	assert.ok(html.includes('<use href="#i-search"></use></svg><span>ask</span></button>'));
	assert.ok(html.includes('<use href="#i-archive"></use></svg><span>filing</span></button>'));
	assert.ok(html.includes('<use href="#i-settings"></use></svg><span>settings</span></button>'));
});

test('every inline glyph has an explicit size', () => {
	const html = readFileSync(join(RENDERER, 'index.html'), 'utf8');
	const uses = [...html.matchAll(/<svg class="icon"([^>]*)>/g)];
	assert.ok(uses.length > 5);
	for (const [, attrs] of uses) assert.match(attrs, /width="(16|18|20)" height="(16|18|20)"/);
	const js = readFileSync(join(RENDERER, 'app.js'), 'utf8');
	assert.ok(js.includes("svg.setAttribute('width', String(px))"));
});

test('the ask form sits at the bottom of the conversation, the AppBar holds only the emblem', () => {
	const html = readFileSync(join(RENDERER, 'index.html'), 'utf8');
	const appBar = html.slice(html.indexOf('<header id="appBar"'), html.indexOf('</header>'));
	assert.equal(appBar.includes('input'), false);
	assert.ok(appBar.includes('class="emblem"'));
	// The bar now also carries the centred app name: an #appTitle span reading "rag docs".
	assert.ok(appBar.includes('id="appTitle"'), 'AppBar missing #appTitle');
	assert.ok(appBar.includes('>rag docs<'), 'AppBar title text missing');
	const conversation = html.slice(html.indexOf('<main class="conversation">'), html.indexOf('</main>'));
	assert.ok(conversation.indexOf('id="conversationPane"') < conversation.indexOf('id="askForm"'));
	assert.ok(conversation.includes('id="askInput"'));
});

test('the page has no demo or sample mode', () => {
	const js = readFileSync(join(RENDERER, 'app.js'), 'utf8') + readFileSync(join(RENDERER, 'model.js'), 'utf8');
	for (const token of ['demo', 'SAMPLE', 'location.hash', 'Acme']) assert.equal(js.includes(token), false, token);
});

test('renderer has the design surfaces needed for ask and filing', () => {
	const html = readFileSync(join(RENDERER, 'index.html'), 'utf8');
	for (const id of ['appBar', 'appTitle', 'askForm', 'askInput', 'askButton', 'libraryRows', 'conversationPane', 'citations', 'filingScreen', 'listPane', 'addButton', 'detailPane', 'viewSwitch', 'filingRows', 'pathTokens', 'noticeCard', 'noticePill', 'resortButton', 'movesSection', 'applyButton', 'showAllButton', 'laterButton', 'nameInput', 'nameHelper', 'saveButton', 'removeButton', 'settingsScreen', 'appearance', 'loginSwitch']) {
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
	const js = readFileSync(join(RENDERER, 'app.js'), 'utf8') + readFileSync(join(RENDERER, 'model.js'), 'utf8');
	for (const token of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) {
		assert.equal(js.includes(token), false);
	}
});

test('the app name is centred in the bar and reserves room for the emblem', () => {
	const html = readFileSync(join(RENDERER, 'index.html'), 'utf8');
	const css = readFileSync(join(RENDERER, 'app.css'), 'utf8');
	assert.ok(html.includes('<span id="appTitle" class="appbar-title">rag docs</span>'));
	const title = css.match(/\.appbar-title\s*\{([^}]*)\}/);
	assert.ok(title, 'missing .appbar-title rule');
	for (const tok of ['calc(100% - 264px)', 'font-size: 15px', 'font-weight: 500', 'text-overflow: ellipsis', 'left: 50%']) {
		assert.ok(title[1].includes(tok), `.appbar-title missing ${tok}`);
	}
	const appbar = css.match(/\.appbar\s*\{([^}]*)\}/);
	assert.ok(appbar && appbar[1].includes('position: relative'), '.appbar must be position: relative');
});

test('screenshots cover the ask, filing and settings states in light and dark', () => {
	const main = readFileSync(join(import.meta.dirname, '..', 'src', 'main.ts'), 'utf8');
	for (const state of ['ask', 'folders', 'editing', 'owners', 'owners-empty', 'adding', 'error', 'shared', 'changed', 'preview', 'small', 'settings', 'settings-small']) {
		for (const mode of ['light', 'dark']) {
			assert.ok(main.includes(state) && main.includes(mode), `shots missing ${state}-${mode}`);
		}
	}
});

test('the open-at-login switch is named by a 44px label row that also toggles it', () => {
	const html = readFileSync(join(RENDERER, 'index.html'), 'utf8');
	const css = readFileSync(join(RENDERER, 'app.css'), 'utf8');
	const row = html.match(/<label class="switchrow" for="loginSwitch">([\s\S]*?)<\/label>/);
	assert.ok(row, 'switch is not inside its label');
	assert.match(row[1], /<span class="lbl">open at login<\/span>/);
	assert.match(row[1], /<input id="loginSwitch"[^>]*role="switch"[^>]*aria-describedby="loginHelper"/);
	assert.match(css, /\.switchrow \{[^}]*min-height: 44px;/);
});

test('the settings article sits right after the sidebar, not centred', () => {
	const css = readFileSync(join(RENDERER, 'app.css'), 'utf8');
	const body = css.match(/\.settings-body \{([^}]*)\}/);
	assert.ok(body);
	assert.doesNotMatch(body[1], /margin: 0 auto/);
});
