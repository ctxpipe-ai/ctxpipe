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
