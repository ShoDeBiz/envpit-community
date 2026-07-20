import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/** `envpit-community/test-vectors/` — one level above `sdks/` (repo root), resolved from THIS
 *  file's own location so any test under `sdks/node/test/**` can import `loadVectors` without
 *  re-deriving the relative path itself (bd:envpit-0t2z.3 Slice 0). Test-code only: never
 *  bundled into the shipped `dist/` output (tsup only builds `src/`), so this adds zero runtime
 *  dependency/footprint to the published `@envpit/sdk` package. */
const TEST_VECTORS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../test-vectors');

/** Loads and parses one `test-vectors/<name>.json` file. `name` includes the `.json` extension,
 *  e.g. `loadVectors('sse-frames.json')`. */
export function loadVectors<T>(name: string): T {
  const path = resolve(TEST_VECTORS_ROOT, name);
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}
