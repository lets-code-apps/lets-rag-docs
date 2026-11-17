import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveEngine } from '../src/engine-path.ts';

test('RAG_DOCS_ENGINE_PATH wins', () => {
	const path = resolveEngine({ RAG_DOCS_ENGINE_PATH: '/tmp/fake', RAG_DOCS_CONFIG: '/tmp/config.toml' }, undefined, '/repo');
	assert.equal(path.file, '/tmp/fake');
	assert.deepEqual(path.baseArgs, ['--config', '/tmp/config.toml']);
});

test('no engine lookup invents a path', () => {
	assert.throws(() => resolveEngine({ HOME: undefined }, undefined, '/definitely-not-a-repo'), /no lets-rag-docs engine found/);
});

test('--config only appears when the user set RAG_DOCS_CONFIG', () => {
	const path = resolveEngine({ RAG_DOCS_ENGINE_PATH: '/tmp/fake' }, undefined, '/repo');
	assert.deepEqual(path.baseArgs, []);
});