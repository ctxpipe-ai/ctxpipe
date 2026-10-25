# Configuration in source control

Choose one configuration model before editing files. Never manage the same service with both models.

## Choose the model

Prefer TypeScript Infrastructure as Code when the repository has TypeScript set up. Use `railway.json` only as the fallback for repositories without TypeScript.

Use TypeScript IaC when any of these signals exist in the current project or workspace:

- `.railway/railway.ts` already exists.
- A `tsconfig.json` or another `tsconfig*.json` exists.
- `package.json` declares `typescript`, or the project contains `.ts` or `.tsx` source files.

If none of those signals exist, create or edit `railway.json`. Do not choose `railway.toml` for new agent-authored configuration.

If a TypeScript repository already has `railway.json`, migrate the intended settings to `.railway/railway.ts` and remove the old file before planning. If the user explicitly asks to preserve the existing model rather than migrate, edit the existing file and explain that it remains service-level Config as Code.

The models have different scopes:

| Model | Scope | Applies when |
|---|---|---|
| `.railway/railway.ts` | Whole Railway project: services, databases, buckets, volumes, variables, replicas, domains, and canvas groups | `railway config apply` applies the reviewed project plan |
| `railway.json` | One service's build and deploy settings | The next deployment reads the file; it does not update dashboard settings |

## TypeScript Infrastructure as Code

The desired Railway project state lives in:

```text
.railway/railway.ts
```

`railway config init` and `railway config pull` also create `.railway/README.md`. Railway agent setup installs the shared `use-railway` skill; config commands do not need or create a project-local skill.

### Core rules

1. Express Railway product intent, not internal API details.
2. Do not write Railway UUIDs into `.railway/railway.ts`.
3. Do not write `EnvironmentConfigPatch`, `ServiceInstance`, Backboard internals, or generated Railway domains into source.
4. Prefer helpers such as `service()`, `postgres()`, `redis()`, `mysql()`, `mongo()`, `bucket()`, `volume()`, `group()`, `github()`, and `image()`.
5. Use `service.env.VARIABLE` and `database.env.VARIABLE` for references.
6. Keep secrets out of source. Imported unknown secret values should use `preserve()` or be omitted when the user wants a smaller import.
7. Prefer product DSL names such as `domains`, `replicas`, and `group`; avoid internal names such as `customDomains` and `multiRegionConfig`.
8. Do not add platform defaults unless the user explicitly wants them.
9. After editing `.railway/railway.ts`, run `railway config plan`.
10. Do not run `railway config apply` unless the user explicitly asks.
11. Never use `railway config apply --yes` or `--confirm-destructive` from an agent session without explicit user approval for the exact plan.

### Initialize or import

```bash
railway config init                         # create .railway/railway.ts
railway config init --force                 # overwrite existing generated files
railway config pull                         # import the linked project
railway config pull --force                 # overwrite existing .railway/railway.ts
railway config pull --omit-preserved-variables # omit unknown variable values
railway config pull --json                  # print current graph instead of writing files
railway config pull --agent                 # ask an agent to clean the import afterward
```

If the directory is not linked, the CLI prompts for project and environment in an interactive terminal. In agent workflows, link first or pass explicit project and environment context when supported.

### Authoring

Import the helpers needed by the project:

```ts
import {
  bucket,
  defineRailway,
  github,
  group,
  image,
  mongo,
  mysql,
  postgres,
  preserve,
  project,
  redis,
  service,
  volume,
} from "railway/iac";
```

Common resource patterns:

```ts
const db = postgres("postgres");

const api = service("api", {
  source: github("owner/repo", { branch: "main" }),
  build: "pnpm build",
  start: "pnpm start",
  env: {
    DATABASE_URL: db.env.DATABASE_URL,
    INTERNAL_TOKEN: preserve(),
  },
  domains: ["api.example.com"],
  replicas: 3,
  volumeMounts: {
    "/data": volume("uploads", { sizeMB: 4096 }),
  },
});

const worker = service("worker", {
  source: image("ghcr.io/acme/worker:latest"),
  env: {
    API_HOST: api.env.RAILWAY_PRIVATE_DOMAIN,
    API_TOKEN: api.env.INTERNAL_TOKEN,
  },
});

const media = bucket("media", { region: "iad" });
const backend = group("Backend", [api, worker, db]);
```

Advanced placement can map regions to replica counts:

```ts
const web = service("web", {
  replicas: {
    "us-west2": 2,
    "europe-west4": 1,
  },
});
```

