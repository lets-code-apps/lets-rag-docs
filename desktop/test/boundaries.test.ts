// The executable desktop boundary: local process only, no network/database/TOML deps, no private
// path names, no HTML injection, one child_process user, and the fake engine pinned into smoke/shots.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const DESKTOP = join(import.meta.dirname, '..');
const SRC = join(DESKTOP, 'src');
const RENDERER = join(DESKTOP, 'renderer');

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) out.push(...walk(path));
		else out.push(path);
	}
	return out;
}

const FORBIDDEN_NETWORK = [
	['node', ':', 'http'].join(''),
	['node', ':', 'https'].join(''),
	['node', ':', 'net'].join(''),
	['node', ':', 'dgram'].join(''),
	['fetch', '('].join(''),
	['session', '.', 'fetch'].join(''),
	['net', '.', 'fetch'].join(''),
];

test('package.json pulls in no HTTP-client, database or TOML library', () => {
	const pkg = JSON.parse(readFileSync(join(DESKTOP, 'package.json'), 'utf8'));
	const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
	const forbidden = ['toml', 'sqlite', 'mysql', 'postgres', 'axios', 'node-fetch', 'got', 'superagent', 'undici', 'http', 'playwright'];
	for (const name of deps) {
		for (const word of forbidden) {
			assert.ok(!name.includes(word), `desktop must not depend on ${name} (matches ${word})`);
		}
	}
});

test('no source file makes a network call', () => {
	const violations: string[] = [];
	for (const file of walk(SRC).filter((f) => f.endsWith('.ts'))) {
		const text = readFileSync(file, 'utf8');
		for (const token of FORBIDDEN_NETWORK) {
			if (text.includes(token)) violations.push(`${file}: ${token}`);
		}
	}
	assert.deepEqual(violations, []);
});

test('child_process is only used by engine.ts', () => {
	const token = ['child', '_', 'process'].join('');
	const offenders = walk(SRC).filter((f) => readFileSync(f, 'utf8').includes(token) && !f.endsWith('engine.ts'));
	assert.deepEqual(offenders, []);
});

test('preload exposes the ipc channels', () => {
	const ipc = readFileSync(join(SRC, 'ipc.ts'), 'utf8');
	const preload = readFileSync(join(SRC, 'preload.cjs'), 'utf8');
	for (const name of [
		'ask',
		'cancelAsk',
		'documents',
		'status',
		'filingShow',
		'filingSave',
		'dryRun',
		'resort',
		'settings',
		'setSetting',
		'setupShow',
		'setupSave',
		'modelDetect',
		'modelSave',
		'modelPull',
		'cancelPull',
		'modelPullStatus',
		'setupComplete',
		'modelSetup',
		'pickFolder',
		'installOllama',
	]) {
		assert.ok(ipc.includes(`'rag.${name}'`), `ipc.ts missing ${name}`);
	}
	for (const fn of ['ask', 'cancelAsk', 'documents', 'status', 'search', 'filing', 'saveFiling', 'dryRun', 'resort', 'pickFiles', 'addNext', 'cancelAdd', 'openDocument', 'settings', 'setSetting', 'setupShow', 'setupSave', 'modelDetect', 'modelSave', 'modelPull', 'cancelPull', 'modelPullStatus', 'completeSetup', 'modelSetup', 'pickFolder', 'installOllama']) {
		assert.ok(preload.includes(`${fn}:`), `preload missing ${fn}`);
	}
});

test('every IPC handler checks senderFrame', () => {
	const main = readFileSync(join(SRC, 'main.ts'), 'utf8');
	const handles = main.split('ipcMain.handle(').slice(1);
	// The 15 channels of the shipped app (reads/edit/add/open/settings) plus LET-136's eleven onboarding
	// channels: setup show/save, model detect/save/pull, cancelPull, modelPullStatus, setupComplete, modelSetup,
	// and the two host seams pickFolder + installOllama.
	assert.equal(handles.length, 26, 'all declared channels need handlers');
	// The renderer reaches apply in one place only: the explicit "move N copies" button.
	const page = readFileSync(join(RENDERER, 'app.js'), 'utf8');
	assert.equal(page.split('api.resort(').length - 1, 1);
	assert.ok(page.includes("$('applyButton').addEventListener('click', () => void apply())"));
	for (const block of handles) {
		assert.ok(block.includes('fromUs(event.senderFrame)'), 'handlers must reject foreign senders');
	}
});

