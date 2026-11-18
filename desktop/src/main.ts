// The RAG Docs desktop: a tray app that shells one-shot to the Rust engine and renders its
// JSON reports. Main owns argv and process spawning; the renderer sends only data. Closing the
// window hides it; Quit/Cmd+Q ends the app. Smoke and screenshots drive the real page against the
// fake engine (pinned by the npm scripts), never real documents or config.

import { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, nativeTheme, shell } from 'electron';
import { basename, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { defaultSpawn, Engine, type EngineResult } from './engine.ts';
import { Jobs } from './jobs.ts';
import { IPC } from './ipc.ts';
import { buildTrayMenu, PRODUCT_NAME } from './menu.ts';
import { WindowController } from './window.ts';
import { denyNavigation, isOwnFile, windowOpenHandler, windowOptions } from './window-policy.ts';
import { SettingsController, type SettingsHost } from './settings.ts';
import { GEOMETRY } from './geometry.ts';

const HERE = import.meta.dirname;
const RENDERER = join(HERE, '..', 'renderer', 'index.html');
const INDEX_URL = pathToFileURL(RENDERER).href;
const PRELOAD = join(HERE, 'preload.cjs');
// The design's menu-bar template: black on transparent, 18px with an @2x beside it. The
// `Template` suffix plus `setTemplateImage(true)` on the image lets macOS tint it for a light or
// dark menu bar. `setTemplateImage` is a NativeImage method, so the Tray gets the prepared image.
const TRAY_ICON = join(HERE, '..', 'assets', 'menubarTemplate.png');
const APP_ICON = join(HERE, '..', 'assets', 'icon.png');

const engine = new Engine(process.env, join(HERE, '..', '..'), defaultSpawn);
const jobs = new Jobs();

let quitInFlight = false;
const ctl = new WindowController(() => makeWindow(), {
	hide: () => app.dock?.hide(),
	show: () => void app.dock?.show(),
});
let tray: Tray | undefined;

// The app's appearance + open-at-login owner. Built once in boot: the real host reads/writes the
// macOS login item and the app's own settings.json under userData; smoke and shots use a temp file
// and an in-memory login item (so `npm run smoke` never registers a login item on the user's Mac).
let settingsController: SettingsController;
let settingsFile = '';
let settingsTempDir: string | undefined;
let memoryLoginItem: { openAtLogin: boolean } | undefined;

const fromUs = (senderFrame?: { url?: string } | null): boolean => senderFrame?.url === INDEX_URL;

// The two OS seams, built once in boot like the settings host:
// - `opener` resolves nothing; it opens only what main already resolved. Exactly one
//   this file). Smoke/shots record the path to `openLog` instead of launching a viewer.
// - `picker` is the real file dialog; smoke/shots hand back synthetic temp files, so no real folder
//   is ever listed. Picked paths live in main's queue only: the page gets counts and names.
type OpenerHost = (path: string) => Promise<string>; // the OS host: '' means opened
type PickerHost = () => Promise<string[]>;
let opener: OpenerHost;
let picker: PickerHost;
const openLog: string[] = [];
let addQueue: string[] = [];
let addTotal = 0;
let pickedTempDir: string | undefined;

function clearAddQueue(): void {
	addQueue = [];
	addTotal = 0;
}

function isRendererNavigation(url: string): boolean {
	try {
		const target = new URL(url);
		const own = new URL(INDEX_URL);
		return target.protocol === own.protocol && target.hostname === own.hostname && target.pathname === own.pathname;
	} catch {
		return false;
	}
}

function toIPC<T>(result: EngineResult<T>): { ok: boolean; report?: T; error?: string } {
	return result.ok ? { ok: true, report: result.value } : { ok: false, error: result.error };
}

/** A thrown error (no engine binary, spawn failure) becomes a result the page can show. */
async function guard<T>(work: () => Promise<T>): Promise<T | { ok: false; error: string }> {
	try {
		return await work();
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, error: message.split('\n')[0] ?? 'the engine could not be started' };
	}
}

function makeWindow(): BrowserWindow {
	const options = windowOptions();
	const browser = new BrowserWindow({
		width: options.width,
		height: options.height,
		minWidth: options.minWidth,
		minHeight: options.minHeight,
		titleBarStyle: options.titleBarStyle,
		trafficLightPosition: options.trafficLightPosition,
		title: PRODUCT_NAME,
		show: false,
		webPreferences: {
			...options.webPreferences,
			preload: PRELOAD,
		},
	});
	browser.webContents.on('will-navigate', (event: { preventDefault(): void }, url: string) => {
		if (!isRendererNavigation(url)) denyNavigation(event);
	});
	browser.webContents.setWindowOpenHandler(() => windowOpenHandler());
	browser.on('close', (event) => ctl.handleClose(event));
	void browser.loadFile(RENDERER);
	return browser;
}

function makeTray(): Tray {
	const image = nativeImage.createFromPath(TRAY_ICON);
	image.setTemplateImage(true);
	const t = new Tray(image);
	t.setToolTip(PRODUCT_NAME);
	t.on('click', () => ctl.open());
	t.on('right-click', () => t.popUpContextMenu(trayMenu()));
	return t;
}

