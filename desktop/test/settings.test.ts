import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  DEFAULT_SETTINGS,
  isAllowedSetting,
  parseSettings,
  loadSettings,
  saveSettings,
  SettingsController,
  type Appearance,
  type SettingsHost,
} from '../src/settings.ts';

function tempFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), 'rag-docs-settings-test-')), name);
}

test('parseSettings reads a valid file and falls back on anything else', () => {
  assert.deepEqual(parseSettings('{"appearance":"dark"}'), { appearance: 'dark', setupDone: false });
  for (const bad of ['', 'not json', 'null', '[]', '{"appearance":"purple"}', '{"appearance":1}', '{}']) {
    assert.deepEqual(parseSettings(bad), DEFAULT_SETTINGS, bad);
  }
});

test('setupDone is only true when the file says so, and never from a non-boolean', () => {
  assert.equal(parseSettings('{"appearance":"dark","setupDone":true}').setupDone, true);
  assert.equal(parseSettings('{"appearance":"dark","setupDone":false}').setupDone, false);
  for (const junk of ['"yes"', '1', 'null', '{}']) {
    assert.equal(parseSettings(`{"appearance":"dark","setupDone":${junk}}`).setupDone, false, junk);
  }
});

test('isAllowedSetting accepts only known names with the right value type', () => {
  assert.ok(isAllowedSetting('appearance', 'light'));
  assert.ok(isAllowedSetting('openAtLogin', false));
  assert.ok(isAllowedSetting('setupDone', true));
  assert.equal(isAllowedSetting('appearance', 'purple'), false);
  assert.equal(isAllowedSetting('openAtLogin', 'yes'), false);
  assert.equal(isAllowedSetting('setupDone', false), false, 'setupDone accepts only true');
  assert.equal(isAllowedSetting('setupDone', 'true'), false);
  assert.equal(isAllowedSetting('theme', 'dark'), false);
  assert.equal(isAllowedSetting('__proto__', true), false);
});

test('loadSettings defaults when the file is missing, and when it holds garbage', () => {
  const missing = tempFile('missing.json');
  assert.deepEqual(loadSettings(missing), DEFAULT_SETTINGS);

  const garbage = tempFile('garbage.json');
  writeFileSync(garbage, '{"appearance":"purple"} not even json');
  assert.deepEqual(loadSettings(garbage), DEFAULT_SETTINGS);
});

test('saveSettings round-trips, creates a missing parent dir, and never throws on a bad path', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'rag-docs-settings-test-')), 'nested', 'deeper', 'settings.json');
  assert.equal(saveSettings(file, { appearance: 'dark', setupDone: false }), true);
  assert.deepEqual(loadSettings(file), { appearance: 'dark', setupDone: false });

  // The parent is a regular file, so the write cannot happen: false, not a throw.
  const dir = mkdtempSync(join(tmpdir(), 'rag-docs-settings-test-'));
  const blockedFile = join(dir, 'blocker');
  writeFileSync(blockedFile, 'a file where a folder should be');
  const blocked = join(blockedFile, 'settings.json');
  assert.equal(saveSettings(blocked, { appearance: 'dark', setupDone: false }), false);
});

test('an unfinished file stays {"appearance":…}; only a done file adds setupDone', () => {
  const file = tempFile('settings.json');
  saveSettings(file, { appearance: 'dark', setupDone: false });
  assert.equal(loadSettings(file).setupDone, false);
  assert.equal(readFileSyncSafe(file), '{"appearance":"dark"}', 'no setupDone key while false');

  saveSettings(file, { appearance: 'dark', setupDone: true });
  assert.equal(loadSettings(file).setupDone, true);
  assert.equal(readFileSyncSafe(file), '{"appearance":"dark","setupDone":true}');
});

function readFileSyncSafe(file: string): string {
  return readFileSync(file, 'utf8');
}

function makeHost(start = false): { host: SettingsHost; theme: () => Appearance | undefined; login: () => boolean } {
  let theme: Appearance | undefined;
  let login = start;
  const host: SettingsHost = {
    setTheme: (appearance) => {
      theme = appearance;
    },
    getOpenAtLogin: () => login,
    setOpenAtLogin: (value) => {
      login = value;
    },
  };
  return { host, theme: () => theme, login: () => login };
}