test('settings cross the boundary; only the real host ever registers a login item', () => {
	const main = readFileSync(join(SRC, 'main.ts'), 'utf8');
	// The setSetting handler routes through the controller, which is where the allow-list lives.
	assert.ok(main.includes('settingsController.set('), 'setSetting must return through the controller');
	// Exactly one call to the real OS login item (the Electron host); smoke/shots use the in-memory one.
	assert.equal(main.split('setLoginItemSettings').length - 1, 1, 'only the real host registers a login item');
	assert.ok(main.includes('memoryLoginItem'), 'smoke/shots must use an in-memory login item, not the OS one');
});

test('first-run onboarding opens at most one external link, to one fixed URL', () => {
	const main = readFileSync(join(SRC, 'main.ts'), 'utf8');
	// The only external browser hand-off is "install Ollama", to the one fixed download page.
	assert.equal(main.split('shell.openExternal(').length - 1, 1, 'exactly one openExternal');
	const url = ['https', '://ollama.com', '/download'].join('');
	const setup = readFileSync(join(SRC, 'setup.ts'), 'utf8');
	assert.equal(setup.split(url).length - 1, 1, 'main must reference the Ollama URL through the setup.ts constant');
	assert.ok(main.includes('OLLAMA_INSTALL_URL'), 'main must use the constant, never restate the URL');
	// The folder picker and the memory size are main-only host seams (never a page-named path or a socket).
	assert.ok(main.includes('folderPicker = '), 'folder picker host not built in boot');
	assert.ok(main.includes('memoryBytes = '), 'memory host not built in boot');
});

test('smoke and shots hard-set the fake engine', () => {
	const pkg = JSON.parse(readFileSync(join(DESKTOP, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
	for (const name of ['smoke', 'shots']) {
		assert.ok(pkg.scripts[name].includes('RAG_DOCS_ENGINE_PATH=test/fixtures/fake-engine.mjs'), `${name} must set the fake engine`);
	}
});

test('main loads and template-tints the menu icon without setTitle', () => {
	const main = readFileSync(join(SRC, 'main.ts'), 'utf8');
	assert.ok(main.includes('menubarTemplate.png'));
	// setTemplateImage is a NativeImage method: the Tray must be built from the prepared image.
	assert.ok(main.includes('nativeImage.createFromPath(TRAY_ICON)'));
	assert.ok(main.includes('image.setTemplateImage(true)'));
	assert.ok(main.includes('new Tray(image)'));
	assert.equal(/\(t as unknown/.test(main), false);
	assert.equal(main.includes('setTitle'), false);
	assert.ok(main.includes('PRODUCT_NAME'));
});

test('no console output except SMOKE/SHOTS lines', () => {
	const violations: string[] = [];
	for (const file of walk(SRC).filter((f) => f.endsWith('.ts'))) {
		const text = readFileSync(file, 'utf8');
		for (const line of text.split('\n')) {
			if (!line.includes('console.')) continue;
			if (!line.includes('SMOKE') && !line.includes('SHOTS')) violations.push(`${file}: ${line.trim()}`);
		}
	}
	assert.deepEqual(violations, []);
});

test('nothing points at private data directories', () => {
	const forbidden = /(^|[^\w-])(docs|data|evals)\//;
	const hits: string[] = [];
	for (const file of [...walk(SRC), ...walk(RENDERER)]) {
		const text = readFileSync(file, 'utf8');
		if (text.match(forbidden)) hits.push(file);
	}
	assert.deepEqual(hits, []);
});

test('renderer has no HTML injection sinks', () => {
	const violations: string[] = [];
	for (const file of walk(RENDERER).filter((f) => f.endsWith('.js') || f.endsWith('.html'))) {
		const text = readFileSync(file, 'utf8');
		for (const token of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) {
			if (text.includes(token)) violations.push(`${file}: ${token}`);
		}
	}
	assert.deepEqual(violations, []);
});

test('Cargo.toml excludes desktop/ from the crate', () => {
	const cargo = readFileSync(join(DESKTOP, '..', 'Cargo.toml'), 'utf8');
	assert.match(cargo, /exclude\s*=\s*\[[^\]]*"desktop\/"/);
});
test('main brackets real saves and tags dry-runs with the save generation', () => {
	const main = readFileSync(join(SRC, 'main.ts'), 'utf8');
	assert.ok(main.includes('jobs.beginSave();'));
	assert.ok(main.includes('jobs.endSave();'));
	assert.ok(main.includes('const startedAt = jobs.beginDryRun();'));
	assert.ok(main.includes('jobs.recordDryRun(result.ok ? result.value : null, startedAt)'));
});
