---
name: repository
description: Write the repository unit, knowledge/codebases/<repository>.md of kind Repository, before the root steps, so that each later step can link to it. Script only; no model.
---

# repository

The host runs this skill as a plain command, once for each run and Workspace, on the assembled ref before the root steps (ADR-052 section 6). No model runs it.

1. The host writes `/ctxpipe/step.json`, the context index, and the root-to-file map, and runs `node /ctxpipe/skills/repository/scripts/repository.mjs --source /ctxpipe/source/source --source-url <url> --roots /ctxpipe/roots.json`.
2. The script finds the context file of kind `Repository` whose name is `owner/repository` or `repository` in the context index. When there is no such file, it creates `knowledge/codebases/<repository>.md`. When a file with another name has that path, it skips and lists the file in `skipped`.
3. It adds one line to the `## Related` section for each root of the map: the root path and its first manifest. A file that the source does not solely own gets only new lines.
4. The host sets `generated_by`, `sources`, `source_sha`, `skill`, `bundle`, and `root: .`. The script never sets them.
5. It writes the staged tree and `/ctxpipe/out/patch.json` (`more` when lines wait for a next page), and a summary that matches `schema.json` to stdout.
