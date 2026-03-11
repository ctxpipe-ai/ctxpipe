/**
 * Fixed paths for Zoekt index and repo cache. In Docker, mount persistent
 * volumes at these paths.
 */
export const ZOEKT_INDEX_DIR = "/data/zoekt-index"
export const REPO_CACHE_DIR = "/data/repo-cache"

/**
 * Zoekt webserver base URL. In Docker Compose this is the service name; in
 * production (Railway) where both processes share a single container it should
 * be overridden to http://localhost:6070 via the ZOEKT_WEBSERVER_URL env var.
 */
export const ZOEKT_WEBSERVER_URL = process.env["ZOEKT_WEBSERVER_URL"] ?? "http://zoekt-webserver:6070"
