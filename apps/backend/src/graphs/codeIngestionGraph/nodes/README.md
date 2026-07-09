# Code Ingestion Graph Nodes

Nodes for the extraction subgraph that analyze repositories and produce extracted objects and claims.

When `roots` includes both `./` and package paths (e.g. `apps/web`), post-processing attributes each submission to the **longest matching root**. Paths that would only match `./` in that situation are **dropped** (unknown monorepo paths). With a single root `["./"]`, everything still resolves to `./`.

## Extractor Table

| Extractor | Objects | Claims | Deduplication Key |
|-----------|---------|--------|--------------------|
| extractKind | Service, App, Library | IMPLEMENTED_IN | svc:, app:, lib: |
| identifyAPIs | API, Operation | EXPOSES_API, HAS_OPERATION | api:, op: |
| identifyAPIClients | API (external) | CONSUMES_API | api:${repositoryId}:${root}:external:${name} |
| identifyDatabases | Database | DEPENDS_ON | db:${repositoryId}:${root}:${dbType} |
| **identifyInfrastructure** | **Infrastructure** | **RUNS_ON** | **inf:${repositoryId}:${root}:${infraType}** |
| identifyStreams | Stream | PRODUCES_TO, CONSUMES_FROM | stream:${repositoryId}:${root}:${streamType} |
| identifyServiceDependencies | — | DEPENDS_ON (Service→Service) | — |
| identifyLibraries | Library | USES_LIBRARY | lib:${repositoryId}:${root}:${libraryName} |
| identifyPatterns | Pattern | IMPLEMENTS_PATTERN | pat:${repositoryId}:${root}:${patternName} |
| extractInstructionUnits | InstructionUnit, Skill | HAS_INSTRUCTION, MEMBER_OF_PRIMARY | inu:${repositoryId}:${root}:${hash}, skl:${repositoryId}:${hash} |

## identifyRoots

Root detection is deterministic-first:

- Parse root workspace manifests via codesearch (`pnpm-workspace`, npm/yarn `workspaces`, `lerna.json`, `rush.json`, `deno.json`, Cargo workspace, `go.work`, `pyproject.toml` uv workspace, Maven/Gradle modules, `workspace.json`).
- Resolve workspace globs against discovered package markers (`package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`, etc.).
- Return confident roots without LLM when manifests resolve cleanly.
- If deterministic detection is ambiguous, run a minimal fallback agent with only `list_files`, `get_file`, and `submit_roots` (`recursionLimit: 100`).
- On fallback-agent failure/missing submit: use deterministic `partialRoots` first, then `["./"]` only when no partial roots exist.

## extractInstructionUnits

Extracts **InstructionUnit** objects from normative docs and agent rule files (`AGENTS.md`, `CLAUDE.md`, `.cursor/rules/**/*.md`, `CONTRIBUTING.md`, `README.md`), then derives **repo-local Skill** objects when ≥2 units share intent + compatible applicability envelope (payload). Uses structured LLM output per file (skipped when `MODEL_PROVIDER_API_KEY` is unset). Build manifests (e.g. `package.json` scripts) are **not** ingested as instruction units here—agents can read those files directly.

- **Dependency/vendor paths:** Instruction candidates under known dependency directory segments are excluded (convention-aware: e.g. `vendor/` but not `internal/vendor/`, root-only `external/`); see [`dependencyVendorPaths.ts`](../../../domain/codeIngestion/dependencyVendorPaths.ts).

- **Evidence (MVP):** The product does not persist evidence rows without a promoted `InstructionUnit`—ingestion either promotes to a unit or skips; there is no separate persisted “evidence-only” store for this slice.

- **Capability** (existing extension) = org/service capability. **Skill** = derived procedural grouping for this repository only.
- **Applicability** is stored on the unit payload only in MVP (no `APPLIES_TO` graph edges).
- **SPECIALIZES** between skills is not emitted in MVP.

**Confidence and source tier (MVP):** Path-based tiers (dedicated agent/rules → docs → other readme-like paths) set a **single scalar** claim `confidence` via `tierBaseConfidence` in code; `sourceType` / `extractionMethod` stay `git` / `llm`. We do **not** pass tier as a separate field into `aggregateConfidence` in this MVP. Rationale: (1) for the usual case—one evidence row per `HAS_INSTRUCTION` claim—the weighted aggregate equals that scalar anyway; (2) splitting tier into `EvidenceInput` would require persisting tier on evidence rows for correct re-aggregation when claims merge. The unit payload and claim `provenance` still carry `source_tier` / `tier` for explainability. A later iteration can align with full multipliers on `aggregateConfidence` once evidence storage carries tier.

