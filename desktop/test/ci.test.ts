// The GitHub Actions workflow for this repo is read as text and checked for the steps the acceptance
// criteria demand. The real proof is a green run on the PR; this test guards the workflow file against
// losing a step, an unsafe trigger (`pull_request_target`) or a secret reference in a public repo.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..', '..');
const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'desktop.yml'), 'utf8');

test('the workflow runs on macOS and triggers on desktop and feature branches', () => {
	assert.ok(workflow.includes('macos-latest'));
	assert.ok(workflow.includes('feature/**'));
	assert.match(workflow, /push:[\s\S]*branches:\s*\[[^\]]*desktop/);
});

test('the Rust job lints and tests the crate', () => {
	for (const cmd of ['cargo fmt --all --check', 'cargo clippy --all-targets -- -D warnings', 'cargo test']) {
		assert.ok(workflow.includes(cmd), `workflow missing ${cmd}`);
	}
});

test('the desktop job installs, checks, smokes, shots and uploads an artifact', () => {
	for (const step of ['npm ci', 'npm run typecheck', 'npm test', 'npm run smoke', 'npm run shots', 'upload-artifact']) {
		assert.ok(workflow.includes(step), `workflow missing ${step}`);
	}
});

test('the baseline is copied before the shots overwrite it', () => {
	assert.ok(workflow.includes('cp -R screenshots'));
	assert.ok(workflow.indexOf('cp -R screenshots') < workflow.indexOf('npm run shots'));
});

test('the workflow requires all 64 shots (44 screens plus the 20 first-run steps)', () => {
	assert.ok(workflow.includes("grep -q '^SHOTS OK: 64'"), 'the shot count guard must be 64');
	assert.equal(workflow.includes("'^SHOTS OK: 44'"), false, 'the old 44-shot guard is stale');
});

test('the artifact upload uses path (not the invalid files key) and the comment step has a token + run link', () => {
	// upload-artifact@v4 reads `path:`; `files:` is not an input and made the upload fail silently.
	assert.ok(workflow.includes('path:'), 'upload-artifact must use path:');
	assert.equal(/^\s*files:/m.test(workflow), false, 'upload-artifact must not use files:');
	// gh pr comment needs a token (the job has pull-requests:write) and the report must link the run.
	assert.ok(workflow.includes('GH_TOKEN'), 'the gh comment step must set GH_TOKEN');
	assert.ok(workflow.includes('pull-requests: write'), 'the desktop job needs pull-requests: write');
	assert.ok(workflow.includes('DESKTOP_CI_URL'), 'the compare step must link the run in the report');
	// Threshold calibration needs the measured ratio of every shot, not just the problems, so a green run
	// still leaves numbers behind.
	assert.ok(workflow.includes('compare-measured.json'), 'the upload must carry the measured per-shot ratios');
	assert.ok(readFileSync(join(ROOT, 'desktop', 'scripts', 'compare-shots.mjs'), 'utf8').includes('compare-measured.json'));
});

test('no pull_request_target and no secrets in a public-repo workflow', () => {
	assert.equal(workflow.includes('pull_request_target'), false);
	assert.equal(workflow.includes('secrets.'), false);
});

test('the desktop README explains how to update the baseline', () => {
	const readme = readFileSync(join(ROOT, 'desktop', 'README.md'), 'utf8');
	assert.ok(readme.includes('CI and the screenshot baseline'));
});
