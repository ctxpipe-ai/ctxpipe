# Spec coverage — Gate 3 eleven-kind checkpoint

## Identity and method

- Base `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`; target `07c6459cc260a5be65183ab3cc1d485815d0fb5b`.
- Commits, oldest first: `e7c18bd8`, `09e34dc6`, `f7119635`, `46aaecab`, `398e5f18`, `1ced7198`, `10039ec0`, `07c6459c`.
- Used the required three-dot diff/log and pinned `git show TARGET:path`, `git grep TARGET`, and `git ls-tree TARGET`. The untracked review skill was read from `.agents/skills/code-review/SKILL.md`; repository source/spec reads were pinned. No repository mutation or heavy test suite was run.
- Supplied evidence: 48 tests across nine native/characterization/discovery suites; full backend types with 141 acknowledged existing diagnostics and none new/stale; CI `34218496795` pending.

## Requirement matrix

| Requirement | Result | Pinned evidence |
| --- | --- | --- |
| Eleven typed registered workflows | Pass for implemented slice | enqueue dispatch, extract/mirror workflow definitions, workflow discovery and required-contract manifest |
| Extract is a separate native command/commit | Pass structurally | `workspace-extract-ingest.ts` owns acquire/transform/stage/validate/commit/push/publish/hydrate/complete |
| Extract source and Git data survive worker loss | Pass for current legacy source | OpenWorkflow source step serializes maps to arrays; acquired native pack is step data; no directory/credential is durable |
| Preserve owner body/metadata and omit cutover key | Partial | YAML merge preserves body/unknown fields and removes the key; Finding 1 shows removal destroys cross-job path identity for non-preferred/colliding objects |
| Extract no-op/convergence | Fail on adversarial layouts | Finding 1; supplied proof covers only one object already at its preferred path |
| Mirror immutable command | Pass when writable | strict schema, persisted files/deletes/provider/connection/repository/revision, completed-command equality checks |
| Mirror paused intent metadata | Fail | Finding 2; enqueue fallback omits `mirror`, while paused reconstruction depends on it |
| Mirror path/config safety | Pass | repository-relative path schema rejects empty/dot/dotdot/backslash/NUL/`.git`; provider-root and exact config exclusion; duplicate write/delete rejection |
| Binary semantics | Pass | canonical base64 validation, byte decoding/comparison, native blob staging, existing mode preservation |
| Provider binding | Pass for executing writes | org/type/connection/repository/branch/enabled/setup phase/repository URL/GitHub connection checked at acquire, before write credential, and after credential issuance |
| At most one commit/no-op/replay | Pass except Finding 1 across separate extract jobs | fixed native tree/parent/subject/time; prepared SHA before push; completed mapping; remote ancestry replay; refreshed no-op |
| Actual default/CAS/non-FF | Pass for implemented broker behavior | live desired binding and remote branch/tip checks; ordinary native `git push` rejects non-FF; no force/PR path |
| Lost push acknowledgement after later advance | Pass | remote descendant ancestry test precedes stale-tip failure; publication hydrates canonical descendant containing prepared commit |
| Hydration completion fence | Pass | both new workflows enqueue hydrate with job-scoped idempotency key before marking completed |
| Invalid mirror command admission | Pass for writable admission | subtype schema runs before bound row; native proof covers config/path/base64 rejection. Unwritable typed validation belongs with declared pause completion work |
| Prior five Spec fixes | Pass | all Markdown rename scope; canonical relative resolver; changed labels/duplicate destinations; optional confidence preserved; malformed legacy links filtered |
| Alias-comment Standards fix | Pass | shared `materializeMetadataAlias` copies `comment` and `commentBefore`; rename/maintenance/export callers use it; native regression recorded |
| Fixture author identity / obsolete mock deletion | Pass | fixture config sets local name/email; old enqueue mock suite removed and native public-boundary proofs replace it |
| Semantic merge, planner/caps/follow-ups, complete pause/conflict, provider callers, alternate writers/credentials, generic runner deletion | Open, declared | excluded from discovery count and terminal acceptance |

## Changed interfaces and callers traced

- **Command/schema:** `GitFileChange`/`repositoryFilePathSchema`/byte decoder; `ConnectorMirrorSource`; `WorkspaceWriteCommand.mirror`; job payload DB type; enqueue schema, intent serializer, paused reconstruction, immutable row binding, completion equality.
- **Git path:** `stageGitFiles` callers across all typed workflows; mode lookup, blob creation, delete/index/tree validation, deterministic commit identity; `write-broker` acquire/push/publish/no-op, binding checks and ancestry.
- **Extract:** public enqueue snapshot map; migration source model; completed-export SHA; planner/path allocator/YAML helpers; pack reader; workflow discovery and native contract. Production extraction-to-command planning remains declared open.
- **Mirror:** all four provider binding readers plus repository identity reader; strict admission; workflow transform/no-op/stage; broker rechecks; binary/config/delete/replay/reset/invalid tests. Pinned production search confirms provider sync callers still use their prior paths, as declared.
- **Prior repairs:** native rename candidate scope/resolver/occurrence matching/alias materialization; migration confidence and malformed-link filtering; helper callers in claims, validity, cleanup and export.
- **Operational/test/config:** workspace job schema/model, OpenWorkflow queue/reconciliation, tip-check paused caller, workflow discovery, native fixture author, deleted mock suite, contract manifest/diagnostic allowlists/status/logs.

## Finding count

Two correctness findings, both P1. Worst issue: post-cutover extraction can detach an unchanged legacy object from its established Git path and create repeated duplicate commits.