**InstructionUnit deduplication key** (idempotency; merges same excerpt scope across re-runs; LLM `name`/`summary` do not affect the key):

1. `content_hash` = first 32 hex characters of SHA-256 over UTF-8 `source_excerpt` (verbatim).
2. `inner` = first 32 hex characters of SHA-256 over UTF-8 string  
   `${repositoryId}:${path}:${root}:${content_hash}`  
   (colon-separated, no braces).
3. Final key: `inu:${repositoryId}:${root}:${inner}`.

Claim paths: `HAS_INSTRUCTION`: subjectRef = `svc:${repositoryId}:${root}`, objectRef = inu key. **Membership**: subjectRef = inu key, objectRef = skl key, predicate = `MEMBER_OF_PRIMARY`.

### `HAS_INSTRUCTION` subject: Service only (MVP)

The ontology allows **Repository** or **Service** as `HAS_INSTRUCTION` subjects; this extractor emits **Service** only (`subjectRef` = `svc:${repositoryId}:${root}`, `subjectKind` = `Service`).

- **Aligned with submission roots:** Units are only created when [`resolveSubmissionRoot`](./extractionSubmissionRoot.ts) returns a concrete root. That matches how other service-scoped extractors attribute claims (same `svc:…` convention as `USES_LIBRARY`, `RUNS_ON`, etc.).
- **Why not Repository here:** In a multi-root monorepo, paths that match only `./` while more specific roots exist are **not attributed** (function returns `null`); those files are skipped entirely, consistent with the README note at the top of this file. Anchoring `HAS_INSTRUCTION` on **Repository** would mean still ingesting those paths and attaching at repo level, which would **break** that attribution rule (double-counting vs package-owned paths). Single-root `["./"]` submissions already get a Service at `./` from `extractKind`, so Service remains the correct anchor.
- **Future:** If product needs repo-level instruction edges without a service root, that should be a deliberate change to submission resolution and projection—not a silent fallback in this node alone.

### Eval (manual / spot checks, MVP)

Lightweight checks—no benchmark harness. Sample a few repos/commits and inspect objects/claims plus logs (`extractInstructionUnits summary`).

- **Precision** — Units match real imperative norms; `source_excerpt` is verbatim; distinct tools/workflows are not merged into one unit.
- **Modality** — `modality` matches normative strength in the doc (e.g. required vs optional); no systematic mis-labeling on a spot sample.
- **Durability / false positives** — Ephemeral or migration-only lines are dropped (`durable: false`, `looksEphemeral`, or filtered); stable rules are kept.
- **Skill coherence** — Where ≥2 units form a Skill, shared intent and applicability tags look right; `MEMBER_OF_PRIMARY` links are sensible.
- **Idempotency** — Re-ingesting the same `targetHash` yields stable deduplication keys (no duplicate InstructionUnits for the same excerpt scope).

## identifyAPIClients

Extracts CONSUMES_API claims (Service → API or Service → Operation) from repository code. Uses an LLM agent with `list_files`, `search`, `get_file`, and `submit_api_clients` tools to detect API clients:

- **HTTP clients** – axios, fetch, ky, got, httpx, requests
- **SDKs** – @stripe/stripe-js, twilio, sendgrid, @supabase/supabase-js (client)
- **OpenAPI clients** – openapi-fetch, @hey-api/openapi-ts
- **Config/env** – API_BASE_URL, STRIPE_KEY, SENDGRID_API_KEY, etc.

For **internal APIs**: emits CONSUMES_API claim to existing `api:${repositoryId}:${root}:${path}` key (from identifyAPIs).  
For **external APIs**: creates API object with `api:${repositoryId}:${root}:external:${name}`, then CONSUMES_API claim.

Runs in parallel with identifyAPIs; internal refs match api: keys from identifyAPIs (same root/path).

## identifyServiceDependencies

Extracts DEPENDS_ON claims (Service → Service) for cross-service dependencies within a monorepo. Uses an LLM agent with `list_files`, `search`, `get_file`, and `submit_service_dependencies` tools. Produces no new objects — Service nodes come from extractKind.