function trayMenu(): Menu {
	const template = buildTrayMenu().map((item) => {
		const built: { label: string; enabled: boolean; click?: () => void; accelerator?: string } = {
			label: item.label,
			enabled: item.enabled,
		};
		const action = item.action;
		if (action) built.click = () => runAction(action);
		if (item.accelerator) built.accelerator = item.accelerator;
		return built;
	});
	return Menu.buildFromTemplate(template);
}

function runAction(action: 'openWindow' | 'quit'): void {
	if (action === 'openWindow') ctl.open();
	else if (action === 'quit') app.quit();
}

function makeSettingsController(): SettingsController {
	// One factory picks the host. Under smoke/shots it never touches the real userData folder or the
	// real login item; `setTheme` still drives the real nativeTheme so "appearance is live" is real.
	const testing = process.env.RAG_DOCS_SMOKE === '1' || process.env.RAG_DOCS_SHOTS === '1';
	if (testing) {
		settingsTempDir = mkdtempSync(join(tmpdir(), 'rag-docs-settings-'));
		settingsFile = join(settingsTempDir, 'settings.json');
		memoryLoginItem = { openAtLogin: false };
		const host: SettingsHost = {
			setTheme: (appearance) => {
				nativeTheme.themeSource = appearance;
			},
			getOpenAtLogin: () => memoryLoginItem?.openAtLogin ?? false,
			setOpenAtLogin: (value) => {
				if (memoryLoginItem) memoryLoginItem.openAtLogin = value;
			},
		};
		return new SettingsController(settingsFile, host);
	}
	settingsFile = join(app.getPath('userData'), 'settings.json');
	const host: SettingsHost = {
		setTheme: (appearance) => {
			nativeTheme.themeSource = appearance;
		},
		getOpenAtLogin: () => app.getLoginItemSettings().openAtLogin,
		setOpenAtLogin: (value) => {
			app.setLoginItemSettings({ openAtLogin: value });
		},
	};
	return new SettingsController(settingsFile, host);
}

function makeHosts(): void {
	// Same seam pattern as the settings host: one decision, testing or not, made in boot.
	const testing = process.env.RAG_DOCS_SMOKE === '1' || process.env.RAG_DOCS_SHOTS === '1';
	if (testing) {
		// Synthetic temp files only: the fake engine decides by name (`dup` -> duplicate,
		// `broken` -> failed), and the opener records instead of launching a viewer.
		const dir = mkdtempSync(join(tmpdir(), 'rag-docs-picked-'));
		pickedTempDir = dir;
		const names = ['loan.pdf', 'loan-dup.pdf', 'broken.pdf'];
		for (const name of names) writeFileSync(join(dir, name), 'synthetic');
		picker = async () => names.map((name) => join(dir, name));
		opener = async (path) => {
			void path;
			return '';
		};
		return;
	}
	opener = (path) => shell.openPath(path);
	picker = async () => {
		const picked = await dialog.showOpenDialog({
			title: PRODUCT_NAME,
			buttonLabel: 'Add',
			properties: ['openFile', 'multiSelections'],
			filters: [{ name: 'Documents', extensions: ['pdf', 'jpg', 'jpeg', 'png', 'heic', 'tif', 'tiff'] }],
		});
		return picked.canceled ? [] : picked.filePaths;
	};
}

