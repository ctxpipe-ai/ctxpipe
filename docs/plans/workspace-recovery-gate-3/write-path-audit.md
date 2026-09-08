# Gate 3 write-path audit

Checkpoint work after c293853e; this is an open-work inventory, not acceptance.

## Native default writes

All twelve typed workspace workflows call `domain/workspaces/write-broker.ts`. Its native Git push is the only intended default push. Admission now binds and enqueues these workflows even while write access is unavailable; the generic admission fallback is gone. The Files HTTP endpoint waits for durable admission before acknowledging success. It captures repository-scoped write credentials only inside the broker step and fences the binding before publication. Acquisition uses repository-scoped read credentials. Each native workflow now explicitly waits for access without replacing its owner or prepared candidate.

## Remaining alternate writers

- Linear, Notion and Confluence full/incremental parents capture provider files without durable credentials and use native typed mirror children. Slack separates model intent, deterministic thread capture and native child publication before posting success. Config PR behavior remains.
- Each new mirror carries the captured config blob identity, including absence. Native acquisition, no-op/semantic refresh and broker publication reject captures after that scope changes. Old commands without that required identity fail schema validation instead of acquiring current scope implicitly.
- Native failed Slack mirror children now publish a terminal failure and fall back to a reply when updating the working message fails. The status projection distinguishes failed native workflow steps from suspension; no private exception detection or second retry owner is used. Notion refresh commits the org row before directory projection.
- Notion, Linear and Confluence finalizers require the captured repository and branch, lock or compare-and-swap the connection row, and cannot mark a newly rebound target live after an old push. Native post-push barriers prove this race; full generation/config/provider identity and terminal setup failure projection still need closure.
- Complete connector setup failure projection and full binding CAS on finalization before acceptance. Confluence completed provider failures now leave initial setup as sync_failed, and partial fetch failures preserve orphaned files; space events cannot delete another space. Review provider-state sync markers and failure/retry publication as part of the remaining lifecycle work.
- The generic workspace-write-commit workflow, write runner, write-job agent, generic transforms and unused worktree execution helpers are deleted. Native CLI discovery verifies the typed workflows remain and the generic writer is absent. The legacy sandbox handle types/registry are still used by conversation and explorer paths pending their own migration.
- `services/github/installation-write-client.ts`: unrestricted `commitFiles` remains public. Its retained config-PR caller must have a strict non-default guard. `getOrInitializeBaseBranch` can initialize a default branch outside the typed bootstrap path and must migrate.
- `domain/workspaces/conversation-publish.ts`: injects an installation token in a URL executed inside the agent sandbox and uses force-with-lease. Both conversations and files routes supply unrestricted installation tokens. Move session-branch publication outside the agent environment, capture native Git objects, revalidate actual default/binding and keep the explicit session-branch exclusion.

## Remaining read credential paths

`services/github/installation-write-client.ts` uses unrestricted installation clients even for file/tree/ref/commit/PR reads. `domain/workspaces/fetch-github-commits.ts` also reads through one. `domain/codeIngestion/queue.ts` and `graphs/codeIngestionGraph/nodes/reindex.ts` obtain unrestricted installation tokens. `models/github-mcp-config-pr.ts` is a retained config-PR control plane but requires repository scope and default exclusion. Review all `getInstallationToken` and `getInstallationOctokitForOrg` production consumers after migration.

## Protected-default conversation compatibility

The native broker exposes a default-branch protection denial as binding-fenced read-only status with the existing protection reason. Conversation edit/publish policy now distinguishes that default-only restriction from actual repository permission loss. The session runtime passes the resulting session-branch permission to the agent. Workspace responses expose `conversationWritable`, and UI file/publish controls consume that capability with a fallback for older responses. Real HTTP/PostgreSQL/native-handle proof verifies protected-default edits, the authoritative capability and actual permission-loss denial. Session push credentials and ownership still require the publisher migration listed above.

## Remaining automatic planning

Five typed kinds are durably planned after hydrate with independent caps and shrinking-remainder checks. Rename planning uses the previous immutable tree and actual Git similarity result. Extraction needs canonical source inputs. Migration export now durably reserves capped bootstrap/import-key follow-ups after completion, including no-op/replay. Cleanup requires current-binding completed cutover, and current export/cutover lookups exclude earlier bindings. Export completion and path-assignment projection now precede hydration on direct, no-op and semantic-child outcomes; completed-job replay recovers the missing idempotent enqueue. Native timestamp and restored-crash-boundary proofs cover this ordering. Existing obsolete path heuristics and generic runner follow-ups must be removed when the native replacements are wired.
