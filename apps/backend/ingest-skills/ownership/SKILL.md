---
name: ownership
description: Write a knowledge file for each GitHub team that CODEOWNERS names as the owner of a root, with an OWNS claim to the file of that root. Script only; no model.
---

# ownership

The host runs this skill as a plain command on the assembled ref, after the root skills. No model runs it.

1. The host writes `/ctxpipe/step.json` and the context index, as for each step.
2. The host runs `node /ctxpipe/skills/ownership/scripts/ownership.mjs --source /ctxpipe/source/<handle> --source-url <url> --roots <discover-roots result>`.
3. The script reads the first of `.github/CODEOWNERS`, `CODEOWNERS`, and `docs/CODEOWNERS`. For each root, the last rule whose pattern covers the root folder gives the owners. A file pattern (for example `*.md`) does not own a root. Only GitHub teams (`@org/team`) become team files; a person and an email address do not.
4. The file of a root is a file in `knowledge/services/`, `knowledge/apps/`, or `knowledge/libraries/` with a claim whose evidence is a package manifest of the root (for example `apps/api/package.json`). The team file gets an `OWNS` claim to it.
5. For each team, the script finds the context file of kind `Team` with the name `org/team` in the context index. It adds new claims and new `## Related` lines to it. When there is no such file, it creates `knowledge/teams/<team>.md`.
6. A CODEOWNERS line with a pattern or an owner that the script cannot quote safely is skipped and listed in `skipped`.
7. It writes the staged tree and `/ctxpipe/out/patch.json`, and a summary that matches `schema.json` to stdout.
