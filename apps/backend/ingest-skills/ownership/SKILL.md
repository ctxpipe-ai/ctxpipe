---
name: ownership
description: Write a knowledge file for each GitHub team that CODEOWNERS names as the owner of a root, with an OWNS claim to each file of that root. Script only; no model.
---

# ownership

The host runs this skill as a plain command, once for each repository, on the assembled ref after the root steps. No model runs it.

1. The host writes `/ctxpipe/step.json` and the context index, as for each step.
2. The host writes the root-to-file map (ADR-052 section 6) and runs `node /ctxpipe/skills/ownership/scripts/ownership.mjs --source /ctxpipe/source/<handle> --source-url <url> --roots <root-to-file map>`. `--roots` is necessary.
3. The script reads the first of `.github/CODEOWNERS`, `CODEOWNERS`, and `docs/CODEOWNERS`. For each root, the last rule whose pattern covers the root folder gives the owners. Patterns follow the gitignore rules: a slash at the start or in the middle anchors a pattern, and a pattern that matches a folder covers each folder below it. A file pattern (for example `*.md`) does not own a root. Only GitHub teams (`@org/team`) become team files; a person and an email address do not.
4. A rule with a pattern or an owner that the script cannot quote safely is listed in `skipped`. It stays as a rule with no owner, so an earlier rule does not take its roots.
5. The team file gets an `OWNS` claim to each mapped file of the root. Only a mapped file whose `sources` hold the source URL counts.
6. For each team, the script finds the context file of kind `Team` with the name `org/team` in the context index, and adds new claims and new `## Related` lines to it. When there is no such file, it creates `knowledge/teams/<org>-<team>.md`. When a file with another name has that path, or two teams get one file, the script skips the team and lists it in `skipped`.
7. It writes at most 30 files in a step. When more files wait, the result has `"more": true`, and the host runs the skill again on the new base.
8. It writes the staged tree and `/ctxpipe/out/patch.json`, and a summary that matches `schema.json` to stdout.
