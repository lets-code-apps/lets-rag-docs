#!/usr/bin/env node
// A stand-in for the real Rust engine, used by smoke/screenshots. Synthetic only: it reads the
// repository's committed JSON fixtures under `testdata/desktop` and never touches documents,
// SQLite or the local model. Scenario via FAKE_SCENARIO: default, validation-error, empty.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TESTDATA = join(HERE, '..', '..', '..', 'testdata', 'desktop');
const args = process.argv.slice(2);
const scenario = process.env.FAKE_SCENARIO || 'default';

function fixture(name) {
  return readFileSync(join(TESTDATA, name), 'utf8');
}

function readStdin() {
  return new Promise((resolve) => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { text += chunk; });
    process.stdin.on('end', () => resolve(text));
  });
}

function show(name) {
  process.stdout.write(fixture(name));
  process.exit(0);
}

if (args[0] === 'documents') {
  if (scenario === 'empty') show('documents-no-database.json');
  show('documents.json');
}

if (args[0] === 'ask') {
  if (args.includes('--json')) {
    show(scenario === 'empty' ? 'ask-no-passages.json' : 'ask.json');
  }
}

if (args[0] === 'filing') {
  if (args[1] === 'show') {
    show('filing.json');
  }
  if (args[1] === 'save') {
    const stdin = await readStdin();
    let draft = {};
    try {
      draft = JSON.parse(stdin.trim());
    } catch {
      process.stderr.write('fake engine: stdin must be JSON\n');
      process.exit(1);
    }
    const invalid = scenario === 'validation-error' || (Array.isArray(draft.folders) && draft.folders.length === 0);
    if (invalid) {
      show('filing-errors.json');
    }
    show('filing.json');
  }
}

if (args[0] === 'organize') {
  if (args.includes('--apply')) show('organize-apply.json');
  else if (args.includes('--dry-run')) {
    if (scenario === 'empty') show('organize-no-database.json');
    show('organize-dry-run.json');
  }
}