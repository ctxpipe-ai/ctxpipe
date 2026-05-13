import { resolve } from "node:path"

/**
 * Centralised paths for committed seed artifacts and runtime-only credential files.
 *
 * Seed bundle is committed to the repo so remote agents can restore without network calls.
 * Runtime credentials are written to /tmp so we never commit secrets.
 */
export const BETTER_HUB_SEED_DIR = resolve(
  process.cwd(),
  "apps/backend/test/seeds/better_hub_full",
)

export const BETTER_HUB_SEED_BUNDLE_TGZ = resolve(
  BETTER_HUB_SEED_DIR,
  "seed_bundle.tar.gz",
)

export const BETTER_HUB_SEED_MANIFEST_JSON = resolve(
  BETTER_HUB_SEED_DIR,
  "manifest.json",
)

export const BETTER_HUB_SEED_PUBLIC_CREDENTIALS_JSON = resolve(
  BETTER_HUB_SEED_DIR,
  "credentials.json",
)

// Runtime-only file written by remote-agent startup to hand browser automation credentials.
export const BETTER_HUB_SEED_RUNTIME_CREDENTIALS_JSON =
  "/tmp/ctxpipe_seed_credentials.json"

