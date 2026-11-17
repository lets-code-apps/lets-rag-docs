// Window policy: the Electron-free decisions the main process makes about its one window.
// `main.ts` turns the preload name into an absolute path when it builds the real BrowserWindow.

export function windowOptions(): {
	width: number;
	height: number;
	minWidth: number;
	minHeight: number;
	titleBarStyle: 'hiddenInset';
	trafficLightPosition: { x: number; y: number };
	webPreferences: {
		preload: string;
		contextIsolation: true;
		sandbox: true;
		nodeIntegration: false;
	};
} {
	return {
		// The design's window: wide enough for nav | list | detail; at 360px the panes stack.
		width: 1200,
		height: 820,
		minWidth: 360,
		minHeight: 480,
		// The AppBar is the title bar: its left inset leaves room for the window buttons.
		titleBarStyle: 'hiddenInset',
		trafficLightPosition: { x: 20, y: 22 },
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