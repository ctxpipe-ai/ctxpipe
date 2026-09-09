# Gate 3 correction Spec coverage — `842e41bd`

## Boundary

- Cumulative review reused: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...d3ba7e591ecb557ca1e5c3da96ec9e99d0dd1f67`
- Focused correction: `d3ba7e591ecb557ca1e5c3da96ec9e99d0dd1f67...842e41bdeb68fc796d8a810a1dc17ccbf0d448e8`
- Commit: `842e41bd Gate 3: preserve root instruction authority and remove retired intent APIs`
- Read-only: pinned `git show`, `git diff`, and `git grep`; no implementation edits or test execution.
- Reused cumulative report: `/private/tmp/gate3-d3ba-closure-spec-coverage.md`.

## Prior Spec blocker

| Check | Pinned result |
|---|---|
| Removed APIs | `persistLastJobAt`, `persistWriteJobIntent`, `persistWriteJobStart`, and `countWriteJobAttempts` are absent from target `workspace-write-jobs.ts`. |
| Caller search | Repository-wide exact-name search over apps/packages/scripts returns no result. |
| Remaining job creation | Product insertions are confined to `persistBoundWriteJob`, `persistUnbornBootstrapJob`, and `reserveHydrateWrites` paused reservations. All workflow callers use the typed command persistence functions. |
| Requirement | Recovery plan Gate 3 line 651 explicitly requires deletion of superseded write-intent/runner choreography. |
| Assessment | Previous P1 closed. No alternate native job owner remains. |

## Root and linked source authority

- `extraction-source.ts:49-127`
  - Workspace-repository extraction rejects a linked declaration and calls `assertSourceClaimsOnly(revision, pack, "AGENTS.md")`.
  - Linked extraction still proves the first canonical path and captured exact blob against the parent revision, then invokes the same claims-only guard for candidate content.
  - The guard treats `pack.sha === revision.sha` as unchanged, reads both versions otherwise, permits a file absent in both, rejects creation/removal asymmetry, and compares the body plus every parsed metadata key except `claims`.
  - Exact byte equality takes the fast path. Parsed comparison allows formatting-only front-matter changes in principle, but production metadata mutation preserves unrelated YAML nodes; the locked requirement protects body bytes and metadata values, which this boundary enforces.
- Broker interaction reused from cumulative review:
  - initial authority validation precedes write-token issuance;
  - final authority validation follows credential I/O and immediately precedes native push;
  - no-op refresh validates the current acquired tree;
  - semantic handoff retains extraction identity, and the semantic child returns through the same broker check.
- Adversarial behavior inspected in `write-extraction-admission-native.contract.test.ts`: root metadata, body, and deletion attempts exercise the real broker and assert unchanged remote plus zero write credentials. Existing linked URL/branch/custom/body/canonical-path cases remain.
- Claimed native evidence (not rerun): 25/25 authority and metadata cases.

## Plain-body preservation

- `knowledge-metadata.ts:54-73` preserves existing front-matter delimiter/newline style and suffix bytes.
- For a file without front matter, the correction changes `---\n\n<body>` to `---\n<body>` after the closing delimiter. Parsing removes that one structural newline and yields the exact original body; an original leading newline remains part of the body.
- This satisfies ADR-033 line 46’s instruction-body byte-preservation rule and avoids changing plain root instructions beyond the inserted metadata envelope.

## Regression and scope assessment

- No default push, write credential, workflow admission, connector, or provider code changed in the correction.
- Cumulative A–F source coverage and the d3ba ownership inventory therefore remain applicable.
- Reported evidence retained: native authority/metadata 25/25, backend types 132 with zero new diagnostics, policy 441 test/config files and 27 command files.
- Full CI is pending and remains a separate Gate 3 closure condition.
- Gate 4 conversation-handle migration and pre-upgrade resource cleanup remain later-gate scope.

## Counts

- Previous Spec P1: closed.
- New Spec findings: 0.
- Gate status from this review: code/spec correction passes; overall Gate 3 completion awaits CI and the other required closure review.
