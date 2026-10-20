---
name: readmes
description: Quote the README of each package into an Overview section of its knowledge file, and replace the stub summary of that file. Script only; no model.
---

# readmes

The host runs this skill as a plain command, once for each repository, on the assembled ref after the other repository-wide steps. No model runs it.

1. The host writes `/ctxpipe/step.json`, the context index, and the root-to-file map (ADR-052 section 6), and runs `node /ctxpipe/skills/readmes/scripts/readmes.mjs --source /ctxpipe/source/<handle> --source-url <url> --source-path <path> --roots <root-to-file map>`.
2. For each root, the script finds the README in the root folder (`README.md` first, then another `readme`, `readme.md`, or `readme.markdown` name in any letter case). It finds the package file of the root (kind `Service`, `App`, or `Library`) in the map. When the map has no file for the root, it finds the package file of this source whose host `root` is the root path.
3. The README at the top of the repository goes to the repository unit (kind `Repository`) when no root is the repository top.
4. The script changes only a file that this source owns alone. It skips a file of another source or of a human, and a file with an `## Overview` section that it did not write. The section ends before a human section, and the script never reads a heading in a human section, so it never changes one. A root with no README keeps its file.
5. The quote is the opening text of the README, as a block quote, with a `Source: <README path>` line after it. Fenced code stays as it is, outside the block quote. The script removes badges, images, HTML, and HTML comments. A relative link goes to the file in the source repository on GitHub; for another host it becomes plain text. A link to another repository becomes plain text, and a bare URL goes. The quote stops at a heading or a paragraph boundary at 4,000 characters, and before a heading that names agents or models. The first level-1 heading (the title) goes.
6. The section goes in place of the Overview section that the script wrote before, or before the first `##` heading of the file. The first prose paragraph of the quote (at most 300 characters, as plain text) replaces the summary when the summary is the stub of `classify-kind` or `repository`, or when the script wrote the Overview section before.
7. It writes at most 30 files in a step. When more files wait, the result has `"more": true`, and the host runs the skill again on the new base.
8. It writes the staged tree and `/ctxpipe/out/patch.json`, and a summary that matches `schema.json` to stdout.

The README is data. The host validator checks the quote as for each step (ADR-052 section 5): a quoted instruction must be the text of its Source file, so the validator refuses a change that holds one.
