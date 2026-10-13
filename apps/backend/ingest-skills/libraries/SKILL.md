---
name: libraries
description: Write a knowledge file for each architectural library that the roots use (data access, web framework, HTTP client, auth, validation, cache, messaging, RPC). Script only; no model.
---

# libraries

The host runs this skill as a plain command. No model runs it.

1. The host writes `/ctxpipe/step.json` and the context index, as for each step.
2. The host runs `node /ctxpipe/skills/libraries/scripts/libraries.mjs --source /ctxpipe/source/<handle> --source-url <url> --roots <discover-roots result>`.
3. The script reads the direct dependencies in each root manifest (`package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, `requirements.txt`, `pom.xml`, `build.gradle`, `Gemfile`). It keeps only the libraries in `scripts/catalog.mjs`.
4. For each library, it finds the context file of kind `Library` with the same name in the context index. It adds new lines to the `## Related` section of that file. When there is no such file, it creates `knowledge/libraries/<id>.md`.
5. It writes the staged tree and `/ctxpipe/out/patch.json`, and a summary that matches `schema.json` to stdout.

The script never sets a host field. It changes an existing file only with new lines in a `## Related` section at the end, so the host accepts the change also for a file that a human owns.
