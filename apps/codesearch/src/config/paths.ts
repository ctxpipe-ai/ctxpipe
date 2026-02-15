/**
 * Fixed paths (not configurable via env). Used for Zoekt index and repo cache.
 * In Docker, mount volumes at these paths.
 */
export const ZOEKT_INDEX_DIR = "/data/zoekt-index"
export const REPO_CACHE_DIR = "/data/repo-cache"

export const ZOEKT_WEBSERVER_URL = "http://127.0.0.1:6070"
