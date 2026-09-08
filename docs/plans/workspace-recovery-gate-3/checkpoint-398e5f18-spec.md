# Gate 3 seven-kind Spec review

Reviewed pinned `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...398e5f186007e603fe878afc7ce7bbe9eddf3640`. This is an intermediate seven-kind review, not Gate 3 acceptance.

## Findings

1. **[P1] Linking can commit credentials from the submitted URL.** The lock says repository declarations contain “No secrets in git” (`02-hydration-contract.md:42-46`). The HTTP route derives a credential-free normalized URL for checks (`workspace-linked-routes.ts:170-190`) but enqueues `body.gitUrl` (`:192-200`); `changeLinkedRepository` writes that raw value verbatim into YAML (`link-declarations.ts:17-39`). A request such as `https://token@github.com/acme/app.git` or a signed query therefore persists the secret in the immutable command and default-branch history. Reject credential-bearing URLs and bind/write only a validated, sanitized canonical URL.

2. **[P1] Folder discovery still deletes an ambiguous customer instruction list.** The spec says the ops agent finds the map “by meaning” and “Do not rewrite unrelated customer instructions” (`03-knowledge-file-layout.md:34-37`). The corrected detector rejects a keyword alone, but accepts the first arbitrary heading whose direct body has one bullet beginning with a folder link/code span (`folder-map.ts:79-103`), then removes it when that path is absent (`:120-143`). Thus `## Cleanup rules` followed by ``- `tmp/` must never be committed`` is claimed as the folder map and deleted. Require stronger positive folder-map evidence; preserve ambiguous sections and append the dedicated marked section.

3. **[P2] GitHub URL case variants bypass one-remote identity.** The contract requires one file per linked remote and treats duplicate Git URLs as malformed extras (`02-hydration-contract.md:42-46`). Both link matching (`link-declarations.ts:17-28`) and hydrate duplicate detection (`hydrate.ts:59-75`) compare `normalizeWorkspaceRepositoryUrl`, which normalizes the GitHub host but preserves owner/repository case (`slug.ts:87-112`). Consequently `github.com/Acme/App` and `github.com/acme/app` become two active linked entries; the route’s self/duplicate checks have the same issue (`workspace-linked-routes.ts:171-185`). Compare the existing canonical repository identity (GitHub owner/repo case-insensitively) across route, transform, and hydrate.

The prior display-name, exact-directory-instruction, orphan-marker, and permanent-`LINKS_TO` findings are corrected with native proofs. Common command/broker/replay/publication behavior remains sound for the implemented slice.
