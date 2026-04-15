Seed: better_hub_full

This directory contains a committed snapshot bundle that remote-agent containers can restore to bring up a fully onboarded org + user with the `better-auth/better-hub` repository already ingested.

Artifacts
- `seed_bundle.tar.gz`: tar.gz containing the files below.
- `manifest.json`: stable IDs + metadata for the seed.
- `credentials.json`: non-secret identifiers for browser automation (email, orgSlug, landingPath).

Generation
- Run: `pnpm --filter @ctxpipe/backend seed:better-hub`
- Required env:
  - `SEED_USER_EMAIL`
  - `SEED_USER_NAME`
  - `SEED_USER_PASSWORD` (secret; do not commit)
  - `SEED_ORG_NAME`
  - `SEED_ORG_SLUG`

Restore (remote agent only)
- Remote agent startup restores the seed when `CTXPIPE_REMOTE_AGENT_SEED=better_hub_full` is set.
- Startup writes runtime-only credentials to `/tmp/ctxpipe_seed_credentials.json` for browser automation.

