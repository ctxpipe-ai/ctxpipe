# Gate 3 Linear-native checkpoint — Spec review

**Pinned range:** `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...db628699f5b15a7fba03589fbfbe7746b54a723e`
**Decision:** fail for implemented scope — 1 high-priority finding.

## Finding

**[P1] A mirror captured under an older `linear/config.yaml` can publish after a newer config — `apps/backend/src/openworkflow/workflows/linear-sync-content.ts:77-93,149-160`; `linear-sync-entity.ts:81-97,175-188`; `apps/backend/src/domain/workspaces/connector-mirror.ts:54-76`; `apps/backend/src/openworkflow/workflows/workspace-connector-mirror.ts:209-225`.** Both parents correctly read config from an immutable target before provider I/O, but the child command retains only provider/connection/repository identity. Its binding checks cannot distinguish two config revisions on the same connection/repo/branch. If config B merges while a slow config-A fetch is running, the A child treats the advanced tip as an ordinary semantic handoff and can apply A's stale full-delete set or entity upsert after B's child; the last stale child can therefore leave Git inconsistent with the activated scope while both parents report success.

ADR-022 lines 13–16 require **“`linear/config.yaml` in the selected context repository as the only scope store”** and define activated scope as that file **“on the configured target branch after merge.”** ADR-033 line 24 requires parents to **“capture the bound target revision before fetching provider content.”** Carry the captured config blob identity (or equivalent immutable scope identity) into the mirror command and recheck it at no-op/semantic/push reconciliation. If the config blob changed, discard/replan that provider capture rather than rebasing its delta. Add an interleaving proof with two config revisions and reversed child completion.

## Reviewed scope

The prior no-op access-loss P1 is fixed: validation ignores write status but retains full binding and live-revision checks, so an already-present result completes without a write credential. Rename planning binds the immediately previous same-binding projection SHA to the current immutable tree, preserves it through reservation/resume, deduplicates replay, and uses native Git similarity. Linear credentials are reloaded only inside provider steps and are absent from durable context/child inputs. Declared remaining Gate 3 work was excluded; this is not gate acceptance.