function registerIpc(): void {
	ipcMain.handle(IPC.documents, async (event) => {
		if (!fromUs(event.senderFrame)) return null;
		return guard(async () => toIPC(await engine.documents()));
	});

	ipcMain.handle(IPC.filingShow, async (event) => {
		if (!fromUs(event.senderFrame)) return null;
		return guard(async () => toIPC(await engine.filingShow()));
	});

	ipcMain.handle(IPC.filingSave, async (event, draft: unknown, check: boolean) => {
		if (!fromUs(event.senderFrame)) return null;
		return guard(async () => {
			if (check) return toIPC(await engine.filingSave(draft, true));
			jobs.beginSave();
			try {
				return toIPC(await engine.filingSave(draft, false));
			} finally {
				jobs.endSave();
			}
		});
	});

	ipcMain.handle(IPC.dryRun, async (event) => {
		if (!fromUs(event.senderFrame)) return null;
		return guard(async () => {
			const startedAt = jobs.beginDryRun();
			const result = await engine.dryRun();
			// A save that began meanwhile made this preview stale: never show or arm it.
			if (!jobs.recordDryRun(result.ok ? result.value : null, startedAt)) {
				return { ok: false, stale: true, error: 'the lists changed while re-sorting; re-sort again' };
			}
			return toIPC(result);
		});
	});

	// The only way to apply: no arguments, and only after a successful dry-run the user has seen.
	ipcMain.handle(IPC.resort, async (event) => {
		if (!fromUs(event.senderFrame)) return null;
		if (!jobs.tryBeginApply()) return { ok: false, error: jobs.applyReason() ?? 'not ready' };
		try {
			return await guard(async () => toIPC(await engine.apply()));
		} finally {
			jobs.endApply();
		}
	});

	ipcMain.handle(IPC.ask, async (event, question: unknown) => {
		if (!fromUs(event.senderFrame)) return null;
		if (typeof question !== 'string') return { ok: false, error: 'question must be a string' };
		if (!jobs.tryBeginAsk()) return { ok: false, error: 'busy' };
		try {
			return await guard(async () => toIPC(await engine.ask(question)));
		} finally {
			jobs.endAsk();
		}
	});

	ipcMain.handle(IPC.cancelAsk, async (event) => {
		if (!fromUs(event.senderFrame)) return null;
		return { ok: true, cancelled: engine.cancelAsk() };
	});

	// Search is a read like documents: no job gate, query after `--`.
	ipcMain.handle(IPC.search, async (event, query: unknown) => {
		if (!fromUs(event.senderFrame)) return null;
		if (typeof query !== 'string') return { ok: false, error: 'query must be a string' };
		return guard(async () => toIPC(await engine.search(query)));
	});

	// The file picker runs where it must: in main. Only counts and display names cross to the page.
	ipcMain.handle(IPC.pickFiles, async (event) => {
		if (!fromUs(event.senderFrame)) return null;
		return guard(async () => {
			const paths = await picker();
			if (paths.length === 0) return { ok: true, count: 0, names: [] };
			addQueue = paths.slice();
			addTotal = paths.length;
			const names = paths.map((path) => basename(path));
			return { ok: true, count: paths.length, names };
		});
	});

	// One add per call, straight off main's queue. `done` tells the page the queue is empty;
	// `outcome` is the row's word (added / duplicate / failed).
	ipcMain.handle(IPC.addNext, async (event) => {
		if (!fromUs(event.senderFrame)) return null;
		return guard(async () => {
			if (addQueue.length === 0) return { ok: false, error: 'no files were picked' };
			const reason = jobs.addReason();
			if (reason !== null) return { ok: false, error: reason };
			if (!jobs.tryBeginAdd()) return { ok: false, error: 'another long job is running' };
			const path = addQueue.shift() as string;
			const index = addTotal - addQueue.length;
			const name = basename(path);
			const done = addQueue.length === 0;
			try {
				const result = await engine.add(path);
				if (!result.ok) {
					return { ok: true, done, index, total: addTotal, name, outcome: 'failed', error: result.error };
				}
				const outcome = result.value.status === 'duplicate' ? 'duplicate' : 'added';
				return { ok: true, done, index, total: addTotal, name, outcome, report: result.value };
			} catch {
				// A spawn failure counts as a failed row and still advances the queue.
				return { ok: true, done, index, total: addTotal, name, outcome: 'failed' };
			} finally {
				jobs.endAdd();
			}
		});
	});

	ipcMain.handle(IPC.cancelAdd, async (event) => {
		if (!fromUs(event.senderFrame)) return null;
		const cancelled = engine.cancelAdd() || addQueue.length > 0;
		clearAddQueue();
		return { ok: true, cancelled };
	});

	// Open is the only path that reaches the OS: the renderer names a document it already shows,
	// main resolves it through the engine (never trusts the renderer's string as a file), and only
	// then hands the path to the host opener.
	ipcMain.handle(IPC.openDocument, async (event, docPath: unknown) => {
		if (!fromUs(event.senderFrame)) return null;
		return guard(async () => {
			if (typeof docPath !== 'string') return { ok: false, error: 'path must be a string' };
			const located = await engine.locate(docPath);
			if (!located.ok) return { ok: false, error: located.error };
			const file = located.value.path;
			if (located.value.status !== 'ok' || typeof file !== 'string' || !isAbsolute(file)) {
				return { ok: false, error: 'this document is not in the library' };
			}
			const failure = await opener(file);
			openLog.push(file);
			return failure === '' ? { ok: true, opened: true } : { ok: false, error: failure };
		});
	});

	// Settings cross the same trust boundary: our own page only. `settings` reports the current truth;
	// `setSetting` validates name+value through the controller and answers with the new truth.
	ipcMain.handle(IPC.settings, async (event) => {
		if (!fromUs(event.senderFrame)) return null;
		return settingsController.payload();
	});

	ipcMain.handle(IPC.setSetting, async (event, name: unknown, value: unknown) => {
		if (!fromUs(event.senderFrame)) return null;
		return settingsController.set(name, value);
	});
}

app.on('before-quit', (event) => {
	ctl.beginQuitting();
	if (quitInFlight) return;
	quitInFlight = true;
	event.preventDefault();
	app.quit();
});

if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	// The committed screenshot baseline is Retina (2400x1640, scale 2). A CI or plain display is often
	// scale 1, which would render every shot at 1200x820 and read as "all 38 changed". Force a scale
	// factor of 2 only while taking shots, so the baseline is the same size on a Retina Mac, a non-Retina
	// Mac and the runner. Normal runs and smoke are untouched.
	if (process.env.RAG_DOCS_SHOTS === '1') app.commandLine.appendSwitch('force-device-scale-factor', '2');
	app.on('second-instance', () => ctl.open());
	void app.whenReady().then(boot);
}

