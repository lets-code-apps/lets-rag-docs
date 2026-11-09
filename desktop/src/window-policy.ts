// Window policy: the small, Electron-free decisions the main process makes about its one window.
// Everything here takes plain values and returns plain values, so the tests run under `node --test`
// with no BrowserWindow and no display — the same move as keeping `chunk`/`config` free of IO in
// the Rust crate. `main.ts` supplies the real Electron window behind these functions.

// The options for the single placeholder window. A locked-down renderer: context isolation on,
// the Chromium sandbox on, Node in the page off, and deliberately no `preload` (there is nothing to
// bridge yet). `main.ts` adds `show` when it builds the real window.
export function windowOptions(): {
	width: number;
	height: number;
	webPreferences: { contextIsolation: true; sandbox: true; nodeIntegration: false };
} {
	return {
		width: 800,
		height: 600,
		webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
	};
}

// Only the app's own local index file is trusted. A `file://` URL is ours only if it points at the
// exact index page we loaded, never at another file on disk.
export function isOwnFile(url: string, indexUrl: string): boolean {
	return url === indexUrl;
}

// The renderer's `will-navigate` handler. The page must never move off its own file: navigating to
// a remote or foreign URL is where a hostile document could sneak in, so we always refuse it.
export function denyNavigation(event: { preventDefault(): void }): void {
	event.preventDefault();
}

// The renderer's `setWindowOpenHandler` result. No link, however clicked, may spawn a second window.
export function windowOpenHandler(): { action: 'deny' } {
	return { action: 'deny' };
}
