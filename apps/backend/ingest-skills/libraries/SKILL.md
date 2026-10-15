---
name: libraries
description: Write a knowledge file for each architectural library that the roots use (data access, web framework, HTTP client, auth, validation, cache, messaging, RPC), and a USES_LIBRARY claim from each root file. Script only; no model.
---

# libraries

The host runs this skill as a plain command, once for each repository, on the assembled ref after the root steps. It is repository-wide because it writes shared files (for example `knowledge/libraries/zod.md`). No model runs it.

1. The host writes `/ctxpipe/step.json` and the context index, as for each step.
2. The host writes the root-to-file map (ADR-052 section 6) and runs `node /ctxpipe/skills/libraries/scripts/libraries.mjs --source /ctxpipe/source/<handle> --source-url <url> --roots <root-to-file map>`. `--roots` is necessary.
3. The script reads the direct dependencies in each root manifest (`package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, `requirements.txt`, `pom.xml`, `build.gradle`, `Gemfile`). It keeps only the libraries in `scripts/catalog.mjs`.
4. For each library, it finds the context file of kind `Library` with the same name in the context index. It adds new lines to the `## Related` section of that file. When there is no such file, it creates `knowledge/libraries/<id>.md`.
5. Each mapped root file of kind `Service` or `Repository` gets a `USES_LIBRARY` claim to the library file. Only a mapped file whose `sources` hold the source URL counts.
6. It writes at most 30 files in a step. When more files wait, the result has `"more": true`, and the host commits the step and runs the skill again on the new base.
7. It writes the staged tree and `/ctxpipe/out/patch.json`, and a summary that matches `schema.json` to stdout. A root path or a file that the script cannot quote safely is skipped and listed in `skipped`.

The script never sets a host field. It changes an existing file only additively (new claims, and new lines in a `## Related` section at the end), so the host accepts the change also for a file that a human owns.
