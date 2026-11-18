// The two settings this app owns. `appearance` is ours: one small JSON file in the app's own
// data folder. `openAtLogin` is the operating system's (the macOS login item), so it is read live
// and never written to our file. A pure module: the parse, the allow-list and the controller can be
// tested with plain `node --test`, with no Electron and no real login item. File IO and the OS
// login item reach the controller through a `host` object, exactly where a Rust struct would take a
// trait object — so the tests pass a fake.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { SettingsPayload } from './ipc.ts';

export const APPEARANCES = ['system', 'dark', 'light'] as const;
export type Appearance = (typeof APPEARANCES)[number];
export type Settings = { appearance: Appearance };

export const DEFAULT_SETTINGS: Settings = { appearance: 'system' };

// The allow-list for the segmented control: an appearance is one of these three, nothing else.
export const isAppearance = (value: unknown): value is Appearance =>
	APPEARANCES.includes(value as Appearance);

// A missing, corrupt or unknown file is the defaults, never an error.
export function parseSettings(text: string): Settings {
	try {
		const parsed = JSON.parse(text) as { appearance?: unknown } | null;
		if (isAppearance(parsed?.appearance)) return { appearance: parsed.appearance };
	} catch {
		// fall through to the defaults
	}
	return DEFAULT_SETTINGS;
}

// What `setSetting` may do: a known name with a value of the right type, nothing else.
export const isAllowedSetting = (name: unknown, value: unknown): boolean =>
	(name === 'appearance' && isAppearance(value)) || (name === 'openAtLogin' && typeof value === 'boolean');

export function loadSettings(file: string): Settings {
	// Missing or unreadable file: the defaults. Never throws.
	return parseSettings(readFileSyncSafe(file));
}

// Reads a file as text, or the empty string (which parses to the defaults) if it cannot be read.
function readFileSyncSafe(file: string): string {
	try {
		return readFileSync(file, 'utf8');
	} catch {
		// no file yet, or not readable this time
	}
	return '';
}

export function saveSettings(file: string, settings: Settings): boolean {
	// Returns false on failure and never throws; a failed write still leaves the theme applied.
	try {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify(settings));
		return true;
	} catch {
		return false;
	}
}

// The controller's only handle on the outside world: who applies the theme and who owns the login
// item. The real Electron host sets `nativeTheme` and the macOS login item; a test host records
// calls and keeps an in-memory boolean, so smoke/shots and unit tests never touch the real OS state.
export type SettingsHost = {
	setTheme: (appearance: Appearance) => void;
	getOpenAtLogin: () => boolean;
	setOpenAtLogin: (value: boolean) => void;
};

export class SettingsController {
	private file: string;
	private host: SettingsHost;
	private settings: Settings = DEFAULT_SETTINGS;

	constructor(file: string, host: SettingsHost) {
		this.file = file;
		this.host = host;
	}

	// Called once at launch: read the file and make the OS follow the remembered appearance.
	load(): void {
		this.settings = loadSettings(this.file);
		this.host.setTheme(this.settings.appearance);
	}

	// The renderer reads the truth every time: the stored appearance plus the OS's real login-item
	// state, so the switch shows what macOS has, not what the page last asked for.
	payload(): SettingsPayload {
		return { appearance: this.settings.appearance, openAtLogin: this.host.getOpenAtLogin() };
	}

	// `setSetting` at the trust boundary. Unknown name or wrong value type: `null`, nothing changes.
	set(name: unknown, value: unknown): SettingsPayload | null {
		if (!isAllowedSetting(name, value)) return null;
		if (name === 'appearance') {
			this.settings = { appearance: value as Appearance };
			this.host.setTheme(value as Appearance);
			// Persist if we can; the choice applies for this run either way.
			saveSettings(this.file, this.settings);
		} else {
			// `openAtLogin` belongs to the OS, so it is set there and not written to our file.
			this.host.setOpenAtLogin(value as boolean);
		}
		return this.payload();
	}
}