- **Internal package refs** – "@repo/api": "workspace:*", from "@repo/shared"
- **HTTP calls to internal URLs** – localhost, internal hostnames, service discovery
- **Workspace config** – pnpm-workspace.yaml, package.json workspaces, yarn workspaces

Claim path: subjectRef = `svc:${repositoryId}:${consumerRoot}`, objectRef = `svc:${repositoryId}:${providerRoot}`, predicate = DEPENDS_ON

## identifyLibraries

Extracts Library objects and USES_LIBRARY claims (Service → Library) from repository code. Uses an LLM agent with `list_files`, `search`, `get_file`, and `submit_libraries` tools to detect architectural dependencies:

- **ORM** – Prisma, Drizzle, TypeORM, Sequelize, Mongoose, SQLAlchemy, GORM
- **HTTP** – Express, Hono, Fastify, Next.js, FastAPI, Flask, Django
- **Auth** – Better Auth, NextAuth, Passport, Auth0, Clerk
- **Validation** – Zod, Yup, Joi, Pydantic
- **Cache** – ioredis, @upstash/redis, redis-py

Deduplication: `lib:${repositoryId}:${root}:${libraryName}`  
Claim path: subjectRef = `svc:${repositoryId}:${root}`, objectRef = lib key, predicate = USES_LIBRARY

## identifyStreams

Extracts Stream objects and PRODUCES_TO / CONSUMES_FROM claims (Service → Stream) from repository code. Uses an LLM agent with `list_files`, `search`, `get_file`, and `submit_streams` tools to detect message/event streams:

- **Kafka** – kafka-python, confluent-kafka, @nestjs/microservices, sarama, kafkajs
- **RabbitMQ** – amqp, pika, amqplib
- **AWS** – @aws-sdk/client-sqs, @aws-sdk/client-sns, boto3 sqs/sns
- **Redis Pub/Sub** – ioredis publish/subscribe, redis-py pubsub
- **NATS, Pulsar, Google Pub/Sub, Azure Event Hubs, ActiveMQ**

Deduplication: `stream:${repositoryId}:${root}:${streamType}` (submissions are attributed to the **most specific** matching root when `roots` lists both `./` and package paths).  
Stream object payload: `path` is the resolved service root; `submittedPath` is the path(s) from the agent (single string, or `; `-joined if merged).  
Claim path: subjectRef = `svc:${repositoryId}:${root}`, objectRef = stream key, predicate = PRODUCES_TO or CONSUMES_FROM (based on role: producer/consumer/both)

## identifyInfrastructure

Extracts Infrastructure objects and RUNS_ON claims (Service → Infrastructure) from repository code. Uses an LLM agent with `list_files`, `search`, `get_file`, and `submit_infrastructure` tools to detect deployment targets:

- **Docker** – Dockerfile, .dockerignore
- **Docker Compose** – docker-compose*.yml
- **Kubernetes** – k8s/, manifests/, *.yaml with apiVersion: apps/v1, Helm charts
- **Serverless** – serverless.yml, sam.yaml, Cloud Run, Lambda config
- **Terraform / Pulumi** – *.tf, Pulumi.yaml referencing compute (lighter scan)
- **Platforms** – Vercel, Fly.io, Railway, Render, Cloudflare Workers

Deduplication: `inf:${repositoryId}:${root}:${infraType}` (same **most specific root** rule as streams when `./` and package roots coexist). Duplicate submissions for the same key merge **evidence** and collect distinct **paths** in payload `paths` when needed.  
Claim path: subjectRef = `svc:${repositoryId}:${root}`, objectRef = inf key, predicate = RUNS_ON

## identifyPatterns

Extracts Pattern objects and IMPLEMENTS_PATTERN claims (Service → Pattern) from repository code. Uses an LLM agent with `list_files`, `search`, `get_file`, and `submit_patterns` tools to detect architectural patterns:

- **Code structure** – separate read/write models (CQRS), event handlers (Event Sourcing), saga orchestrators, repository interfaces
- **Docs** – ADR, README, architecture diagrams
- **Naming** – *Command, *Query, *Event, *Saga, *Repository, *Factory

Uses lower confidence (0.6) than other extractors due to higher hallucination risk when inferring patterns from code.

Deduplication: `pat:${repositoryId}:${root}:${patternName}`  
Claim path: subjectRef = `svc:${repositoryId}:${root}`, objectRef = pat key, predicate = IMPLEMENTS_PATTERN
