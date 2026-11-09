// The whole desktop, so far: one neutral placeholder window opened from a local file that quits
// when its last window closes. No backend, no IPC, no preload and no network: the product direction
// is still open, so this file only proves the shell launches and stays local. The decisions the
// window makes (size, sandbox, which URLs are ours) live in window-policy.ts so they can be unit-tested
// without Electron; this file just supplies the real BrowserWindow behind them.

import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { denyNavigation, isOwnFile, windowOpenHandler, windowOptions } from './window-policy.ts';

// ESM has no __dirname; derive the directory this module lives in once. main.ts compiles to
// dist/main.js, so the renderer sits one level up at desktop/renderer/index.html.
const HERE = import.meta.dirname;
const RENDERER = join(HERE, '..', 'renderer', 'index.html');
const INDEX_URL = pathToFileURL(RENDERER).href;

function makeWindow(show: boolean): BrowserWindow {
	const browser = new BrowserWindow({ ...windowOptions(), show });
	// Hostile input can only ever be document text shown in this page; refuse any attempt to leave
	// our own file or spawn another window.
	browser.webContents.on('will-navigate', (event: { preventDefault(): void }) =>
		denyNavigation(event),
	);
	browser.webContents.setWindowOpenHandler(() => windowOpenHandler());
	browser.loadFile(RENDERER);
	return browser;
}

if (process.env.RAG_DOCS_SMOKE === '1') {
	// Headless proof the shell really boots: a hidden window loads our local file, and Electron
	// reports the title we set. Prints SMOKE OK / SMOKE FAIL and exits 0 / 1. No display needed.
	void app.whenReady().then(() => {
		const browser = makeWindow(false);
		browser.webContents.once('did-finish-load', () => {
			const url = browser.webContents.getURL();
			const title = browser.getTitle();
			if (isOwnFile(url, INDEX_URL) && title === "Let's RAG Docs") {
				console.error(`SMOKE OK: loaded ${url} titled "${title}"`);
				app.exit(0);
			} else {
				console.error(`SMOKE FAIL: url=${url} title=${title}`);
				app.exit(1);
			}
		});
	});
	setTimeout(() => {
		console.error('SMOKE FAIL: timed out after 10s');
		app.exit(1);
	}, 10000);
} else {
	// Normal launch: show the placeholder. Closing the last window quits the app on every platform.
	void app.whenReady().then(() => {
		makeWindow(true);
	});
	app.on('window-all-closed', () => app.quit());
}
