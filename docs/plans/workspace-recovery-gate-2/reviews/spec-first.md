# Gate 2 Spec review — first pass

Candidate `45c9c1d583a95a74dccf86ec480f8ad30cccf2b9` vs base `d87858354a783a9fd95c46785208c9b699a45e3b`. This is an initial review, not terminal.

## Missing / partial requirements

- **[P1] Connection-only relink never creates or hydrates the new revision.** Gate 2 requires one revision model and a relink/generation-race proof (spec 621–635); ADR032 says a same-SHA relink is a new revision (12–14). Yet `relinkWorkspaceLifecycle` defines `changed` only from URL changes and schedules hydrate only when it is true (`workspace-lifecycle.ts:132–175`), while `updateWorkspace` writes a changed `githubConnectionId` without incrementing generation or clearing SHA/branch (`models/workspaces.ts:727–784`). The published projection can therefore remain bound to the old connection indefinitely.

- **[P1] Tip writers still bypass the single full-identity policy.** The spec requires immutable revision resolution in one product-policy function and forbids callers constructing contradictory revisions (625, 637–640). `persistResolvedDesiredSha` CASes only workspace id/generation/URL/old SHA and updates SHA alone (`models/workspaces.ts:927–953`); it does not fence connection or branch. The webhook calls this directly (`github-workspace-tip.ts:171–188`), so a concurrent connection/branch change can accept a tip resolved under another identity. This also leaves the acknowledged duplicate webhook producer unresolved.

- **[P1] Linked-tip publication lacks captured owner/connection identity.** The required relink/generation-race proof (633–635) and ADR032’s complete desired-identity CAS (13) are not met: `persistLinkedDesiredSha` checks only link id and old SHA (`models/workspaces.ts:1238–1258`). A removed/recreated/reassigned link can receive a tip resolved for stale URL/ref/credential context.

- **[P2] The new canonical value remains provider-specific.** Gate 2 says to delete provider-specific repository models (630–631), but `WorkspaceRevision.remote` canonically exposes `githubConnectionId` (`revision.ts:3–16`) rather than a provider-neutral connection identity. This is not merely a legacy database-column mapping.

- **[P2] Mutable workspace checkout admission is not explicitly legacy.** ADR032 permits `ws:<workspaceId>` only for explicit legacy projections (17–19), but any signed token with `workspaceId` and no revision claims selects it (`codesearch/auth/jwt.ts:18–39`). The auth shape cannot distinguish intentional legacy reads from accidentally unbound active calls, leaving an obsolete contradictory-reader path contrary to spec 630–640.

## Unasked behavior

No material product behavior beyond Gate 2 was identified; UI and dependency edits inspected were type/proof compatibility work.
