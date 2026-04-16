/**
 * Path-aware .env loader.
 *
 * `import "dotenv/config"` reads `.env` from `process.cwd()`, which breaks
 * when the MCP server is launched as a subprocess from an unknown cwd
 * (Hermes, Claude Desktop, OpenClaw all do this). Instead, we resolve `.env`
 * relative to the running script so it just works regardless of cwd.
 *
 * Resolution order (first hit wins):
 *   1. $CIFER_ENV_FILE                       (explicit override)
 *   2. <script dir>/.env                     (running from source via tsx)
 *   3. <script dir>/../.env                  (running dist/script.js)
 *   4. <cwd>/.env                            (fallback — legacy behavior)
 *
 * Also exports ENV_PATH: the canonical location the `init` command should
 * write to — always the top-level repo `.env`, never nested inside `dist/`.
 */

import { config as dotenvConfig } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Directory of the importing module (works under both tsx and compiled). */
export function moduleDir(metaUrl: string): string {
  return dirname(fileURLToPath(metaUrl));
}

/** Canonical path for the repo-level .env that init writes. */
export function canonicalEnvPath(metaUrl: string): string {
  const here = moduleDir(metaUrl);
  // Built layout: <repo>/dist/<script>.js → .env lives one level up.
  // Source layout: <repo>/<script>.ts     → .env lives beside the script.
  // We always prefer the "one level up" location if it's a repo root
  // (detected by the presence of package.json), otherwise fall back to
  // the script directory.
  const oneUp = resolve(here, "..");
  if (existsSync(join(oneUp, "package.json"))) {
    return join(oneUp, ".env");
  }
  return join(here, ".env");
}

/**
 * Load .env into process.env if it hasn't been loaded yet. Safe to call
 * multiple times (dotenv no-ops if keys are already set).
 *
 * Returns the path that was loaded, or null if no .env was found.
 */
export function loadEnv(metaUrl: string): string | null {
  const here = moduleDir(metaUrl);
  const candidates: string[] = [];

  if (process.env.CIFER_ENV_FILE) candidates.push(process.env.CIFER_ENV_FILE);
  candidates.push(join(here, ".env"));
  candidates.push(resolve(here, "..", ".env"));
  candidates.push(join(process.cwd(), ".env"));

  for (const p of candidates) {
    if (existsSync(p)) {
      dotenvConfig({ path: p });
      return p;
    }
  }
  return null;
}