function boot(): void {
	settingsController = makeSettingsController();
	settingsController.load();
	makeHosts();
	registerIpc();
	if (process.env.RAG_DOCS_SMOKE === '1') {
		void runSmoke();
		return;
	}
	if (process.env.RAG_DOCS_SHOTS === '1') {
		void runShots();
		return;
	}
	tray = makeTray();
	app.setAboutPanelOptions({ applicationName: PRODUCT_NAME, applicationVersion: app.getVersion(), version: '' });
	if (!app.isPackaged) app.dock?.setIcon(APP_ICON);
	app.dock?.hide();
	app.on('window-all-closed', () => ctl.handleWindowAllClosed());
	// Normal launch stays tray-resident; `npm start` opens the window right away.
	if (process.env.RAG_DOCS_START_WINDOW === '1') ctl.open();
}

// ---- smoke and screenshots: the real page, driven like a user, against the fake engine ----

/** Page-side helpers: wait until no engine call is in flight, click, type. */
const DRIVER = String.raw`
window.__drive = {
  async settle() {
    const quiet = () => document.body.dataset.pending === '0';
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setTimeout(r, 50));
      if (quiet()) {
        await new Promise((r) => setTimeout(r, 400));
        if (quiet()) return;
      }
    }
    throw new Error('page never settled');
  },
  find(selector) {
    const node = document.querySelector(selector);
    if (!node) throw new Error('missing ' + selector);
    return node;
  },
  row(list, title) {
    const node = [...document.querySelectorAll(list + ' .row')].find((r) => r.querySelector('.row-title')?.textContent === title);
    if (!node) throw new Error('missing row ' + title);
    return node;
  },
  async click(selector) { this.find(selector).click(); await this.settle(); },
  async pick(title) { this.row('#filingRows', title).click(); await this.settle(); },
  async type(selector, text) {
    const input = this.find(selector);
    input.focus();
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await this.settle();
  },
};
`;

async function drive(browser: BrowserWindow, steps: string): Promise<unknown> {
	return browser.webContents.executeJavaScript(`(async () => { ${DRIVER}; const d = window.__drive; await d.settle(); ${steps} })()`, true);
}

/** Like drive, without the settle first: for checks on a page that is still busy on purpose. */
async function driveNow(browser: BrowserWindow, steps: string): Promise<unknown> {
	return browser.webContents.executeJavaScript(`(async () => { ${DRIVER}; const d = window.__drive; ${steps} })()`, true);
}

function freshFakeState(): string {
	const dir = mkdtempSync(join(tmpdir(), 'rag-docs-fake-'));
	process.env.FAKE_STATE_FILE = join(dir, 'state.json');
	return dir;
}

async function loaded(browser: BrowserWindow): Promise<void> {
	await new Promise<void>((resolve) => browser.webContents.once('did-finish-load', () => resolve()));
}

/** Run the page-side GEOMETRY rules on every screen at both widths; the add panel is shown on ask so
 * rule 2 also checks the panel cannot push the search field down. Returns the combined failures. */
async function measureGeometry(browser: BrowserWindow): Promise<string[]> {
	const failures: string[] = [];
	for (const width of [1200, 360]) {
		browser.setSize(width, width < 480 ? 780 : 820);
		const reload = loaded(browser);
		browser.reload();
		await reload;
		for (const section of ['ask', 'filing', 'settings']) {
			await drive(browser, `await d.click('[data-section="${section}"]');`);
			// Rule 2 wants the search field measured with the add panel visible: run one add, at the wide
			// size only, so the check costs one run and stays off the reload/queue race at 360px.
			if (section === 'ask' && width === 1200) await drive(browser, `await d.click('#addDocsButton');`);
			const geo = (await drive(browser, GEOMETRY)) as { ok: boolean; failures: string[] };
			failures.push(...geo.failures);
		}
	}
	return failures;
}

type SmokeChecks = {
	libraryRows: number;
	answered: boolean;
	folderRows: number;
	notice: boolean;
	moves: number;
	filed: string;
	dangerPill: boolean;
	sizeShown: boolean;
	searchRows: number;
	searchMeta: boolean;
	cleared: number;
	addDone: boolean;
	addAdded: boolean;
	addDuplicate: boolean;
	addFailed: boolean;
	grew: boolean;
	pageCited: boolean;
	openButtons: number;
	vehiclesCounts: boolean;
	movesToVehicles: boolean;
	noUnsorted: boolean;
	movesToHousehold: boolean;
	sharedShownHousehold: boolean;
	sharedRenamedBack: boolean;
	applied: string;
	persisted?: boolean;
	raceSafe?: boolean;
	titleWide?: boolean;
	titleNarrow?: boolean;
	appearanceLive?: boolean;
	openAtLoginOk?: boolean;
	openedPath?: boolean;
	geometry?: string[];
};

