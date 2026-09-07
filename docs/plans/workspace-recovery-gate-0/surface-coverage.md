# Gate 0 build and deployment surface coverage

`pnpm -r --workspace-concurrency=2 --no-bail --if-present build` invoked every
declared build script: backend, codesearch, UI, docs, CLI and AWS CDK. Backend and
codesearch failed; other builds passed. `logs/builds.*` retains complete output.
This command does not claim packages without a build script were compiled.

| Affected surface | Executed baseline / evidence | Limit |
| --- | --- | --- |
| Backend + worker | Full tsc, default tests plus explicit excluded files and RLS, migrations, real HTTP/WS backend and OpenWorkflow worker | Product failures retained; no deployed production backend |
| Codesearch | tsc failure; full default Docker indexer test lane and OOM simulation | No live production Kubernetes ingest; manual Kubernetes memory lane is separate |
| UI | tsc, Vite build, Vitest, Storybook build and 371 real browser stories; integrated CUA attempt | 24 story failures, failed clean journey |
| Docs | Next.js production build | No publication |
| CLI | Production build,93pass1skip, full `check` tsc including tests | Live memory eval not enabled |
| AWS CDK library | Build with stamp prebuild;32tests | No AWS deployment |
| Self-host example | Full tsc; `logs/typecheck-extra-surfaces.*` | No declared build script; synth/deploy/E2E needs AWS configuration and is not claimed executed |
| Forge reference | Manifest/README/generator and backend tests inspected | No build/test script or local src tree; Forge deploy/install is not baseline local validation |
| OTEL collector | Dockerfile/config/README inspected | No package scripts; collector image/config startup not executed in this baseline |
| Terraform infra | README and tf sources inspected | No package or test scripts; no Terraform plan/apply and no infrastructure mutation |
| Root scripts/CI | Scope collector and runner CLI fixtures; shell checks | Existing CI filtering/skips are Gate1 work |
| Migrations / connectors | Exact base→head and fresh migrations; backend suites include connector models/workflows | Classification does not convert owned-module mocks into proof |

All authoritative changed paths remain in `changed-files.txt`; package omission
from a script is explicit here. The baseline records affected declared commands,
not successful production deployment of every runtime. Existing external deploy
prerequisites and the missing validation surfaces above remain visible for Gate1's
CI completeness and Gate6's CDK/codesearch acceptance work.


The default backend Vitest configuration excludes ingestionRetraction.integration
and mcp.conformance; the package command additionally excludes RLS. RLS ran
explicitly earlier. The final review caught the other two omissions, now executed
through `vitest-excluded-baseline.config.mjs` preserving the original setup and
removing only excludes: MCP conformance **2 pass**; ingestion retraction **4 fail**
at fixture insertion due to row-level security. Those four failures are not
passing ingestion behavior proof. See `logs/tests-backend-excluded.*`. Thus all
235 tracked backend test files have an execution lane recorded.
