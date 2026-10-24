# Feature flags

Manage Railway feature flags (Signals): typed defaults, targeting rules, and runtime reads via the SDK or GraphQL.

## What they are

Railway feature flags are **project- or workspace-scoped** configuration values resolved at read time from a registry (not environment variables). Each flag has:

- A **type**: `bool`, `string`, `number`, or `json`
- A **default** value used when no rule matches
- Optional **targeting rules** (attribute comparisons and rollout percentages)

Project flags are managed in **Project Settings → Feature Flags**. Workspace flags are visible there read-only.

Runtime apps read **one scope** at a time (`project:<id>` or `workspace:<id>`) via the [TypeScript SDK](https://github.com/railwayapp/railway-ts-sdk) or GraphQL — flags from other scopes are separate registries.

## Agent / MCP workflow

Prefer **Remote MCP** tools when OAuth-scoped project access is enough:

| Tool | Access | Purpose |
|---|---|---|
| `list-feature-flags` | viewer | List project flags; includes workspace flags when present |
| `get-feature-flag` | viewer | Inspect one flag (`scope`: `project` or `workspace`) |
| `set-feature-flag` | admin | Create a flag or update its default |
| `delete-feature-flag` | admin | Delete a project-scoped flag |

Always pass explicit `projectId` (from a Railway URL or `railway status --json`).

```text
List feature flags for project 6adb5ae3-0e3a-4ead-b42c-1fd36f217ffb
```

```text
Set feature flag checkout-v2 on project 6adb5ae3-0e3a-4ead-b42c-1fd36f217ffb to true (bool)
```

For targeting rules and rollouts, use the dashboard UI or GraphQL (`signalRuleSet`) until MCP rule tools exist.

## CLI (when available)

The Railway CLI exposes `railway flag` (alias `railway signal`) for registry CRUD. Upgrade the CLI if the command is missing:

```bash
railway upgrade --yes
railway flag list --project <project-id> --json
railway flag checkout-v2 true --project <project-id>
```

Use `--project` (or link first) so scope is explicit in agent workflows.

## GraphQL fallback

When MCP and CLI are unavailable, use the public GraphQL API (`signals`, `signalCreate`, `signalDefaultSet`, `signalRuleSet`, `signalDelete`) with owner `project:<projectId>` or `workspace:<workspaceId>`. See https://docs.railway.com/docs/feature-flags

```bash
scripts/railway-api.sh '{"owner":"project:<projectId>"}' <<'EOF'
query projectSignals($owner: String!) {
  signals(owner: $owner) { name type default rules version }
}
EOF
```

## Runtime SDK

In deployed services, use the Railway SDK flags module:

```typescript
import { flags } from "railway";

await flags.init({ scope: { projectId: process.env.RAILWAY_PROJECT_ID! } });

const enabled = flags.getBoolean("checkout-v2", {
  targetingKey: userId,
  attributes: { plan: "enterprise" },
});
```

Poll interval defaults are suitable for most apps; flags refresh when registry versions change.

## Do not confuse with

- **Environment variables** — static per-environment config (`railway variable set`). Use flags when you need typed defaults, targeting, and central registry semantics.
- **Priority Boarding / account toggles** — internal beta switches on your Railway account, unrelated to project feature flags.
- **Platform feature flags** — Railway staff tooling only.

## Dashboard

Human-friendly CRUD: open the project → **Settings → Feature Flags**. Workspace-scoped flags appear in a read-only section when they exist.