async function runSmoke(): Promise<void> {
	const dir = freshFakeState();
	const deadline = setTimeout(() => {
		console.error('SMOKE FAIL: timed out after 60s');
		app.exit(1);
	}, 60000);
	let code = 1;
	try {
		const browser = makeWindow();
		await loaded(browser);
		const result = (await drive(browser, String.raw`
      // Sizes and the over-50 MB pill come straight from the report; the big original is listed
      // with its size and the reason it was never indexed.
      const big = d.row('#libraryRows', 'big-scan.pdf');
      const dangerPill = big.querySelector('.pill')?.textContent === 'not indexed: over 50 MB';
      const sizeShown = (big.querySelector('.row-preview')?.textContent ?? '').includes('64 MB');
      const libraryRows = document.querySelectorAll('#libraryRows .row').length;
      // Search narrows to the two loan documents, then an empty box restores the full list.
      await d.type('#librarySearch', 'loan');
      const searchRows = document.querySelectorAll('#libraryRows .row').length;
      const searchMeta = / of \d+ documents/.test(d.find('#libraryMeta').textContent);
      await d.type('#librarySearch', '');
      const cleared = document.querySelectorAll('#libraryRows .row').length;
      // Add: the picker seam hands over three synthetic files; one row per file, one outcome each.
      await d.click('#addDocsButton');
      const addDone = d.find('#addMeta').textContent === 'done';
      const addOutcomes = [...document.querySelectorAll('#addRows .row-preview')].map((n) => n.textContent);
      const addAdded = addOutcomes.some((x) => x.startsWith('added ('));
      const addDuplicate = addOutcomes.includes('already added');
      const addFailed = addOutcomes.some((x) => x.startsWith('failed:'));
      const grew = document.querySelectorAll('#libraryRows .row').length === libraryRows + 1;
      // Ask: the answer cites with a page, and an open button hands the library path to main.
      await d.type('#askInput', 'When is the car loan paid off?');
      await d.click('#askButton');
      const answered = !d.find('#answerBlock').hidden && d.find('#citations').children.length > 0;
      const pageCited = [...d.find('#citations').children].some((c) => /, p\. 4/.test(c.textContent));
      const openButtons = d.find('#openDocs').children.length;
      d.find('#openDocs').firstChild.click();
      await d.settle();
      // Filing: rename Car to Vehicles. After the save the row already counts its documents,
      // and the preview moves the copies to Vehicles (nothing to unsorted).
      await d.click('[data-section="filing"]');
      const folderRows = document.querySelectorAll('#filingRows .row').length;
      await d.pick('Car');
      await d.type('#nameInput', 'Vehicles');
      await d.click('#saveButton');
      const notice = !d.find('#noticeCard').hidden;
      const vehiclesCounts = d.row('#filingRows', 'Vehicles').querySelector('.row-time')?.textContent === '2 documents';
      await d.click('#resortButton');
      const moves = document.querySelectorAll('#moveRows .row').length;
      const movesToVehicles = [...document.querySelectorAll('#moveRows .row-subject')].some((n) => n.textContent.includes('Vehicles'));
      const noUnsorted = ![...document.querySelectorAll('#moveRows .row-subject')].some((n) => n.textContent.includes('unsorted'));
      await d.click('#applyButton');
      const filed = d.find('#noticePill').textContent;
      // Shared owner: editable now; "Household" moves unlisted documents in the next preview.
      await d.click('[data-view="owners"]');
      await d.pick('Shared');
      await d.type('#nameInput', 'Household');
      await d.click('#saveButton');
      await d.click('#resortButton');
      const movesToHousehold = [...document.querySelectorAll('#moveRows .row-subject')].some((n) => n.textContent.includes('Household'));
      // The row itself shows the new name right away (the save report carries it), and the
      // rename works both ways in one session: Household -> Shared.
      const sharedRowNamed = (title) => [...document.querySelectorAll('#filingRows .row')]
        .some((r) => (r.querySelector('.row-title') ?? {}).textContent === title);
      const sharedShownHousehold = sharedRowNamed('Household');
      await d.pick('Household');
      await d.type('#nameInput', 'Shared');
      await d.click('#saveButton');
      const sharedRenamedBack = sharedRowNamed('Shared') && !sharedRowNamed('Household');
      await d.click('#resortButton');
      await d.click('#applyButton');
      const applied = d.find('#noticePill').textContent;
      return { libraryRows, answered, folderRows, notice, moves, filed, dangerPill, sizeShown, searchRows, searchMeta, cleared, addDone, addAdded, addDuplicate, addFailed, grew, pageCited, openButtons, vehiclesCounts, movesToVehicles, noUnsorted, movesToHousehold, sharedShownHousehold, sharedRenamedBack, applied };
    `		)) as SmokeChecks;
		// The open button ran in main: it resolved through the engine's locate and recorded the
		// fake filed copy — the renderer never named a path.
		result.openedPath = openLog[openLog.length - 1] === '/tmp/rag-docs-fake/library/Finance/Alex Example/2025/2025-03-14 Car loan - Repayment schedule.pdf';
		// Edit -> save -> reload: the saved list comes back from the engine, not from page memory.
		const reload = loaded(browser);
		browser.reload();
		await reload;
		result.persisted = (await drive(browser, String.raw`
      await d.click('[data-section="filing"]');
      const titles = [...document.querySelectorAll('#filingRows .row-title')].map((n) => n.textContent);
      return titles.includes('Vehicles') && !titles.includes('Car');
    `)) as boolean;
		// Race: save new lists while a slow dry-run of the old ones runs. Its preview must not show,
		// and main must refuse apply.
		process.env.FAKE_DRY_RUN_DELAY_MS = '1500';
		result.raceSafe = (await drive(browser, String.raw`
      await d.pick('Finance');
      await d.type('#nameInput', 'Money');
      await d.click('#saveButton');
      d.find('#resortButton').click();
      await new Promise((r) => setTimeout(r, 300));
      d.row('#filingRows', 'Home').click();
      const input = d.find('#nameInput');
      input.value = 'House';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      d.find('#nameForm').requestSubmit();
      await d.settle();
      const forced = await window.ragDocs.resort();
      return d.find('#movesSection').hidden && /changed while re-sorting/.test(d.find('#filingError').textContent) && forced.ok === false;
    `)) as boolean;
		delete process.env.FAKE_DRY_RUN_DELAY_MS;

		// The app name lives in the shared bar, so it shows on every screen. Check it is centred,
		// clear of the emblem and that nothing scrolls sideways, on ask/filing/settings at 1200px
		// and at the 360px minimum.
		const TITLE_ON = String.raw`
  const check = () => {
    const t = d.find('#appTitle').getBoundingClientRect();
    const e = d.find('.emblem').getBoundingClientRect();
    const w = window.innerWidth;
    return d.find('#appTitle').textContent === 'rag docs'
      && Math.abs((t.left + t.right) / 2 - w / 2) <= 1
      && t.right <= e.left + 1
      && document.documentElement.scrollWidth <= w + 1;
  };
  await d.click('[data-section="ask"]'); const a = check();
  await d.click('[data-section="filing"]'); const f = check();
  await d.click('[data-section="settings"]'); const s = check();
  return a && f && s;
`;
		result.titleWide = (await drive(browser, TITLE_ON)) as boolean;
		browser.setSize(360, 780);
		const reloadNarrow = loaded(browser);
		browser.reload();
		await reloadNarrow;
		result.titleNarrow = (await drive(browser, TITLE_ON)) as boolean;

		browser.setSize(1200, 820);
		const reloadLive = loaded(browser);
		browser.reload();
		await reloadLive;
		// Appearance is live: picking dark drives the real nativeTheme, the page sees dark, the file
		// stores it, then light and system again.
		await drive(browser, `${OPEN_SETTINGS} await d.click('#appearance [data-value="dark"]');`);
		const themeDark =
			nativeTheme.themeSource === 'dark' &&
			readFileSync(settingsFile, 'utf8') === '{"appearance":"dark"}' &&
			(await drive(browser, `return window.matchMedia('(prefers-color-scheme: dark)').matches;`)) === true;
		await drive(browser, `await d.click('#appearance [data-value="light"]');`);
		const themeLight = nativeTheme.themeSource === 'light';
		await drive(browser, `await d.click('#appearance [data-value="system"]');`);
		result.appearanceLive = themeDark && themeLight && nativeTheme.themeSource === 'system';

		// Open at login reflects the real (here in-memory) login item: off at start, set by the switch,
		// and a change made outside the app is picked up on the next focus without re-writing our file.
		// The switch is named by its label, and clicking the label text toggles it.
		const loginOffDefault = memoryLoginItem?.openAtLogin === false;
		const loginNamed = (await drive(browser, `return [...d.find('#loginSwitch').labels].map((l) => l.textContent.trim()).join(' ') === 'open at login';`)) === true;
		await drive(browser, `await d.click('.switchrow .lbl');`);
		const loginSet = memoryLoginItem?.openAtLogin === true;
		if (memoryLoginItem) memoryLoginItem.openAtLogin = false;
		await drive(browser, `window.dispatchEvent(new Event('focus')); await d.settle();`);
		const loginRepainted = (await drive(browser, `return d.find('#loginSwitch').checked === false;`)) as boolean;
		result.openAtLoginOk = loginOffDefault && loginNamed && loginSet && loginRepainted;

		// Layout rules (settings article, library search, AppBar clear, control targets) on all three
		// screens at both widths, with the add panel showing on ask. Failures show up in the SMOKE line.
		result.geometry = await measureGeometry(browser);

		const title = browser.getTitle();
		const own = isOwnFile(browser.webContents.getURL(), INDEX_URL);
		const ok = own && title === PRODUCT_NAME && result.libraryRows > 0 && result.answered && result.folderRows > 0 && result.notice && result.moves > 0 && result.filed === 'filed' && result.persisted === true && result.raceSafe === true && result.titleWide === true && result.titleNarrow === true && result.appearanceLive === true && result.openAtLoginOk === true
			&& result.dangerPill && result.sizeShown && result.searchRows === 2 && result.searchMeta && result.cleared === result.libraryRows && result.addDone && result.addAdded && result.addDuplicate && result.addFailed && result.grew && result.pageCited && result.openButtons === 2 && result.openedPath && result.vehiclesCounts && result.movesToVehicles && result.noUnsorted && result.movesToHousehold && result.sharedShownHousehold && result.sharedRenamedBack && result.applied === 'filed' && (result.geometry ?? []).length === 0;
		if (ok) {
			console.error(`SMOKE OK: library ${result.libraryRows} rows (big-scan pill + MB sizes), search "loan" -> 2 rows -> cleared, add 3 files -> added/duplicate/failed + library grew, answer cites p. 4 and an open button handed the located path to main, rename Car->Vehicles counts 2 documents and previews moves to Vehicles (none to unsorted), shared owner "Household" re-files; stale dry-run after a save refused; app name centred on ask/filing/settings at 1200px and 360px; appearance live (dark/light/system); open-at-login reflects the real login item; layout checks clean (settings article, library search top, AppBar 132px clear, 44px targets) on ask/filing/settings at 1200px and 360px`);
			code = 0;
		} else {
			console.error(`SMOKE FAIL: own=${own} title=${title} checks=${JSON.stringify(result)}`);
		}
	} catch (error: unknown) {
		console.error(`SMOKE FAIL: ${String(error)}`);
	}
	clearTimeout(deadline);
	if (settingsTempDir) rmSync(settingsTempDir, { recursive: true, force: true });
	rmSync(dir, { recursive: true, force: true });
	app.exit(code);
}

