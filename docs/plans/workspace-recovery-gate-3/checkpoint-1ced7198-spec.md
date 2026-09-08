# Spec review — Gate 3 eight-kind checkpoint

Pinned range: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...1ced719864bceed1640842de319313c45614a983`.

## Findings

1. **[P1] Existing keyed knowledge is overwritten instead of merged.** `migration-export.ts:507-509,590-599` replaces an `import_key` occupant’s body with the generated body and reconstructs its front matter, dropping owner edits and unknown metadata. Ticket 12:86 requires: “if bodies differ, keep the existing body and append the imported body only if it is not already contained.” Parse the occupant, append to its body, and mutate only export-owned YAML nodes.

2. **[P1] Repository basename collisions silently omit a linked remote.** `migration-export.ts:31-44` skips `repositories/<name>.md` whenever that path is occupied, without checking its URL or allocating `-2`. Thus two linked `*/app` repositories, or an unrelated existing `app.md`, leave one link undeclared. Ticket 12:78 requires the commit to contain “`repositories/*.md` for that Workspace’s linked set”; ticket 02:45 says “one file per linked remote.” Reuse the canonical link planner for every URL.

3. **[P1] Legacy URLs can put credentials into Git.** The export writes DB `linkedUrls` verbatim (`migration-export.ts:31-44`) and builds `source` from raw repository URLs (`770-782`), bypassing `linkedRepositoryUrlSchema`. Ticket 02:45 is explicit: “No secrets in git.” Validate/canonicalize legacy URLs before filenames/content/source creation; reject or omit unsafe values.

4. **[P1] Folder-map detection still consumes unrelated instructions.** `folder-map.ts:90-100` accepts one bare path under any heading containing “folder”; e.g. `## Folders to clean\n- \`tmp/\`` becomes the owned map and is deleted when `tmp/` is absent. Ticket 03:37 requires finding “the list of folders + what is in them” and says “Do not rewrite unrelated customer instructions.” Require structure descriptions or an unambiguous marked/semantic section.

5. **[P2] Validity persistence mutates nested alias targets.** `hydrate-write-jobs.ts:169-184` detaches only a top-level `claims` alias; for `template: &c {to: b.md}\nclaims: [*c]`, it resolves `*c` and adds `valid_from` to `template`. Ticket 02:65 says the job fills the claim, while ticket 03:41 says unknown keys are ignored. Clone and replace each aliased claim item before mutation.

Canonical link identity, malformed declaration rejection, root sequence-alias detachment, removed-anchor repair, metadata byte boundaries, no-op tip recording, candidate-SHA hiding, durable hydrate enqueue, and one-commit/replay fences otherwise trace correctly in this checkpoint. The four remaining kinds and declared planner/cap/pause/conflict/alternate-writer/deletion work remain open; this is not Gate 3 acceptance.
