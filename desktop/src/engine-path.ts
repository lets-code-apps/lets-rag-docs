// Finds the Rust engine binary the desktop will spawn. Pure (no spawning), so it is trivial to
// test with a fake environment. Search order (first match wins):
//   1. `RAG_DOCS_ENGINE_PATH` - a developer pointing at a specific (often debug) binary.
//   2. `<resources>/engine/lets-rag-docs` - the bundled engine in a packaged build.
//   3. `<repo>/target/debug/lets-rag-docs` - the debug build the developer just compiled.
//
// We pass no `--config` unless `RAG_DOCS_CONFIG` is set: the engine otherwise uses its normal
// local config path. Agents and smoke tests override both variables.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

const BINARY = 'lets-rag-docs';

export type EnginePath = { file: string; baseArgs: string[] };

export function resolveEngine(
	env: NodeJS.ProcessEnv,
	resourcesPath: string | undefined,
	repoRoot: string,
): EnginePath {
	const baseArgs: string[] = [];
	const config = env.RAG_DOCS_CONFIG;
	if (config) {
		baseArgs.push('--config', config);
	}

	const override = env.RAG_DOCS_ENGINE_PATH;
	if (override) {
		return { file: override, baseArgs };
	}

	if (resourcesPath) {
		const packaged = join(resourcesPath, 'engine', BINARY);
		if (existsSync(packaged)) {
			return { file: packaged, baseArgs };
		}
	}

	const dev = join(repoRoot, 'target', 'debug', BINARY);
	if (existsSync(dev)) {
		return { file: dev, baseArgs };
	}

	throw new Error(
		`no lets-rag-docs engine found.\n` +
			`  tried RAG_DOCS_ENGINE_PATH (unset), ${join('resources', 'engine', BINARY)} and ${dev}.\n` +
			`  build it first with \`cargo build\` from the repository root, ` +
			`or set RAG_DOCS_ENGINE_PATH to a built binary.`,
	);
}