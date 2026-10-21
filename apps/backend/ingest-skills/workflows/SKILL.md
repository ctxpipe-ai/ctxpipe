---
name: workflows
description: Write a knowledge file of kind Workflow for each GitHub Actions workflow file of the source, with its triggers, its job ids, and a MENTIONS claim to each package whose root the workflow names. Script only; no model.
---

# workflows

The host runs this skill as a plain command, once for each repository, on the assembled ref after the other repository-wide steps. No model runs it.

1. The host writes `/ctxpipe/step.json`, the context index, and the root-to-file map (ADR-052 section 6), and runs `node /ctxpipe/skills/workflows/scripts/workflows.mjs --source /ctxpipe/source/<handle> --source-url <url> --source-path <path> --roots <root-to-file map>`. `--roots` is necessary.
2. The script reads each file directly in `.github/workflows/` whose name ends in `.yml` or `.yaml`, at most 50 files. It reads the YAML without a parser library. It walks the lines and reads only 7 key paths: `name`, `on`, `on.<event>.paths`, the ids under `jobs`, and `working-directory` at the top level, in a job, and in a step. It skips each line under a key that has a value on its line, so it never reads a block scalar. It gives no value for an anchor, an alias, a tag, or a flow map. It skips a file that it cannot read with certainty, and a file with no jobs, and lists each one in `skipped`.
3. It writes `knowledge/workflows/<owner>-<repository>-<file>.md` of kind `Workflow` with `workflow_file` (the path of the workflow file), the workflow name, the triggers, and the job ids. It never copies a `run`, `env`, `with`, or `secrets` value, a step, or a job name.
4. For each `on.<event>.paths` filter and each `working-directory` (top level, job, or step), it finds the root of the map with the longest path that holds the value. A negation, an expression, or a pattern above a root names no root. The repository top is never a match. The file gets a `MENTIONS` claim to each mapped `Service`, `App`, or `Library` file of that root, and a `## Related` line. Only a mapped file whose `sources` hold the source path (`--source-path`) counts.
5. A file that the source owns alone gets its full text again; when only the host fields would change, the script makes no op. A file that a human or another source owns gets only new claims and new `## Related` lines.
6. It deletes each file of kind `Workflow` that the source owns alone and whose workflow file has left the source. It deletes at most 20% of the files that the source owns alone in a step, as the validator allows, and at most 10.
7. It writes at most 30 files in a step. When more files wait, the result has `"more": true`, and the host runs the skill again on the new base.
8. It writes the staged tree and `/ctxpipe/out/patch.json`, and a summary that matches `schema.json` to stdout. The host sets `generated_by`, `sources`, `source_sha`, `skill`, and `bundle`. The script never sets them.
