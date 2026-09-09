# Gate 4 progress

Gate 3 closed at 20cf0791 with full CI 34295857469 and both review axes at zero blockers; closure docs 83465ae6 pushed. Gate 4 remains in progress; no Gate 4 checkpoint pushed yet.

## Native ownership

- Exact-key red: native Postgres conformance 7/7 passed; two revision cases failed because missing keys attached to other revisions and new keys overwrote old native identities. Removed both fallbacks. Drizzle-generated migration 20260909011559_daffy_squadron_supreme removes obsolete conversation uniqueness. Green: 9/9.
- Native Postgres LockStore uses short RLS transactions, owner tokens, renewal and expiration, without held SQL connections. Drizzle-generated migration 20260909011959_material_ben_urich applied with standard app-role grants.
- Crash proof: independent Bun clients serialize; SIGKILL holder; takeover after lease expiry; fresh client acquires after release. PASS, 31.52 seconds. Initial green attempt hung because fixture stdin stayed open; closing it fixed fixture shutdown.
- Renewal/loss proof: holder remains exclusive beyond initial 30-second lease; contender cancellation works; deleting ownership aborts the callback and caller controller. PASS, 43.23 seconds.
- Docker replica/restart proof: independent Bun processes with different Docker allocation names and the same native key reuse one actual container; a fresh process reads previous work; native teardown removes it. PASS, 11.50 seconds.

## Production prepare and stock chat

- Both prepare and chat now supply the Postgres native locks and matching org tenant context. Prepare explicitly matches native middleware's optional tenant fields; chat uses the authenticated conversation id as thread id.
- Removed process-cached provider/definition use from chat and prepare. Native ensure owns reuse; every call gets current credentials.
- Production prepare regression failed because a second local prepare destroyed the first worktree (stored provider name comparison mismatched the effective provider). Removed that parallel ownership check. Native prepare now preserves an unsaved file and refreshes clone credential A to B: PASS, 6.27 seconds.
- Prepare returns its native handle directly; prepare/Files branch checkout receives it explicitly. Authenticated warm Files → push proof: PASS, 8.91 seconds (targeted selection).
- Native chat fixture uses real Postgres, Git, OpenCode and the production model proxy; only external model responses are deterministic local HTTP. Two turns preserve the prepared sandbox, all four transcript messages, exact native reconstruction and one terminal event per turn.
- Removed custom stream filtering, terminal synthesis, timeout/drain choreography and manual persisted-run completion from production chat. Stock two-turn proof PASS, 10.63 seconds. Initial fixture runs failed only on incorrect reconstructChat arguments and missing explicit user message ids; these are not claimed production red tests.
- First wiring types found three recursive fixture-inference errors, fixed with explicit child-client return type. Next types found only a reconstructChat fixture call error, since corrected. Final grouped types pending.

## Persisted binding and focused commands

- Drizzle-generated migration `20260909024334_wild_silverclaw` adds the immutable WorkspaceRevision to native instance records. Definition identity includes the complete binding; different generations preserve distinct worktrees. Optional clone-token presence no longer changes native workspace identity. `native-optional-credential-reuse`: 2/2 passed.
- Files and both publication routes now read captured binding from Postgres and resume through native ensure. Tree/status GET and publish never allocate a missing worktree. Removed branch-metadata writes from runtime resolution; publication rechecks still precede metadata changes. `native-publication-binding-recheck`: 16/16 passed.
- Removed the process registry and renamed the remaining focused provider cleanup commands to `workspace-sandbox-cleanup.ts`. Cleanup uses the same native key lock, verifies provider disappearance, retains failed identities, and permits retry. Native prepare → Files save/read → failed cleanup → retry → missing GET passed in `native-http-chat-role-fix` and `native-conversation-post-cleanup`.
- Removed custom heartbeat/drain/terminal wrappers from both HTTP entry points. Native POST now covers authenticated runtime resolution, actual OpenCode/model proxy, two turns, exact assistant text, one terminal, unsaved work preservation, secret scrubbing, and native reconstruction. `native-post-agui-envelope`: 2/2 passed. The earlier POST attempt omitted required AG-UI `tools` and `context` fixture fields; its 400 was a fixture error.
- Native red `native-http-chat-files` found the OpenCode translator emitted user parts as assistant text. A reproducible package patch classifies parts by OpenCode message role, including buffered parts before their metadata. Green `native-http-chat-role-fix`: 3/3. No prompt-text heuristic remains. Remove this patch when an upstream release passes the retained native exact-text proof.
- Frozen offline install accepted the patch-only lockfile. Whole backend types `types-native-route-checkpoint`: 132 acknowledged diagnostics, zero new diagnostics.
- CI partition after staging all retired tests: 194 backend + 42 required contracts, zero overlaps/missing files. The required-contract ceiling matches backend's 30-minute ceiling because native lease expiry/renewal and publication checks are now mandatory. This does not add duplicate test execution.

## Remaining

Gate 4 is not complete. Warm turns still reconstruct sandbox definitions and resolve GitHub metadata; native base snapshots/forks and provider selection remain to be finished. Active-run restart/resume and simultaneous-send proof are outstanding. Cleanup enumerates persisted rows, so allocation concurrent with conversation/workspace deletion needs a separate race proof/fix before closure. Legacy message compatibility and remaining catch-empty paths still require audit.

Native OpenCode adapter 0.3.4 explicitly does not journal runs and refuses durable attach. Latest official 0.4.4 was inspected and has the same gap; upgrading alone cannot satisfy active-run restart. `opencode-native-attach-gap` and the retained native contract pin refusal without executing the prompt again. An upstream implementation or narrow package patch with deletion condition is required; no application-owned journal/engine is authorized by the accepted design. Railway access remains undiscovered; the credential-location question is pending while independent work continues.

Milestone two-axis review and full CI are pending. Gates 5–6 have not started.

## Milestone review corrections and static tools

- Two-axis review of `83465ae6...0f207a22`: Standards 0 blockers / 2 nonblocking heuristics; Spec found three revision defects. Reports are retained beside this ledger.
- Native captured-SHA regression reproduced a newer default-tip checkout under the old key. Setup now pins the captured commit before making a session branch and propagates a missing-commit/fetch failure. Deleted the manual clone fallback. Exact captured-SHA preparation passes while the remote default has advanced.
- Native publication tests reproduced desired-SHA change during write-credential issuance and selection of another revision's newer heartbeat. The final push fence now compares the captured SHA; publication chooses a matching binding/SHA before considering stale rows for diagnostic errors. Access intent normalization remains necessary (`publish-session` input versus write-admission intent); current edit permission is independently checked. All 18 publication cases plus 2 prepare and 9 setup checks pass in `native-review-revision-green` (29/29).
- Static `WORKSPACE_CHAT_TOOLS` is built once. No projection query or tool-list rebuild precedes a turn. Each actual invocation loads a tenant-scoped published projection and reports unavailable data explicitly. Native scope isolation + shared HTTP chat tests pass (8/8, `native-chat-static-checkpoint`); whole backend types `types-corrected-tool-schemas`: 132 acknowledged, zero new.
- Removed unused heartbeat callbacks, old sandbox identity helpers and their fake-provider tests, and moved the SSE parser into its native test. Exact native store/prepare/chat tests own these invariants. The remaining Data Clumps review heuristic is nonblocking.

The milestone is ready for narrow correction review; full CI and authorized push follow that review. This remains an intermediate Gate 4 checkpoint.
