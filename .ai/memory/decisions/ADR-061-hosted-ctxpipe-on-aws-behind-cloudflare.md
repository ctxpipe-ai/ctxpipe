# ADR-061: Hosted ctxpipe on AWS (us-west-2) behind Cloudflare

**Status:** Proposed (draft for the CTO's review, 2026-11-07) | **Date:** 2026-11-07 | **Tags:** infra, aws, cloudflare, pulumi, aurora, agentcore, previews, observability, security

## Context

Hosted ctxpipe runs on three providers. Railway runs the compute. Neon runs Postgres. Vercel Sandbox runs the chat and ingestion sandboxes. A POC partner asked for a stated region and fewer sub-processors ([CTX-1117](https://linear.app/ctxpipe/issue/CTX-1117)). The partner also asked for a self-host story. Railway had a security incident that exposed environment variables ([CTX-982](https://linear.app/ctxpipe/issue/CTX-982)). Railway and Neon cost about $570 a month (cost telemetry, 7 days to 2026-11-07).

The AWS organization already exists (factory repo, `machines/aws-core`). It has management, production (empty), factory, selfhost-sandbox and archive accounts. It has Identity Center, SCPs, an org CloudTrail and CDK bootstrap restrictions. The SCP allows us-west-2 and us-east-1 only.

The AgentCore and Aurora facts below come from the AWS documentation (read 2026-11-07). A local test cloned large public repositories with our ingest clone flags. The test container had 2 vCPU and 8 GB. Linux needed 2.2 GB of disk and less than 2.8 GB of memory. Other large monorepos needed about 0.5 GB of disk each.

## Decision

**Edge and accounts**

1. Cloudflare is the only public entry point. Traffic goes through a Cloudflare Tunnel to AWS. No AWS resource accepts public inbound traffic. The factory moves behind the tunnel too. The hub's public ALB goes away. People use WARP and Zero Trust. Cloudflare owns all of `ctxpipe.dev`.
2. The domain follows the audience and the account follows the data. `ctxpipe.ai` is public. `ctxpipe.dev` is internal behind Access, with public webhook paths only.
3. The first region is us-west-2. The stack takes a region parameter for a later second stamp.
4. Production and observability run in the production account. Previews run in a separate preview account in its own OU. The factory account holds no customer data.
5. Pulumi (TypeScript) manages all hosted infrastructure. All deploys run from the factory repo.
    - Scope: AWS (production, previews, observability), Cloudflare (DNS, tunnels, Access, WARP) and the GitHub environments.
    - State: each account keeps its Pulumi state in its own S3 bucket. We do not use Pulumi Cloud.
    - Secrets in the state: the `awskms://` secrets provider encrypts them, with a key of that account.
    - Access to the state: only the deploy role and the read-only plan role of the account can read the bucket and use the key. Workload roles, for example preview tasks, cannot.
    - High-value secrets stay out of the Pulumi state, so that the plan role can read the state safely. AWS manages the Aurora master password. Secrets Manager generates the application secrets. A `Production` job writes the tunnel tokens, and Pulumi never reads them.
    - Stacks: each environment is one Pulumi stack. Each preview is one Pulumi stack too.
    - Deploy roles: each one is scoped to its environment and has a permission boundary. Pulumi calls the AWS APIs with that role.
    - OIDC trust: a deploy role trusts only its GitHub environment (`Production`, or `preview` for `preview-deploy`), and that environment admits only `main`. Only the plan role trusts pull requests.
    - Approvals: the normal path needs no manual approval. `pulumi preview` runs on each pull request with the read-only plan role. An agent merges a pull request when the merge gate passes. `pulumi up` then runs from `main`.
    - The plan role reads only metadata (`Describe*`, `List*`), the state bucket and the state key. Its boundary denies data reads: objects outside the state bucket, log events, secret values, and other keys.
    - The plan job gets a Cloudflare token with only DNS, Access and zone read. It has no tunnel right, so it cannot read a tunnel's run token. The plan job gets no GitHub token with write rights.
    - **Rule: normal deploy credentials cannot change a guard.** The normal deploy role, the normal Cloudflare token and the normal GitHub token cannot change:
        - IAM boundaries, role trust to other accounts, or a role without the workload boundary (no path to more rights);
        - aws-core: the organization, identity and SCPs;
        - cross-account resource policies: the RAM share, and the key and bucket policies that the preview account can use;
        - the tags and the deletion protection of protected resources, or delete such a resource;
        - Cloudflare Access policies, any tunnel and its ingress, and DNS records of `ctxpipe.dev` (a Cloudflare token cannot be scoped to single host names, so the normal token has no tunnel right and no DNS edit on `ctxpipe.dev`);
        - GitHub environments, branch rules and admin settings.
    - A separate job holds those rights. A person approves each run of it. Only that job holds the Cloudflare edit token, the GitHub admin token and the production secret values.
    - Defaults that close: deny-by-default Access apps on `ctxpipe.dev` and `*.ctxpipe.dev`, and every tunnel's ingress ends with a 404 catch-all.
    - Code owners and a branch rule hold the guard code for a person's review:
        - the policy pack and the list of protected resources;
        - the Access, tunnel and internal-host code;
        - the deploy workflows.
    - The policy pack blocks a replace or a delete of a protected resource.
    - The organization stays in CDK (`machines/aws-core`).
    - The public `@ctxpipe/aws-cdk` construct stays CDK, for simple, single-tenant self-hosting. Hosted does not use it. Hosted and self-host share only the container images and the environment contract.
    - Images: the ctxpipe repo only pushes images to ECR. It loses its deploy trust in the production account and keeps only an ECR push role. ECR tags are immutable. Each deploy pins its images by digest.
    - Image accounts: only builds of `main` push to the production account. PR builds push to the preview account, with a different role.

**Production**

6. Backend and UI on Fargate ARM. A cloudflared sidecar in each backend task replaces a load balancer. Every production image runs on arm64 (Graviton). An image that does not run on arm64 is a bug ([CTX-1234](https://linear.app/ctxpipe/issue/CTX-1234)).
7. The worker is one Fargate Spot task that scales up on queue depth. It does not scale to zero.
8. Aurora PostgreSQL 17 Serverless v2, writer only, with a minimum of 0.5 ACU. It does not pause. No RDS Proxy. A customer-managed KMS key from day one, because a cross-account clone cannot use the default RDS key.
9. FalkorDB and the codesearch query server run on one plain Graviton EC2 instance (ECS, EC2 launch type) with gp3 EBS volumes. Recovery is a runbook: restore the snapshot, then redeploy.
10. S3 is the codesearch cold tier: durable Zoekt shards in S3, the EBS volume is an LRU cache. Indexing stays on the host.
11. Outbound traffic goes through a NAT instance with a fixed Elastic IP.
12. Email goes through the SES API with the task role, not SES SMTP: SMTP needs an IAM user with access keys. Self-host keeps SMTP. Secrets are in Secrets Manager. All secrets get new values at cutover, except the connection-secret encryption key. That key got a new value after the Railway incident ([CTX-983](https://linear.app/ctxpipe/issue/CTX-983)). The incident did not expose it, so it stays. The design owner accepts the residual risk: a person who gets this key can decrypt the stored connector tokens from any database copy.
13. GuardDuty runs in every account. AWS Backup copies Aurora and the EBS volumes to the archive account each day (35 days).

**Sandboxes**

14. AgentCore Runtime V2 microVMs replace Vercel Sandbox, one session for each conversation or ingest shard. A repository-size cap replaces a second compute type. Production invokes a named runtime endpoint, so that a new sandbox version needs an explicit promote and can roll back at once. Previews use the `DEFAULT` endpoint, which follows the newest version by itself.
15. The backend reaches a session only through `InvokeAgentRuntime` and `InvokeAgentRuntimeCommand` over PrivateLink. No session endpoints. A resource policy, an SCP and the VPC endpoint condition let only backend roles invoke.
16. The sandbox reaches the backend's tool bridge and model proxy over the private network. It goes through Agent Vault, as in self-host ([ADR-049](ADR-049-self-host-chat-sandbox-stock-docker.md)). Agent Vault is the only egress proxy of the sandbox. Sandbox subnets have no internet route. They reach Agent Vault and the VPC endpoints for ECR, logs and AgentCore. Each of these endpoints has a policy that allows only resources and principals of this account (`aws:ResourceAccount`, `aws:PrincipalAccount`). The S3 gateway endpoint allows only the ECR layer bucket.
17. The V2 memory snapshot holds only our shim. OpenCode starts after the restore. Secrets in the sandbox come from `/dev/urandom` per request.
18. A conversation resumes from git: a fresh clone of the Workspace repository and a private conversation ref. An S3 base bundle is added only if the clone is slower than about 3 s. Hosted ctxpipe stops the creation, selection and cleanup of Workspace bases (Vercel snapshots). The Docker Workspace base stays for self-host.

**Previews**

19. `factory preview up <PR>` starts a factory workflow with a `preview-deploy` role in the preview account.
20. Production shares its cluster with the preview account through AWS RAM. AWS allows one cross-account clone for each account. Thus the preview account keeps one preview source clone. Each preview is a same-account copy-on-write clone of that source.
21. Shared parts deploy once, from the production-gated edge and preview-base stacks:
    - the network
    - one wildcard DNS record and one tunnel rule for the preview host names
    - the Access apps
    - a router in the preview VPC that sends each host name to its preview
    - one preview AgentCore runtime

     The router runs its own preview tunnel with its own token. Only the router task can read that token. The preview account never holds the production tunnel token. A preview is one small Pulumi stack with two parts: its ECS services and one clone. A preview stack holds no Cloudflare credential. Thus a compromised preview workflow cannot change the production tunnel or the Access policies. The preview workflow runs the stack through the Pulumi Automation API. `factory preview down` destroys the stack.
22. A preview keeps the isolation that `.github/workflows/pr-deploy.yaml` enforces today:
    - It does not build a PR from a fork.
    - Each preview gets its own `AUTH_SECRET` and its own connection-secret encryption key. Connection secrets that the clone copies from production do not decrypt on a preview.
    - Previews use the preview GitHub App, not the production app.
    - Each clone gets new passwords for its database roles. The clone copies the production passwords, and a preview does not use them.
    - The `Production` and `Preview` environments never share a token, key or secret.
    - The preview source is not scrubbed. It keeps the session tokens and the OAuth tokens that it copies from production (`sessions`, `accounts`). The Neon preview branches of today do the same. The design owner accepts this residual risk. Unreviewed PR code can read these tokens. It can replay a copied session token against the production app. It can also use a copied OAuth token against a customer's provider. The account boundary does not stop these two effects. It only keeps PR code away from the AWS resources of the production account.
23. Cloudflare Access protects `pr-N.ctxpipe.dev`. Access lets `/mcp`, the OAuth paths and the webhook path through, because those clients cannot do an Access login. The app's own auth protects these paths.
24. At most 15 previews exist at a time. A preview is deleted on PR close, or 3 days after the last `preview up`. A warm pool of 1 to 2 paused clones keeps the first `preview up` short. In the spike, a clone and its instance took 8 to 8.5 minutes. An idle preview resumes in about 13 seconds on its first request.

**Observability**

25. HyperDX (ClickStack) is the only observability tool. Langfuse goes away. Spans keep the prompt text. Traces stay 30 days.

## Alternatives not taken

- **Previews in the production account.** Rejected: a separate account costs only about $10 a month more. The preview network needs its own NAT and endpoints in both designs. An account boundary keeps unreviewed code out of the production account.
- **Previews in the factory account.** Rejected: previews hold customer data, and the factory account holds none.
- **Filtered preview data.** Rejected: copy-on-write clones cannot filter, and previews must hold real data for debugging.
- **Neptune for the graph.** Rejected for now: FalkorDB isolates each organization in its own graph, and [CTX-996](https://linear.app/ctxpipe/issue/CTX-996) replaces FalkorDB later.
- **EFS for stateful services.** Rejected: EBS is about four times cheaper per GB, and git and Zoekt work better on a local disk.
- **CDK for hosted, with Terraform for Cloudflare.** Rejected for three reasons. It is two tools. CloudFormation is too slow for a stack for each preview: in the spike, two failed deploys stopped in `ROLLBACK_FAILED`. Composing the self-host construct would push multi-tenant and cost features into a product for single-tenant self-hosters.
- **Terraform or OpenTofu for hosted.** Rejected. It is one tool too. But a stack for each preview is clumsy to drive from code, and CDKTF is deprecated. HCL is also weaker than TypeScript for the conditional parts. ADR-013 picked Terraform for self-hosters. That reason does not apply to internal infrastructure.
- **AgentCore session endpoints.** Rejected: they are public only, and a resource policy cannot name their action.
- **AgentCore Instances compute type, ASG self-healing, worker scale-to-zero, a separate indexer.** Rejected in the simplicity audit. Each adds machinery for a need that we did not measure.
- **RDS Proxy, an ALB, a NAT gateway, an Aurora reader.** Rejected for cost at our load. Each one is a small IaC change if the load grows.

## Consequences

- Sub-processors become AWS, Cloudflare and OpenRouter, plus Vercel for the marketing site and docs only.
- Production costs about $300 a month, plus AgentCore usage. Previews cost about $40 to $45 a month fixed, plus about $8 for each 3-day preview. The aws-core budgets change to match, with a new preview budget.
- The stateful host and the NAT instance are single instances. A loss means up to 4 hours of degraded search and graph, or a short outbound outage. Both have runbooks.
- Unreviewed preview code runs in the preview account, which holds a copy of customer data. For AWS resources, the account boundary is the security boundary. It does not cover the copied session and OAuth tokens: decision 22 records that accepted risk. The production account shares three things with the preview account, each with a narrow grant:
    - the cluster, through RAM;
    - the cluster's KMS key: the key policy lets only the `preview-deploy` role use it, and only through RDS (`kms:ViaService`);
    - read access to the codesearch shard prefix and the FalkorDB backups: only the preview FalkorDB and codesearch task roles can read them.
- Telemetry holds customer prompt content for 30 days. The data map ([CTX-1175](https://linear.app/ctxpipe/issue/CTX-1175)) must say so.
- Hosted infrastructure does not shape `@ctxpipe/aws-cdk`. A hosted feature goes into the construct only when self-hosters need it too.
- A failed Pulumi update does not roll back: the stack stays partial, and we fix forward. Production changes are additive and run in a preview first.
- After cutover: [ADR-013](ADR-013-switch-infra-from-pulumi-to-terraform.md) (for hosted infrastructure), [ADR-029](ADR-029-railway-us-east-next-to-neon.md), [ADR-038](ADR-038-self-hosted-clickstack-langfuse.md), [ADR-039](ADR-039-production-image-deploys-one-environment.md) and [ADR-054](ADR-054-secrets-sync-from-github-to-railway.md) are superseded. [ADR-048](ADR-048-native-postgres-sandbox-ownership.md) and [ADR-049](ADR-049-self-host-chat-sandbox-stock-docker.md) are amended. `infra/`, `ops/infra`, the Railway scripts, `railway-wake.ts`, the Vercel sandbox provider and the Langfuse files are deleted.
- aws-core gains a preview account and OU. The factory `modify-aws` account table changes to match.
