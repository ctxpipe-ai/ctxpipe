# Re-ingestion version markers

Each file `<name>.md` in this folder is a version marker. The re-ingestion version comes from the marker names. The key `reingest-<version>` offers each Workspace a re-ingestion. A Workspace with automatic upgrades starts that re-ingestion with no click, and the re-ingestion costs model money.

## When to add a marker

- Add one marker when your change can change the knowledge that ingestion writes: a new or removed skill folder, a changed skill instruction, a changed schema, or a script change that changes what a skill finds or writes.
- Do not add a marker for a change that keeps the output the same: speed, format, lint, comments, or tests.
- Name the marker after your issue, for example `ctx-1531.md`. Use lowercase letters, digits, and hyphens. In the file, write one sentence that says what knowledge changes.
- Do not edit or remove a marker that is on `main`. A changed name changes the version.

## How the version is calculated

- One marker gives its name. The seed marker `ingest-ca237393fef135a9.md` keeps the version of the time before markers.
- More markers give `ingest-<16 hex>`: the first 64 bits of the SHA-256 of the sorted names, one name for each line. Thus two PRs that each add a marker do not conflict, and their merge gives the same version in each order.
- The text in a marker file does not change the version. The read skips `README.md` and dot files, and fails on each other file that is not `<name>.md`.
- This folder is not part of the bundle content hash, and the sandbox does not get it.

See ADR-052, revision 2026-11-23 (CTX-1559).
