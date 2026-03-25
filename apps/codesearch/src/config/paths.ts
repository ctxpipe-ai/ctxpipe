/**
 * Zoekt index and git clone cache directories.
 *
 * Defaults match production Docker (`/data/...`). Host dev sets `ZOEKT_INDEX_DIR`
 * and `REPO_CACHE_DIR` (see `scripts/dev-apps.sh`) to writable paths under
 * `apps/codesearch/.data/`.
 */
export const ZOEKT_INDEX_DIR =
  process.env["ZOEKT_INDEX_DIR"] ?? "/data/zoekt-index"
export const REPO_CACHE_DIR =
  process.env["REPO_CACHE_DIR"] ?? "/data/repo-cache"

/**
 * Zoekt webserver base URL. In Docker Compose this is the service name; in
 * production (Railway) where both processes share a single container it should
 * be overridden to http://localhost:6070 via the ZOEKT_WEBSERVER_URL env var.
 */
export const ZOEKT_WEBSERVER_URL = process.env["ZOEKT_WEBSERVER_URL"] ?? "http://zoekt-webserver:6070"
