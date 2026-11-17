// Window policy: the Electron-free decisions the main process makes about its one window.
// `main.ts` turns the preload name into an absolute path when it builds the real BrowserWindow.

export function windowOptions(): {
	width: number;
	height: number;
	minWidth: number;
	webPreferences: {
		preload: string;
		contextIsolation: true;
		sandbox: true;
		nodeIntegration: false;
	};
} {
	return {
		width: 720,
		height: 480,
		minWidth: 360,
		webPreferences: {
			preload: 'preload.cjs',
			contextIsolation: true,
			sandbox: true,
			nodeIntegration: false,
		},
	};
}

export function isOwnFile(url: string, indexUrl: string): boolean {
	return url === indexUrl;
}

export function denyNavigation(event: { preventDefault(): void }): void {
	event.preventDefault();
}

export function windowOpenHandler(): { action: 'deny' } {
	return { action: 'deny' };
}