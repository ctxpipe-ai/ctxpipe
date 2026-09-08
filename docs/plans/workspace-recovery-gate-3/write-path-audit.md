# Gate 3 write-path audit

Checkpoint work after a6273f0c; this is an open-work inventory, not acceptance.

## Native default writes

All twelve typed workspace workflows call `domain/workspaces/write-broker.ts`. Its native Git push is the only intended default push. It captures repository-scoped write credentials only inside the broker step and fences the binding before publication. Acquisition uses repository-scoped read credentials. Each native workflow now explicitly waits for access without replacing its owner or prepared candidate.

## Remaining alternate writers

- Linear full and incremental parents now capture files without durable credentials and use `step.runWorkflow` for the typed native connector child. Config-PR behavior remains. Complete connector setup failure projection/finalization and binding-race audit before acceptance.
- Notion `services/notion/sync.ts`: full and incremental content call `commitFiles`.
- Confluence `services/confluence/sync.ts`: captured content calls `commitFiles`.
- Slack `services/slack/sync.ts`: mention capture calls `commitFiles`.
- Legacy `openworkflow/workflows/workspace-write-commit.ts`: generic write runner still calls `commitFiles`; delete after remaining callers migrate.
- `services/github/installation-write-client.ts`: unrestricted `commitFiles` remains public. Its retained config-PR caller must have a strict non-default guard. `getOrInitializeBaseBranch` can initialize a default branch outside the typed bootstrap path and must migrate.
- `domain/workspaces/conversation-publish.ts`: injects an installation token in a URL executed inside the agent sandbox and uses force-with-lease. Both conversations and files routes supply unrestricted installation tokens. Move session-branch publication outside the agent environment, capture native Git objects, revalidate actual default/binding and keep the explicit session-branch exclusion.

## Remaining read credential paths

`services/github/installation-write-client.ts` uses unrestricted installation clients even for file/tree/ref/commit/PR reads. `domain/workspaces/fetch-github-commits.ts` also reads through one. `domain/codeIngestion/queue.ts` and `graphs/codeIngestionGraph/nodes/reindex.ts` obtain unrestricted installation tokens. `models/github-mcp-config-pr.ts` is a retained config-PR control plane but requires repository scope and default exclusion. Review all `getInstallationToken` and `getInstallationOctokitForOrg` production consumers after migration.

## Protected-default conversation compatibility

The native broker exposes a default-branch protection denial as binding-fenced read-only status with the existing protection reason. Conversation edit/publish policy now distinguishes that default-only restriction from actual repository permission loss. The session runtime passes the resulting session-branch permission to the agent. Workspace responses expose `conversationWritable`, and UI file/publish controls consume that capability with a fallback for older responses. Real HTTP/PostgreSQL/native-handle proof verifies protected-default edits, the authoritative capability and actual permission-loss denial. Session push credentials and ownership still require the publisher migration listed above.

## Remaining automatic planning

Five typed kinds are durably planned after hydrate with independent caps and shrinking-remainder checks. Rename planning uses the previous immutable tree and actual Git similarity result. Extraction needs current source/path-assignment inputs, and migration export needs ordered bootstrap/import-key follow-up. Existing obsolete path heuristics and generic runner follow-ups must be removed when the native replacements are wired.
