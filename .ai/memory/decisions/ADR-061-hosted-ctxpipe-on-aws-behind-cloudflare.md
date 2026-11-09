# ADR-061: Hosted ctxpipe on AWS (us-west-2) behind Cloudflare

**Status:** Proposed (draft for the CTO's review, 2026-11-07) | **Date:** 2026-11-07 | **Tags:** infra, aws, cloudflare, pulumi, aurora, agentcore, previews, observability, security

## Context

Hosted ctxpipe runs on Railway (compute), Neon (Postgres) and Vercel Sandbox (chat and ingestion sandboxes). A POC partner asked for a stated region, fewer sub-processors and a self-host story ([CTX-1117](https://linear.app/ctxpipe/issue/CTX-1117)). Railway had a security incident that exposed environment variables ([CTX-982](https://linear.app/ctxpipe/issue/CTX-982)). Railway and Neon cost about $570 a month (cost telemetry, 7 days to 2026-11-07).

The AWS organization already exists (factory repo, `machines/aws-core`). It has management, production (empty), factory, selfhost-sandbox and archive accounts. It has Identity Center, SCPs, an org CloudTrail and CDK bootstrap restrictions. The SCP allows us-west-2 and us-east-1 only.

The AgentCore and Aurora facts below come from the AWS documentation (read 2026-11-07). A local test cloned large public repositories with our ingest clone flags. The test container had 2 vCPU and 8 GB. Linux needed 2.2 GB of disk and less than 2.8 GB of memory. Other large monorepos needed about 0.5 GB of disk each.

## Decision

**Edge and accounts**

1. Cloudflare is the only public entry point. Traffic goes through a Cloudflare Tunnel to AWS. No AWS resource accepts public inbound traffic. The factory moves behind the tunnel too: the hub's public ALB goes away, people use WARP and Zero Trust, and Cloudflare owns all of `ctxpipe.dev`.
2. The domain follows the audience and the account follows the data. `ctxpipe.ai` is public. `ctxpipe.dev` is internal behind Access, with public webhook paths only.
3. The first region is us-west-2. The stack takes a region parameter for a later second stamp.
4. Production and observability run in the production account. Previews run in a separate preview account in its own OU. The factory account holds no customer data.
5. Pulumi (TypeScript) manages all hosted infrastructure: AWS (production, previews, observability), Cloudflare (DNS, tunnels, Access, WARP) and the GitHub environments. It lives in the factory repo. Each account keeps its Pulumi state in its own S3 bucket, encrypted with KMS; we do not use Pulumi Cloud. Each environment, and each preview, is one Pulumi stack. Each deploy role is scoped to its environment and has a permission boundary, because Pulumi calls the AWS APIs with that role. The organization stays in CDK (`machines/aws-core`). The public `@ctxpipe/aws-cdk` construct stays CDK and is not used by hosted: it is optimized for simple, single-tenant self-hosting. Hosted and self-host share only the container images and the environment contract. The ctxpipe repo only pushes images to ECR. ECR tags are immutable, and each deploy pins its images by digest. Only builds of `main` push to the production account. PR builds push to the preview account with a different role. All deploys run from the factory repo.

**Production**

6. Backend and UI on Fargate ARM. A cloudflared sidecar in each backend task replaces a load balancer.
7. The worker is one Fargate Spot task that scales up on queue depth. It does not scale to zero.
8. Aurora PostgreSQL 17 Serverless v2, writer only, with a minimum of 0.5 ACU. It does not pause. No RDS Proxy. A customer-managed KMS key from day one, because a cross-account clone cannot use the default RDS key.
9. FalkorDB and the codesearch query server run on one plain EC2 instance (ECS, EC2 launch type) with gp3 EBS volumes. Recovery is a runbook: restore the snapshot, then redeploy.
10. S3 is the codesearch cold tier: durable Zoekt shards in S3, the EBS volume is an LRU cache. Indexing stays on the host.
11. Outbound traffic goes through a NAT instance with a fixed Elastic IP.
12. Email goes through SES. Secrets are in Secrets Manager. All secrets get new values at cutover, except the connection-secret encryption key. That key stays because it got a new value after the Railway incident ([CTX-983](https://linear.app/ctxpipe/issue/CTX-983)), and the incident did not expose it. The design owner accepts the residual risk: a person who gets this key can decrypt the stored connector tokens from any database copy.
13. GuardDuty runs in every account. AWS Backup copies Aurora and the EBS volumes to the archive account each day (35 days).

**Sandboxes**

14. AgentCore Runtime V2 microVMs replace Vercel Sandbox, one session for each conversation or ingest shard. A repository-size cap replaces a second compute type.
15. The backend reaches a session only through `InvokeAgentRuntime` and `InvokeAgentRuntimeCommand` over PrivateLink. No session endpoints. A resource policy, an SCP and the VPC endpoint condition let only backend roles invoke.
16. The sandbox reaches the backend's tool bridge and model proxy over the private network, through Agent Vault, as in self-host ([ADR-049](ADR-049-self-host-chat-sandbox-stock-docker.md)). Agent Vault is the only egress proxy of the sandbox. Sandbox subnets have no internet route. They reach Agent Vault and the VPC endpoints for ECR, logs and AgentCore.
17. The V2 memory snapshot holds only our shim. OpenCode starts after the restore. Secrets in the sandbox come from `/dev/urandom` per request.
18. A conversation resumes from git: a fresh clone of the Workspace repository and a private conversation ref. An S3 base bundle is added only if the clone is slower than about 3 s. Hosted ctxpipe stops the creation, selection and cleanup of Workspace bases (Vercel snapshots). The Docker Workspace base stays for self-host.

**Previews**

19. `factory preview up <PR>` starts a factory workflow with a `preview-deploy` role in the preview account.
20. Production shares its cluster with the preview account through AWS RAM. AWS allows one cross-account clone for each account. Thus the preview account keeps one preview source clone. Each preview is a same-account copy-on-write clone of that source.
21. Shared parts deploy once: the network, the tunnel and one preview AgentCore runtime. A preview is one small Pulumi stack with three parts: its ECS services, one tunnel route and one clone. The preview workflow runs it through the Pulumi Automation API, and `factory preview down` destroys the stack.
22. A preview keeps the isolation that `.github/workflows/pr-deploy.yaml` enforces today:
    - It does not build a PR from a fork.
    - Each preview gets its own `AUTH_SECRET` and its own connection-secret encryption key. Connection secrets that the clone copies from production do not decrypt on a preview.
    - Previews use the preview GitHub App, not the production app.
    - Each clone gets new passwords for its database roles. The clone copies the production passwords, and a preview does not use them.
    - The `Production` and `Preview` environments never share a token, key or secret.
    - The preview source is not scrubbed. Like the Neon preview branches of today, it keeps the session tokens and the OAuth tokens (`sessions`, `accounts`) that it copies from production. The design owner accepts this residual risk. Unreviewed PR code can read these tokens. It can replay a copied session token against the production app, and it can use a copied OAuth token against a customer's provider. The account boundary does not stop these two effects; it only keeps PR code away from AWS resources of the production account.
23. Cloudflare Access protects `pr-N.ctxpipe.dev`. Access lets `/mcp`, the OAuth paths and the webhook path through, because those clients cannot do an Access login. The app's own auth protects these paths.
24. At most 15 previews exist at a time. A preview is deleted on PR close, or 3 days after the last `preview up`. A warm pool of paused clones is added only if the spike shows that a clone and its instance take more than about 3 minutes.

**Observability**

25. HyperDX (ClickStack) is the only observability tool. Langfuse goes away. Spans keep the prompt text. Traces stay 30 days.

## Alternatives not taken

- **Previews in the production account.** Rejected: a separate account costs only about $10 a month more. The preview network needs its own NAT and endpoints in both designs. An account boundary keeps unreviewed code out of the production account.
- **Previews in the factory account.** Rejected: previews hold customer data, and the factory account holds none.
- **Filtered preview data.** Rejected: copy-on-write clones cannot filter, and previews must hold real data for debugging.
- **Neptune for the graph.** Rejected for now: FalkorDB isolates each organization in its own graph, and [CTX-996](https://linear.app/ctxpipe/issue/CTX-996) replaces FalkorDB later.
- **EFS for stateful services.** Rejected: EBS is about four times cheaper per GB, and git and Zoekt work better on a local disk.
- **CDK for hosted, with Terraform for Cloudflare.** Rejected: two tools; CloudFormation is too slow for a stack for each preview (a V2 runtime and its endpoint took about 13 minutes in the spike, and two failed deploys stopped in `ROLLBACK_FAILED`); and composing the self-host construct would push multi-tenant and cost features into a product for single-tenant self-hosters.
- **Terraform or OpenTofu for hosted.** Rejected: one tool too, but a stack for each preview is clumsy to drive from code (CDKTF is deprecated), and HCL is weaker than TypeScript for the conditional parts. ADR-013 picked Terraform for self-hosters' sake; that reason does not apply to internal infrastructure.
- **AgentCore session endpoints.** Rejected: they are public only, and a resource policy cannot name their action.
- **AgentCore Instances compute type, ASG self-healing, worker scale-to-zero, a separate indexer.** Rejected in the simplicity audit. Each adds machinery for a need that we did not measure.
- **RDS Proxy, an ALB, a NAT gateway, an Aurora reader.** Rejected for cost at our load. Each one is a small IaC change if the load grows.

## Consequences

- Sub-processors become AWS, Cloudflare and OpenRouter, plus Vercel for the marketing site and docs only.
- Production costs about $300 a month, plus AgentCore usage. Previews cost about $40 to $45 a month fixed, plus about $8 for each 3-day preview. The aws-core budgets change to match, with a new preview budget.
- The stateful host and the NAT instance are single instances. A loss means up to 4 hours of degraded search and graph, or a short outbound outage. Both have runbooks.
- Unreviewed preview code runs in the preview account, which holds a copy of customer data. For AWS resources, the account boundary is the security boundary. It does not cover the copied session and OAuth tokens: decision 22 records that accepted risk. The production account shares only the cluster (through RAM), its KMS key and read access to the artifact buckets.
- Telemetry holds customer prompt content for 30 days. The data map ([CTX-1175](https://linear.app/ctxpipe/issue/CTX-1175)) must say so.
- Hosted infrastructure does not shape `@ctxpipe/aws-cdk`. A hosted feature goes into the construct only when self-hosters need it too.
- A failed Pulumi update does not roll back: the stack stays partial, and we fix forward. Production changes are additive and run in a preview first.
- After cutover: [ADR-013](ADR-013-switch-infra-from-pulumi-to-terraform.md) (for hosted infrastructure), [ADR-029](ADR-029-railway-us-east-next-to-neon.md), [ADR-038](ADR-038-self-hosted-clickstack-langfuse.md), [ADR-039](ADR-039-production-image-deploys-one-environment.md) and [ADR-054](ADR-054-secrets-sync-from-github-to-railway.md) are superseded. [ADR-048](ADR-048-native-postgres-sandbox-ownership.md) and [ADR-049](ADR-049-self-host-chat-sandbox-stock-docker.md) are amended. `infra/`, `ops/infra`, the Railway scripts, `railway-wake.ts`, the Vercel sandbox provider and the Langfuse files are deleted.
- aws-core gains a preview account and OU. The factory `modify-aws` account table changes to match.
