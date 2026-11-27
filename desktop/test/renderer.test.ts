import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';

const RENDERER = join(import.meta.dirname, '..', 'renderer');

test('the sidebar is one shared component: overview, ask, filing, settings in that order', () => {
	const html = readFileSync(join(RENDERER, 'index.html'), 'utf8');
	assert.ok(html.includes('<nav id="sidebar" class="nav" aria-label="sections">'), 'no #sidebar nav');
	assert.ok(html.includes('id="overviewScreen"'), 'no overview screen');
	assert.ok(html.includes('<symbol id="i-inbox"'), 'no inbox glyph');
	// The rows are built by renderer/sidebar.js, so the HTML carries no per-screen nav copy.
	const js = readFileSync(join(RENDERER, 'sidebar.js'), 'utf8');
	const order = /\['overview', 'ask', 'filing', 'settings'\]/.exec(js);
	assert.ok(order, 'sidebar.js missing the section order');
	assert.equal(js.includes('graph'), false, 'graph is LET-139, not this app');
	// The count pill: neutral tokens only, never a tone colour.
	const css = readFileSync(join(RENDERER, 'app.css'), 'utf8');
	const countRules = [...css.matchAll(/\.nav[^{]*\.count[^{]*\{[^}]*\}/g)].map((match) => match[0]);
	assert.ok(countRules.length >= 2, 'no .nav .count rules');
	assert.ok(countRules.some((rule) => rule.includes('--raised')) && countRules.some((rule) => rule.includes('--surface')));
	assert.equal(/danger|attention|positive/.test(countRules.join(' ')), false, 'the count must never be coloured');
	// A zero count must hide the pill outright (sidebar.js sets `hidden`; the `.count` class sets
	// display, so a `[hidden]` rule is needed to beat it). Finding 7: no empty badge on all-clear.
	assert.ok(/\.nav[^{]*\.count\[hidden\][^{]*\{[^}]*display:\s*none/.test(css), 'the zero count pill must be hidden');
	// Keyboard users still get the design's focus ring.
	assert.ok(/:focus-visible/.test(css), ':focus-visible rule lost');
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

test('the library pane carries search, add and open', () => {
	const html = readFileSync(join(RENDERER, 'index.html'), 'utf8');
	// plus button by the heading, labelled for screen readers
	assert.ok(html.includes('<button id="addDocsButton" type="button" class="btn icon-only" aria-label="add documents">'));
	// the search field uses the design's field styles and type=search
	assert.match(html, /<input id="librarySearch" type="search"/);
	// the arrow glyph for opening documents, sized like every other inline icon
	assert.ok(html.includes('<symbol id="i-arrow-up-right" viewBox="0 0 24 24"><path d="M7 17 17 7M8 7h9v9"></path></symbol>'));
	const js = readFileSync(join(RENDERER, 'app.js'), 'utf8');
	assert.ok(js.includes("icon('arrow-up-right', 18)"), 'open buttons need the arrow glyph');
	assert.ok(js.includes('api.openDocument('), 'open goes through main');
	assert.ok(js.includes('api.pickFiles(') && js.includes('api.addNext(') && js.includes('api.cancelAdd('), 'the add queue is driven from main');
	assert.ok(js.includes('api.search('), 'search goes through main');
});

test('the page has no demo or sample mode', () => {
	const js = readFileSync(join(RENDERER, 'app.js'), 'utf8') + readFileSync(join(RENDERER, 'model.js'), 'utf8');
	for (const token of ['demo', 'SAMPLE', 'location.hash', 'Acme']) assert.equal(js.includes(token), false, token);
});

test('renderer has the design surfaces needed for ask and filing', () => {
	const html = readFileSync(join(RENDERER, 'index.html'), 'utf8');
	for (const id of ['appBar', 'appTitle', 'askForm', 'askInput', 'askButton', 'libraryRows', 'conversationPane', 'citations', 'filingScreen', 'listPane', 'addButton', 'addDocsButton', 'librarySearch', 'addPanel', 'addRows', 'addCancel', 'addMeta', 'openDocs', 'openError', 'detailPane', 'viewSwitch', 'filingRows', 'pathTokens', 'noticeCard', 'noticePill', 'resortButton', 'movesSection', 'applyButton', 'showAllButton', 'laterButton', 'nameInput', 'nameHelper', 'saveButton', 'removeButton', 'settingsScreen', 'appearance', 'loginSwitch']) {
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
	for (const state of ['ask', 'ask-search', 'add-running', 'add-done', 'folders', 'editing', 'owners', 'owners-empty', 'adding', 'error', 'shared', 'changed', 'preview', 'small', 'settings', 'settings-small']) {
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

test('the onboarding styles do not re-skin the screens that were already there', () => {
	// A new bare `.name` rule wins over an older one of the same name, so an onboarding rule that reuses a
	// class the filing/ask/settings screens already style silently re-types them — the `.subhead` duplicate
	// re-typed the filing preview's "what will move" heading and turned filing-preview-dark/light red in CI.
	const css = readFileSync(join(RENDERER, 'app.css'), 'utf8');
	const start = css.indexOf('/* ---- first-run onboarding');
	const end = css.indexOf('/* ---- Smallest window');
	assert.ok(start > 0 && end > start, 'onboarding style block not found in app.css');
	const bare = (text: string) => [...text.matchAll(/^(\.[a-z][a-z0-9-]+) \{$/gm)].map((match) => match[1]);
	const earlier = new Set(bare(css.slice(0, start)));
	for (const name of bare(css.slice(start, end))) {
		assert.equal(earlier.has(name), false, `${name} is already styled earlier in app.css; the onboarding rule would re-skin that screen`);
	}
});

test('every renderer file parses as plain JavaScript, not TypeScript', () => {
	// The renderer ships as plain .js (index.html loads it directly), so a stray type annotation is a
	// runtime SyntaxError the page swallows as "page never settled". `tsc` only checks src/, so this is
	// the guard: node's own parser must accept every renderer script.
	for (const file of readdirSync(RENDERER).filter((name) => name.endsWith('.js'))) {
		const result = spawnSync(process.execPath, ['--check', join(RENDERER, file)], { encoding: 'utf8' });
		assert.equal(result.status, 0, `renderer/${file} is not valid JavaScript: ${result.stderr}`);
	}
});