type Shot = { name: string; scenario: 'library' | 'no-owners'; width: number; height: number; steps: string; scrollTo?: string; scrollToRow?: string; delayMs?: number };

const OPEN_FILING = `await d.click('[data-section="filing"]');`;
const OPEN_OWNERS = `${OPEN_FILING} await d.click('[data-view="owners"]');`;
const OPEN_SETTINGS = `await d.click('[data-section="settings"]');`;
const ASK_STEPS = `await d.type('#askInput', 'When is the car loan paid off?'); await d.click('#askButton'); document.activeElement.blur();`;
const RENAME_AND_ADD = `${OPEN_FILING} await d.pick('Car'); await d.type('#nameInput', 'Vehicles'); await d.click('#saveButton');
  await d.click('[data-view="owners"]'); await d.click('#addButton'); await d.type('#nameInput', 'Example Studio'); await d.click('#saveButton');
  await d.click('[data-view="folders"]');`;

/** Ask with sizes and the pill, the add queue mid-run and done, then RagFiling's states, each
 * reached by using the app the way a person would. */
const SEARCH_LOAN = `await d.type('#librarySearch', 'loan');`;
const ADD_DONE = `await d.click('#addDocsButton');`;
/** Capture the queue WHILE it runs: one row must say adding… and cancel must be offered.
 * A settle would wait for the last file and show a finished queue, so the steps poll
 * instead, and throw rather than shoot an empty or finished panel. */