test('SettingsController payload re-reads the host login state every call', () => {
  const file = tempFile('settings.json');
  const h = makeHost(false);
  const controller = new SettingsController(file, h.host);
  assert.deepEqual(controller.payload(), { appearance: 'system', openAtLogin: false, setupDone: false });
  controller.set('openAtLogin', true);
  assert.deepEqual(controller.payload(), { appearance: 'system', openAtLogin: true, setupDone: false });
});

test('set appearance writes the file, moves the theme, and returns the new truth', () => {
  const file = tempFile('settings.json');
  const h = makeHost(false);
  const controller = new SettingsController(file, h.host);
  assert.deepEqual(controller.set('appearance', 'dark'), { appearance: 'dark', openAtLogin: false, setupDone: false });
  assert.equal(h.theme(), 'dark');
  assert.deepEqual(loadSettings(file), { appearance: 'dark', setupDone: false });
});

test('set openAtLogin touches the OS login item but never our file', () => {
  const file = tempFile('settings.json');
  const h = makeHost(false);
  const controller = new SettingsController(file, h.host);
  assert.deepEqual(controller.set('openAtLogin', true), { appearance: 'system', openAtLogin: true, setupDone: false });
  assert.equal(h.login(), true);
  assert.deepEqual(loadSettings(file), DEFAULT_SETTINGS); // still no stored appearance
});

test('set setupDone records onboarding done and round-trips across a restart', () => {
  const file = tempFile('settings.json');
  const h = makeHost(false);
  const controller = new SettingsController(file, h.host);
  assert.deepEqual(controller.set('setupDone', true), { appearance: 'system', openAtLogin: false, setupDone: true });
  assert.equal(readFileSyncSafe(file), '{"appearance":"system","setupDone":true}');

  // A second controller over the same file keeps setupDone true.
  const reloaded = new SettingsController(file, makeHost(false).host);
  reloaded.load();
  assert.equal(reloaded.payload().setupDone, true);
});

test('set setupDone refuses false and any other value (onboarding is never undone)', () => {
  const file = tempFile('settings.json');
  const h = makeHost(false);
  const controller = new SettingsController(file, h.host);
  for (const bad of [false, 'true', 1, null] as const) {
    assert.equal(controller.set('setupDone', bad), null, `setupDone=${String(bad)}`);
  }
  assert.equal(controller.payload().setupDone, false);
  assert.equal(h.theme(), undefined);
});

test('set appearance keeps an already-recorded setupDone', () => {
  const file = tempFile('settings.json');
  const h = makeHost(false);
  const controller = new SettingsController(file, h.host);
  controller.set('setupDone', true);
  controller.set('appearance', 'light');
  assert.equal(controller.payload().setupDone, true, 'appearance change must not drop setupDone');
  assert.deepEqual(loadSettings(file), { appearance: 'light', setupDone: true });
});

test('set refuses anything unknown and leaves the host untouched', () => {
  const file = tempFile('settings.json');
  const h = makeHost(false);
  const controller = new SettingsController(file, h.host);
  for (const bad of [
    ['appearance', 'purple'],
    ['openAtLogin', 'yes'],
    ['theme', 'dark'],
    ['__proto__', true],
  ] as const) {
    assert.equal(controller.set(bad[0], bad[1]), null, `${bad[0]}=${String(bad[1])}`);
  }
  assert.equal(h.theme(), undefined);
  assert.equal(h.login(), false);
});

test('a failed write still applies the theme (choice holds for this run)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rag-docs-settings-test-'));
  const blockedFile = join(dir, 'blocker');
  writeFileSync(blockedFile, 'a file where a folder should be');
  const blocked = join(blockedFile, 'settings.json');
  const h = makeHost(false);
  const controller = new SettingsController(blocked, h.host);
  assert.deepEqual(controller.set('appearance', 'dark'), { appearance: 'dark', openAtLogin: false, setupDone: false });
  assert.equal(h.theme(), 'dark');
  assert.deepEqual(loadSettings(blocked), DEFAULT_SETTINGS); // not persisted
});

test('a new controller over the same file re-applies the saved appearance (survives a restart)', () => {
  const file = tempFile('settings.json');
  const first = makeHost(false);
  new SettingsController(file, first.host).set('appearance', 'dark');

  const second = makeHost(false);
  const reloaded = new SettingsController(file, second.host);
  reloaded.load();
  assert.equal(second.theme(), 'dark');
  assert.deepEqual(reloaded.payload(), { appearance: 'dark', openAtLogin: false, setupDone: false });
});
