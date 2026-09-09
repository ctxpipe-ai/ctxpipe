# Gate 4 Spec review — `f185020b`

## Findings

No blocking Spec findings in the focused correction.

The three findings from `0f207a22` are resolved:

- New allocations still let native `gitSource` land the default branch, but `chat-runtime.ts:38-48` now requires the captured SHA to exist or be fetched, checks it out detached, and only then creates the session branch. Failures propagate; the manual clone and `|| true` fallback are gone. `workspace-chat-prepare-native.contract.test.ts:79-124` covers a default branch advanced beyond the captured SHA.
- `conversation-publish.ts:122-136` now compares the captured SHA at the final pre-push fence. Normalizing access remains consistent with the separate read sandbox and `publish-session` admission intents, while lines 138-144 independently require current edit permission. The new credential-issuance race asserts no remote push.
- `conversation-files.ts:45-68` selects a row matching current binding and SHA before using heartbeat order only to produce a stale diagnostic. Both publication routes capture the desired revision first. The two-revision test covers a newer heartbeat on the nonmatching row.

The static `WORKSPACE_CHAT_TOOLS` catalogue is data-free. Each execution validates the native server context, enters the scoped org transaction, reads the current workspace projection, and propagates missing or cross-tenant data errors (`workspace-chat-tools.ts:615-642`). Tool construction no longer performs projection/search work or catches failures to an empty catalogue. Retired callbacks and legacy key helpers have no pinned callers; their deleted fake-provider tests are replaced by retained native exact-key, prepare, chat, and publication contracts.

Previously reviewed PG store/lock, cleanup retry, HTTP chat, and role-translation behavior is unchanged. Warm definition/GitHub work, base snapshots/forks, active attach, WebSocket restart/offsets, simultaneous sends, deletion-versus-allocation, Railway, and full CI remain the declared Gate 4 acceptance work.
