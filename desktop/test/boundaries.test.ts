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
	for (const name of ['ask', 'cancelAsk', 'documents', 'filingShow', 'filingSave', 'dryRun', 'resort']) {
		assert.ok(ipc.includes(`'rag.${name}'`), `ipc.ts missing ${name}`);
	}
	for (const fn of ['ask', 'cancelAsk', 'documents', 'filing', 'saveFiling', 'dryRun', 'resort']) {
		assert.ok(preload.includes(`${fn}:`), `preload missing ${fn}`);
	}
});

test('every IPC handler checks senderFrame', () => {
	const main = readFileSync(join(SRC, 'main.ts'), 'utf8');
	const handles = main.split('ipcMain.handle(').slice(1);
	assert.equal(handles.length, 7, 'all declared channels need handlers');
	for (const block of handles) {
		assert.ok(block.includes('fromUs(event.senderFrame)'), 'handlers must reject foreign senders');
	}
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
	assert.ok(main.includes('setTemplateImage'));
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