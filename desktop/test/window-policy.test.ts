import assert from 'node:assert/strict';
import { test } from 'node:test';

import { denyNavigation, isOwnFile, windowOpenHandler, windowOptions } from '../src/window-policy.ts';

test('windowOptions locks the renderer down and sets a preload', () => {
	const options = windowOptions();
	assert.equal(options.width, 720);
	assert.equal(options.height, 480);
	assert.equal(options.minWidth, 360);
	assert.equal(options.webPreferences.contextIsolation, true);
	assert.equal(options.webPreferences.sandbox, true);
	assert.equal(options.webPreferences.nodeIntegration, false);
	assert.equal(options.webPreferences.preload, 'preload.cjs');
});

test('isOwnFile accepts only the app\'s own index file', () => {
	const own = 'file:///app/renderer/index.html';
	assert.equal(isOwnFile(own, own), true);
	assert.equal(isOwnFile('https://example.com', own), false);
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