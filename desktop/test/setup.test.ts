import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
	MODEL_RUNTIMES,
	OLLAMA_INSTALL_URL,
	buildModelDetectArgs,
	buildModelPullArgs,
	buildModelSaveArgs,
	buildSetupSaveDraft,
	parseModelDetect,
	parsePullLine,
	pullProgress,
	progressBar,
	recommendedModel,
} from '../src/setup.ts';

// The model functions are the same code lets-triage-mail runs; these tests pin that both apps produce the
// same argv and read the same `model detect` / pull JSON, so the two apps cannot drift.

test('recommendedModel sizes the model to the Mac', () => {
	const GB = 1024 ** 3;
	assert.deepEqual(recommendedModel(8 * GB), { model: 'qwen3:4b', sizeGb: 2.5 });
	assert.deepEqual(recommendedModel(12 * GB), { model: 'qwen3:8b', sizeGb: 5.2 });
	assert.deepEqual(recommendedModel(24 * GB), { model: 'qwen3:8b', sizeGb: 5.2 });
	assert.deepEqual(recommendedModel(32 * GB), { model: 'qwen3:14b', sizeGb: 9.3 });
	assert.deepEqual(recommendedModel(64 * GB), { model: 'qwen3:14b', sizeGb: 9.3 });
});

test('model argv builders are a closed set: fixed flags, value flags, `--` before positionals', () => {
	assert.deepEqual(buildModelDetectArgs(), ['detect', '--json']);
	assert.deepEqual(buildModelDetectArgs('http://127.0.0.1:11434'), ['detect', '--json', '--url=http://127.0.0.1:11434']);
	assert.deepEqual(buildModelPullArgs('qwen3:8b'), ['pull', '--json', '--', 'qwen3:8b']);
	assert.deepEqual(buildModelPullArgs('qwen3:8b', 'http://10.0.0.5:11434'), ['pull', '--json', '--url=http://10.0.0.5:11434', '--', 'qwen3:8b']);
	assert.deepEqual(buildModelSaveArgs('ollama', 'http://127.0.0.1:11434', 'qwen3:8b'), ['save', '--json', '--runtime=ollama', '--url=http://127.0.0.1:11434', '--model=qwen3:8b']);
	assert.equal(buildModelSaveArgs('evil', 'http://127.0.0.1:11434', 'qwen3:8b'), null, 'only the engine runtime words');
	assert.equal(buildModelPullArgs('--help'), null, 'a model id can never read as a flag');
	assert.equal(buildModelDetectArgs('imap://x y'), null, 'no spaces in an address');
	assert.equal(buildModelDetectArgs('-x'), null, 'no leading dash');
	assert.deepEqual([...MODEL_RUNTIMES], ['ollama', 'lmstudio', 'custom']);
	assert.equal(OLLAMA_INSTALL_URL, 'https://ollama.com/download', 'the one fixed install page');
});

test('parseModelDetect trims the engine answer to the fields the step reads', () => {
	const good = parseModelDetect({
		ok: true,
		runtimes: [{ runtime: 'ollama', url: 'http://127.0.0.1:11434', reachable: true, models: ['qwen3:8b', 'nomic-embed-text'], usable: ['qwen3:8b'], error: null }],
		shared: { runtime: 'ollama', url: 'http://127.0.0.1:11434', model: 'qwen3:14b', set_by: 'rag docs', reachable: false },
	});
	assert.equal(good.ok, true);
	assert.deepEqual(good.runtimes[0].usable, ['qwen3:8b'], 'the embedding id is listed but not usable');
	assert.equal(good.shared?.setBy, 'rag docs');
	assert.equal(good.shared?.reachable, false, 'a shared block whose server is off is kept as unreachable');
	const refused = parseModelDetect({ ok: false, error: 'no local model server answers' });
	assert.equal(refused.ok, false);
	assert.equal(refused.error, 'no local model server answers');
	assert.deepEqual(refused.runtimes, []);
});

test('parsePullLine reads the engine normalised stages, and pullProgress turns bytes into a GB bar', () => {
	assert.deepEqual(parsePullLine('{"stage":"pulling manifest"}'), { stage: 'pulling manifest', total: 0, completed: 0, text: '' });
	const line = parsePullLine('{"stage":"downloading","total":1073741824,"completed":536870912}');
	assert.deepEqual(line?.stage, 'downloading');
	assert.deepEqual(pullProgress('qwen3:8b', line ?? ({} as never)), { model: 'qwen3:8b', done: 0.5, gb: 1, pct: 50 });
	assert.equal(parsePullLine('{"stage":"error","error":"manifest not found"}')?.text, 'manifest not found');
	assert.equal(parsePullLine('{"stage":"other","status":"verifying sha256"}')?.stage, 'other');
	assert.equal(parsePullLine('not json at all'), null, 'only the engine normalised lines reach here');
	assert.equal(pullProgress('qwen3:8b', { stage: 'success', total: 0, completed: 0, text: '' }), null, 'no bar after the download finished');
});

test('the download bar keeps its maximum at 100 and the fill is the clamped percent, never a partial full', () => {
	assert.deepEqual(progressBar(42), { valuemin: 0, valuemax: 100, valuenow: 42, fill: '42%' });
	assert.equal(progressBar(100).fill, '100%', 'a finished download fills the bar');
	assert.equal(progressBar(0).valuenow, 0, 'a download that has not started is empty');
	assert.equal(progressBar(140).valuenow, 100, 'a value over 100 is clamped');
	assert.equal(progressBar(-5).valuenow, 0, 'a negative value is clamped');
});

test('buildSetupSaveDraft accepts absolute or home-relative paths and refuses the rest (engine is the authority)', () => {
	assert.deepEqual(
		buildSetupSaveDraft('~/Documents/library', ['~/Downloads', '~/Desktop']),
		{ library_dir: '~/Documents/library', watch_folders: ['~/Downloads', '~/Desktop'] },
	);
	assert.deepEqual(buildSetupSaveDraft('/tmp/library', []), { library_dir: '/tmp/library', watch_folders: [] });
	assert.equal(buildSetupSaveDraft('relative/library', []), null, 'a relative library is refused');
	assert.equal(buildSetupSaveDraft('', []), null, 'empty is not a path');
	assert.equal(buildSetupSaveDraft('~/L', ['~/Downloads', '~/Downloads']), null, 'the same folder twice');
	assert.equal(buildSetupSaveDraft('~/L', ['relative']), null, 'a relative watch folder');
	const many = Array.from({ length: 21 }, (_, i) => `~/f${i}`);
	assert.equal(buildSetupSaveDraft('~/L', many), null, 'at most 20 folders, like the engine');
});

test('the pull-error fixture is a stream that ends in the engine\'s own sentence', () => {
	// `model pull` always finishes with either a success line or an error line; the page shows that
	// sentence and offers "try again". The fixture is the byte stream the engine produces.
	const text = readFileSync(join(import.meta.dirname, '..', '..', 'testdata', 'desktop', 'model-pull-error.jsonl'), 'utf8');
	const lines = text.trim().split('\n').map((line) => parsePullLine(line));
	assert.deepEqual(lines.map((line) => line?.stage), ['pulling manifest', 'downloading', 'error']);
	assert.equal(lines[2]?.text, 'manifest not found');
	const bar = pullProgress('qwen3:8b', lines[1] ?? ({} as never));
	assert.equal(bar?.pct, 50, 'the bar advanced before the error');
});
