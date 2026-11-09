// Unit tests for window-policy.ts. No Electron, no display: these functions take plain values and
// return plain values, so `node --test` runs them directly (the same "test the pure logic, fake the
// IO" idea used throughout the Rust crate).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { denyNavigation, isOwnFile, windowOpenHandler, windowOptions } from '../src/window-policy.ts';

test('windowOptions locks the renderer down and sets no preload', () => {
	const options = windowOptions();
	assert.equal(options.width, 800);
	assert.equal(options.height, 600);
	assert.equal(options.webPreferences.contextIsolation, true);
	assert.equal(options.webPreferences.sandbox, true);
	assert.equal(options.webPreferences.nodeIntegration, false);
	// Nothing to bridge yet: a preload is the seam that would expose Node to the page.
	assert.equal('preload' in options.webPreferences, false);
});

test('isOwnFile accepts only the app\'s own index file', () => {
	const own = 'file:///app/renderer/index.html';
	assert.equal(isOwnFile(own, own), true);
	// A remote page is never ours.
	assert.equal(isOwnFile('https://example.com', own), false);
	// Neither is a different local file that could read another document.
	assert.equal(isOwnFile('file:///etc/passwd', own), false);
});

test('denyNavigation refuses the navigation', () => {
	let prevented = false;
	denyNavigation({ preventDefault: () => (prevented = true) });
	assert.equal(prevented, true);
});

test('windowOpenHandler denies any new window', () => {
	assert.deepEqual(windowOpenHandler(), { action: 'deny' });
});
