// The executable statement of the desktop's boundary: it is a local placeholder only. It scans
// whole files in desktop/src and desktop/renderer, assembles the forbidden tokens by concatenation
// (so this test file states the intent, the way lets-triage-mail's boundaries.test.ts does), and
// fails with the offending files. It never reads docs/, data/ or evals/ — the private paths.

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

// "Never makes a network call": no Node HTTP/TLS/socket/dgram modules, no global fetch, and no
// Electron net/session fetch. Assembled so the list reads as intent, not as a call this file makes.
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
	// Electron and the TypeScript toolchain are the only allowed dependencies.
	const forbidden = ['toml', 'sqlite', 'mysql', 'postgres', 'axios', 'node-fetch', 'got', 'superagent', 'undici', 'http'];
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

test('no source file spawns a process', () => {
	const token = ['child', '_', 'process'].join('');
	const offenders = walk(SRC).filter((f) => readFileSync(f, 'utf8').includes(token));
	assert.deepEqual(offenders, []);
});

test('Cargo.toml excludes desktop/ from the crate', () => {
	const cargo = readFileSync(join(DESKTOP, '..', 'Cargo.toml'), 'utf8');
	assert.match(cargo, /exclude\s*=\s*\[[^\]]*"desktop\/"/);
});

test('nothing in the desktop points at the private data directories', () => {
	const forbidden = ['docs/', 'data/', 'evals/'];
	const hits: string[] = [];
	for (const file of [...walk(SRC), ...walk(RENDERER)]) {
		const text = readFileSync(file, 'utf8');
		for (const word of forbidden) {
			if (text.includes(word)) hits.push(`${file}: ${word}`);
		}
	}
	assert.deepEqual(hits, []);
});

test('index.html is titled, locked down, and free of script and remote URLs', () => {
	const html = readFileSync(join(RENDERER, 'index.html'), 'utf8');
	assert.ok(html.includes('<title>Let\'s RAG Docs</title>'), 'must carry the placeholder title');
	assert.ok(html.includes('default-src \'none\''), 'must deny every fetch by default');
	assert.equal(html.includes('<script'), false, 'no renderer script yet');
	// The app loads only file:// content; no http:// or https:// anywhere in the page.
	assert.equal(/https?:\/\//.test(html), false, 'no remote URL in the page');
});
