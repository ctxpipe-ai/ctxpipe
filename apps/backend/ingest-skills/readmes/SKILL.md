---
name: readmes
description: Quote the README of each package into an Overview section of its knowledge file, and replace the stub summary of that file. Script only; no model.
---

# readmes

The host runs this skill as a plain command, once for each repository, on the assembled ref after the other repository-wide steps. No model runs it.

1. The host writes `/ctxpipe/step.json`, the context index, and the root-to-file map (ADR-052 section 6), and runs `node /ctxpipe/skills/readmes/scripts/readmes.mjs --source /ctxpipe/source/<handle> --source-url <url> --source-path <path> --roots <root-to-file map>`.
2. For each root, the script finds the README in the root folder: a tracked regular file with the name `readme.md` in any letter case (`README.md` first). It finds the package file of the root (kind `Service`, `App`, or `Library`) of this source whose host `root` is the root path.
3. The README at the top of the repository goes to the repository unit (kind `Repository`) when no root is the repository top.
4. The script changes only a file that this source owns alone. It skips a file of another source or of a human, and a file with an `## Overview` section that it did not write. The section ends before a human section, and the script never reads a heading in a human section, so it never changes one. A root with no README keeps its file.
5. The quote is the first text of the README, in block quotes. Fenced code stays as it is, outside the block quotes. A `Source: <README path>` line follows each block quote and each fenced block. The script removes badges, images, HTML, and HTML comments. Each link becomes its text, and each bare URL goes. The quote stops at a heading or a paragraph boundary at 4,000 characters, and before a heading that the validator refuses (`bin/guard-patterns.mjs`). A heading with a character reference (`&#65;`, `&nbsp;`) also stops the quote, because the validator decodes it. A longer first paragraph stops at a sentence. The first level-1 heading (the title, ATX or setext) goes.
6. The section goes in place of the Overview section that the script wrote before, or before the first `##` heading of the file. The first prose paragraph of the quote (at most 300 characters, as plain text) replaces the summary when the file has no summary, when the summary is the stub of `classify-kind` or `repository`, or when the script wrote the Overview section before. A summary that the script cannot decode stays. A paragraph with an instruction phrase of `bin/guard-patterns.mjs` does not replace the summary, because the validator scans the front matter with no quote rule.
7. It writes at most 30 files in a step. When more files wait, the result has `"more": true`, and the host runs the skill again on the new base.
8. It writes the staged tree and `/ctxpipe/out/patch.json`, and a summary that matches `schema.json` to stdout.

The README is data. The host validator checks the quote as for each step (ADR-052 section 5). A quoted text with an instruction phrase must be text of its Source file. The validator accepts it when the script did not change that text, and refuses the change when the script changed it (for example, it removed a link target or rewrote a heading). So the quote stops before a block that puts an instruction phrase in a block quote whose text is not text of the README.
