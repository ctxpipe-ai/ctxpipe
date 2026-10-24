import { dirname, join } from "node:path"

/**
 * Zoekt index and git clone cache directories.
 *
 * Defaults match production Docker (`/data/...`). Host dev sets `ZOEKT_INDEX_DIR`
 * and `REPO_CACHE_DIR` (see `scripts/dev-apps.sh`) to writable paths under
 * `apps/codesearch/.data/`.
 *
 * Durable Zoekt shards live in `ZOEKT_INDEX_DIR` (cold). `zoekt-webserver`
 * watches `ZOEKT_HOT_DIR` (sibling `zoekt-hot`), which holds only symlinks to
 * pinned cold shards. Hot is derived from the cold path — no separate env var.
 */
export const ZOEKT_INDEX_DIR =
  process.env["ZOEKT_INDEX_DIR"] ?? "/data/zoekt-index"
export const REPO_CACHE_DIR =
  process.env["REPO_CACHE_DIR"] ?? "/data/repo-cache"

/**
 * The cache layout version file, in the repository cache: Docker Compose
 * mounts that directory as its own volume, so the file stays with the cache.
 * No org id starts with `.`, so no repository path uses this name.
 */
export const CACHE_LAYOUT_MARKER = join(REPO_CACHE_DIR, ".codesearch-layout")

/** Hot symlink dir for zoekt-webserver: sibling `zoekt-hot` of the cold index. */
export function zoektHotDirFromIndexDir(indexDir: string): string {
  return join(dirname(indexDir), "zoekt-hot")
}

export const ZOEKT_HOT_DIR = zoektHotDirFromIndexDir(ZOEKT_INDEX_DIR)

/**
 * Zoekt webserver base URL. In Docker Compose this is the service name; in
 * production (Railway) where both processes share a single container it should
 * be overridden to http://localhost:6070 via the ZOEKT_WEBSERVER_URL env var.
 */
export const ZOEKT_WEBSERVER_URL =
  process.env["ZOEKT_WEBSERVER_URL"] ?? "http://zoekt-webserver:6070"