const ADD_RUNNING_CHECK = `const addPanel = document.querySelector('#addPanel');
  if (!addPanel || addPanel.hidden || !addPanel.textContent.includes('adding…')) throw new Error('add-running: no row is adding… at capture time');
  if (!document.querySelector('#addCancel') || document.querySelector('#addCancel')?.hidden) throw new Error('add-running: the cancel button is not visible');`;
const ADD_RUNNING = `d.find('#addDocsButton').click();
  for (let i = 0; i < 60; i += 1) {
    const panel = document.querySelector('#addPanel');
    if (panel && !panel.hidden && panel.textContent.includes('adding…') && !document.querySelector('#addCancel')?.hidden) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  ${ADD_RUNNING_CHECK}`;
/** The over-limit original: pill and size must be on the row, and the row in view. */
const OVER_LIMIT = `const big = d.row('#libraryRows', 'big-scan.pdf');
  if (big.querySelector('.pill')?.textContent !== 'not indexed: over 50 MB') throw new Error('over-limit: the pill is missing');
  if (!(big.querySelector('.row-preview')?.textContent ?? '').includes(' MB')) throw new Error('over-limit: the size is missing');`;
const SHOTS: Shot[] = [
	{ name: 'ask', scenario: 'library', width: 1200, height: 820, steps: ASK_STEPS },
	{ name: 'ask-search', scenario: 'library', width: 1200, height: 820, steps: SEARCH_LOAN },
	{ name: 'add-running', scenario: 'library', width: 1200, height: 820, steps: ADD_RUNNING, delayMs: 1500 },
	{ name: 'over-limit', scenario: 'library', width: 1200, height: 820, steps: OVER_LIMIT, scrollToRow: 'big-scan.pdf' },
	{ name: 'add-done', scenario: 'library', width: 1200, height: 820, steps: ADD_DONE },
	{ name: 'filing-folders', scenario: 'library', width: 1200, height: 820, steps: `${OPEN_FILING} await d.pick('Finance');` },
	{ name: 'filing-editing', scenario: 'library', width: 1200, height: 820, steps: `${OPEN_FILING} await d.pick('Car'); await d.type('#nameInput', 'Vehicles');` },
	{ name: 'filing-owners', scenario: 'library', width: 1200, height: 820, steps: `${OPEN_OWNERS} await d.pick('Alex Example');` },
	{ name: 'filing-owners-empty', scenario: 'no-owners', width: 1200, height: 820, steps: OPEN_OWNERS },
	{ name: 'filing-adding', scenario: 'library', width: 1200, height: 820, steps: `${OPEN_OWNERS} await d.click('#addButton'); await d.type('#nameInput', 'Example Studio');` },
	{ name: 'filing-error', scenario: 'library', width: 1200, height: 820, steps: `${OPEN_OWNERS} await d.click('#addButton'); await d.type('#nameInput', 'Example/Studio');` },
	{ name: 'filing-shared', scenario: 'library', width: 1200, height: 820, steps: `${OPEN_OWNERS} await d.pick('Shared'); await d.type('#nameInput', 'Household');` },
	{ name: 'filing-changed', scenario: 'library', width: 1200, height: 820, steps: RENAME_AND_ADD },
	{ name: 'filing-preview', scenario: 'library', width: 1200, height: 820, steps: `${RENAME_AND_ADD} await d.click('#resortButton');` },
	{ name: 'filing-small', scenario: 'library', width: 360, height: 780, steps: `${OPEN_FILING} await d.pick('Finance');` },
	{ name: 'filing-small-form', scenario: 'library', width: 360, height: 780, steps: `${OPEN_FILING} await d.pick('Finance');`, scrollTo: '#detailPane' },
	{ name: 'ask-small', scenario: 'library', width: 360, height: 780, steps: ASK_STEPS, scrollTo: '#appBar' },
	{ name: 'settings', scenario: 'library', width: 1200, height: 820, steps: OPEN_SETTINGS },
	{ name: 'settings-small', scenario: 'library', width: 360, height: 780, steps: OPEN_SETTINGS },
];

