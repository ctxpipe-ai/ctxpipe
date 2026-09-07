# Gate 0 integrated journey and diagnostic continuations

All times are UTC on 2026-09-07. Product code is the unchanged PR-head code;
checkout is `23ccd60c496ef6f9453a64c5afefe25c3b0378b1` plus the evidence-only
working changes listed in the instrumented run's configuration record. Real
Better Auth, PostgreSQL, OpenWorkflow, native Git, TanStack, OpenCode and model
provider were used. No owned application modules were replaced.

The user explicitly authorized use of the existing model key. Only that key was
loaded into the isolated backend/worker process environment. No GitHub App
credentials were loaded. Auth accounts, DB passwords and repository are disposable.

## Clean journey attempt

| Tier-5 step | Action / route | Expected | Observed | Evidence |
| --- | --- | --- | --- | --- |
| 1 Create/open workspace (11:51–11:56) | Real signup, organization creation, skip optional connector/invite steps; create workspace from `file:///private/tmp/ctxpipe-gate0-git-fixture/remote` | Hydrated workspace ready for chat | Workspace created, but tip resolution fails for the native local remote. Prepare returns 503; direct send returns a RUN_ERROR requiring stored desired SHA. FAIL | `logs/golden-initial-api.jsonl`, `logs/golden-authorized-backend.log` |
| 2 Home submit exactly once | Home → conversation | One accepted first message | NOT_REACHED in clean attempt: step 1 blocks readiness | Same |
| 3 First text and terminal | Chat | Useful answer and exactly one terminal | NOT_REACHED: step 1 | Same |
| 4 Reload transcript | Conversation reload | Same persisted transcript | NOT_REACHED: step 1 | Same |
| 5 Second turn / same worktree | Send again | Prior context and worktree reused | NOT_REACHED: step 1 | Same |
| 6 Edit / tree / diff | File pane | Saved edit reflected consistently | NOT_REACHED: step 1 | Same |
| 7 Push and PR | Publish | Branch pushed and PR URL | NOT_REACHED: step 1 | Same |
| 8 Backend restart / resume | Restart process | Same session and files | NOT_REACHED: step 1 | Same |
| 9 Close / delete cleanup | Delete conversation | No owned resources remain | NOT_REACHED: step 1 | Same |

A failed clean baseline is not successful golden-journey proof. Local-remote tip
support and GitHub publishing are distinct contracts; the local fixture cannot
prove a live GitHub App installation or successful publish.

## Explicit diagnostic bypasses

The native fixture is a repository with `main`, README naming **Clockwork** and
its `/health` endpoint, plus AGENTS asking the model to read README. Its verified
commit is `c331b30e9b59bb75552eb3c9501d6b499be940c2`. A bare remote lives at the
URL above. The following SQL was applied only to the disposable workspace:

```sql
UPDATE workspaces
SET desired_sha = 'c331b30e9b59bb75552eb3c9501d6b499be940c2'
WHERE id = 'ws_agqhxomnvn3gzh3dvrzciudfjq';
```

The before row is in `golden-initial-api.jsonl`; the resulting row is in the
configuration record of `http-measurements.jsonl`. The real hydrate retry set its
active projection to that SHA, then failed with **`requireCurrentOrgId is not
defined`** (missing import in `models/workspace-write-jobs.ts`). We did not seed
active projection or readiness. The UI nevertheless allowed chat because an
active SHA existed despite failed hydrate status.

| Diagnostic | Timestamp / action | Actual result | Evidence |
| --- | --- | --- | --- |
| Home first message | 11:59:41, one Send action: “What is the service name in README.md? Reply in one short sentence.” | Route committed to `conv_agqhxpikdvyurf3bftgv4h6kuy`; user bubble appeared, no answer. Two prepare POSTs, two chat GETs, two workspace-touch POSTs. No completed chat turn or model proxy request for that first action. Reload removed the user message. | Backend log 11:59:41–42 and browser observation below |
| Direct HTTP send | Before 12:02, separate `conv_gate0_initial_probe` | Prepare 204; actual model read README and answered Clockwork; terminal received in 9727.53 ms | `logs/golden-seeded-api.jsonl` |
| Manual second Send after reload | 12:02:18, “Reply with Clockwork.” in the Home-created conversation | Real WebSocket turn returned Clockwork; title became Clockwork Reply. This does not repair or prove the missing first message. | Backend log `workspace-chat-ws` ending 12:02:27 |
| File pane | 12:04–12:09, open Files then README | Tree shows AGENTS.md and README.md. README pane exposes a label but no usable editor in accessibility/DOM snapshots; API reads are successful. | `browser-observations.md`, request windows |
| Edit and diff diagnostic | 12:09, API file PUT after synthetic writable capability below | PUT/read/diff/status all 200; exactly two added lines and dirty state. Push and PR both 400 `not_github`. | `logs/file-publish-diagnostic.jsonl` contains exact timestamps and responses |
| Restart | 12:09:50 SIGTERM | Backend closed its PG pool but retained listener; auth requests returned 500. New server failed EADDRINUSE. Verified old PID 25692 then SIGKILL; started same command again. | `logs/restart-listener-conflict.log`, `logs/shutdown-failure.log` |
| Resume reads | After restart | Persisted successful manual turn remains. README has reverted to original content and status is clean: saved edit lost. | `logs/restart-diagnostic.jsonl` |

Before the file command diagnostic, the task worker was stopped and only this
fixture's write capability was changed:

```sql
UPDATE workspaces SET write_status = 'writable', read_only_reason = NULL
WHERE id = 'ws_agqhxomnvn3gzh3dvrzciudfjq';
```

This bypass is explicitly **not** proof of native-host write classification.
The original measurement series used `read_only`; the separately named
instrumented series uses this synthetic writable row (full row recorded).

The first 5-cold/20-warm HTTP series uses five conversations, deletes each through
the production API, and records all five 204s. It observes 25 distinct sandbox
directories and sessions. All captured directories were absent after deletion;
post-delete DB/resource observations are archived separately. Do not infer
successful UI cleanup or transcript continuity from a per-turn successful answer.

Final cleanup removed all workspace conversation and sandbox DB rows, but the
empty navigation conversation's provider directory remains after its DELETE.
`navigation-resource-cleanup.json` records `exists: true`; this is a Gate 4 cleanup
follow-up, not successful cleanup proof. The 52 measured/manual directories were
removed. No active browser TCP connection to port 3010 remains in the final
snapshot; listed browser descriptors are CLOSED.