Return every managed resource from the project:

```ts
export default defineRailway(() => {
  const db = postgres("postgres");
  const web = service("web", {
    env: { DATABASE_URL: db.env.DATABASE_URL },
  });

  return project("my-app", {
    resources: [db, web],
  });
});
```

### Plan

Always plan after editing and before applying:

```bash
railway config plan
railway config plan --json
railway config plan --verbose
railway config plan --show-values
railway config plan --detailed-exit-code
```

Plan output summarizes changes in Terraform style:

```text
Plan: 1 to add, 0 to change, 0 to destroy
```

Variable values are redacted by default. Use `--show-values` only when the user accepts the secret exposure risk. For CI drift checks, `--detailed-exit-code` returns `0` for no changes, `2` for pending changes, and another non-zero code for errors.

### Apply

```bash
railway config apply
railway config apply --yes
railway config apply --yes --confirm-destructive
railway config apply --json --yes --confirm-destructive
```

`apply` runs a fresh plan. If remote state changed, Railway rejects the stale apply and requires another plan. In non-interactive or agent sessions, destructive changes require `--confirm-destructive` in addition to `--yes` or `--json`; add it only after the user explicitly approves the exact destructive impact.

### Review checklist

Before applying, confirm:

- The latest plan shows only expected changes.
- The user reviewed the plan and explicitly requested apply.
- Secrets are not replaced with literal placeholders.
- Existing Railway-managed variables are omitted or use `preserve()` when they should remain untouched.
- Custom domains use `domains`, not networking internals.
- Scaling uses `replicas`, not `multiRegionConfig`.
- No generated Railway service domains or Railway UUIDs are committed.

### Troubleshoot TypeScript IaC

- **Service is already managed by `railway.json`**: migrate its intended settings and remove the old file before planning; Railway blocks dual ownership.
- **Plan shows secrets as hidden**: expected. Use `--show-values` only with user approval.
- **Apply says the plan is stale**: run a new plan, inspect it, then apply again only if requested.
- **Destructive apply is blocked**: get explicit approval for the exact plan before adding `--confirm-destructive`.
- **Imported variables use `preserve()`**: Railway could not safely print encrypted values; `preserve()` retains the remote value.
- **Generated code is too literal**: simplify `.railway/railway.ts`, then run another plan.

## `railway.json` fallback

Use this path only when the repository has no TypeScript setup. `railway.json` controls one service's build and deploy settings, not project resources such as databases, buckets, variables, or canvas groups.

Start with the schema so editors validate fields:

```json
{
  "$schema": "https://railway.com/railway.schema.json",
  "build": {
    "builder": "RAILPACK",
    "buildCommand": "npm run build"
  },
  "deploy": {
    "preDeployCommand": ["npm run db:migrate"],
    "startCommand": "npm start",
    "healthcheckPath": "/health",
    "healthcheckTimeout": 300,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 5
  }
}
```

Rules for this fallback:

1. Include only settings the user intends to override. File values override dashboard values for that deployment.
2. Use the canonical schema field names; do not copy internal environment patch names blindly.
3. Keep service variables and secrets out of `railway.json`; manage them with Railway variables.
4. Use `environments.<name>` for environment-specific overrides and `environments.pr` for PR environments.
5. In a monorepo, place the file at the service root or set the service's custom Railway config file path to its absolute repository path.
6. Validate the JSON after editing. A deployment is required for the config to take effect; editing the file does not mutate dashboard settings.

Example environment override:

```json
{
  "$schema": "https://railway.com/railway.schema.json",
  "deploy": {
    "startCommand": "npm start"
  },
  "environments": {
    "staging": {
      "deploy": {
        "startCommand": "npm run staging"
      }
    },
    "pr": {
      "deploy": {
        "startCommand": "npm run preview"
      }
    }
  }
}
```

For the complete field list, use the live JSON schema or Railway's Config as Code reference rather than guessing unsupported keys.

## Validated against

- Docs: [Infrastructure as Code](https://docs.railway.com/infrastructure-as-code), [IaC reference](https://docs.railway.com/infrastructure-as-code/reference), [Config as Code](https://docs.railway.com/guides/config-as-code), [Config as Code reference](https://docs.railway.com/reference/config-as-code)
- CLI source: [config/mod.rs](https://github.com/railwayapp/cli/blob/v5.27.1/src/commands/config/mod.rs), [config/runner.rs](https://github.com/railwayapp/cli/blob/v5.27.1/src/commands/config/runner.rs)