async function runShots(): Promise<void> {
	const deadline = setTimeout(() => {
		console.error('SHOTS FAIL: timed out after 600s');
		app.exit(1);
	}, 600000);
	const out = join(HERE, '..', 'screenshots');
	mkdirSync(out, { recursive: true });
	const browser = makeWindow();
	await loaded(browser);
	browser.show();
	try {
		for (const mode of ['light', 'dark'] as const) {
			nativeTheme.themeSource = mode;
			for (const shot of SHOTS) {
				const dir = freshFakeState();
				process.env.FAKE_SCENARIO = shot.scenario;
				if (shot.delayMs) process.env.FAKE_ADD_DELAY_MS = String(shot.delayMs); else delete process.env.FAKE_ADD_DELAY_MS;
				browser.setSize(shot.width, shot.height);
				const reload = loaded(browser);
				browser.reload();
				await reload;
				await drive(browser, shot.steps);
				if (shot.scrollTo) await drive(browser, `d.find('${shot.scrollTo}').scrollIntoView(); await d.settle();`);
				if (shot.scrollToRow) {
					// A named row is scrolled to the middle of the window, then confirmed on screen.
					await drive(browser, `d.row('#libraryRows', '${shot.scrollToRow}').scrollIntoView({ block: 'center' }); await d.settle();
  const overRow = d.row('#libraryRows', '${shot.scrollToRow}').getBoundingClientRect();
  // The last row can overshoot the viewport by a fraction of a pixel; 1 px of slack keeps
  // the check about readability, not sub-pixel rounding.
  if (overRow.top < 0 || overRow.bottom > innerHeight + 1) throw new Error('the scrolled row is not in view');`);
				}
				// Every shot that starts at the top of the page has to show the window title.
				// A shot with a slow add is taken mid-run: no settle here (it would wait for the
				// whole queue), and the steps' own checks are repeated right before the capture.
				if (!shot.scrollTo && !shot.scrollToRow) {
					const check = `const t = d.find('#appTitle').getBoundingClientRect(); return t.top >= 0 && t.bottom <= innerHeight;`;
					const visible = shot.delayMs ? await driveNow(browser, `${ADD_RUNNING_CHECK} ${check}`) : await drive(browser, check);
					if (visible !== true) throw new Error(`${shot.name}-${mode}: the window title is not in view`);
				}
				const image = await browser.webContents.capturePage();
				writeFileSync(join(out, `${shot.name}-${mode}.png`), image.toPNG());
				// Stop a queue that is still running so it can't touch the next shot.
				if (shot.delayMs) await driveNow(browser, `d.find('#addCancel').click(); await d.settle();`);
				rmSync(dir, { recursive: true, force: true });
			}
		}
	} catch (error: unknown) {
		console.error(`SHOTS FAIL: ${String(error)}`);
		clearTimeout(deadline);
		if (settingsTempDir) rmSync(settingsTempDir, { recursive: true, force: true });
		app.exit(1);
		return;
	}
	if (settingsTempDir) rmSync(settingsTempDir, { recursive: true, force: true });
	console.error(`SHOTS OK: ${SHOTS.length * 2} screenshots in screenshots/`);
	clearTimeout(deadline);
	app.exit(0);
}
