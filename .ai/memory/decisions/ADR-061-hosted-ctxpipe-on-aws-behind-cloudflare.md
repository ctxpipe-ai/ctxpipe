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
4. Production and observability run in the production account. Preview applications run in a separate preview account in its own OU. Preview databases stay in the production account (decision 20). The factory account holds no customer data.
5. Pulumi (TypeScript) manages all hosted infrastructure. All deploys run from the factory repo.
    - Scope: AWS (production, previews, observability), Cloudflare (DNS, tunnels, Access, WARP). The CTO manages the GitHub environments, branch rules and admin settings by hand, so no pipeline holds a GitHub admin token.
    - State: each account keeps its Pulumi state in its own S3 bucket. We do not use Pulumi Cloud.
    - Secrets in the state: the `awskms://` secrets provider encrypts them, with a key of that account. The guard stack (edge) uses a separate key.
    - Access to the state: the deploy role of the account can read and write the state and use the state key; the read-only plan role can only read it. Only the guard role can read or write the prefix of the guard stack and use its key. The plan role cannot. Workload roles, for example preview tasks, can read no state.
    - High-value secrets stay out of the Pulumi state, so that the plan role can read the state safely. AWS manages the Aurora master password. The production application secrets keep their current values (decision 12): a person copies them into Secrets Manager once, at the cutover. Secrets Manager generates only the secrets of new resources and of previews. The guard job writes the tunnel tokens, and Pulumi never reads them.
    - Stacks: each environment is one Pulumi stack. Each preview is one Pulumi stack too.
    - Projects: `machines/hosted` holds production. `machines/previews` holds every preview stack: `base`, `pr` and `data` (decision 21). aws-core holds only the core of the organization (the CTO, 2026-11-12). The code-owner list of decision 5 names it. aws-core also keeps the governance of the management account: the org CloudTrail, Access Analyzer, the budgets and the cost monitor. Every other resource inside an account lives in a Pulumi machine. `machines/observability` holds the observability stack, so that a failed `hosted` update does not block it. The edge stack has its own folder.
    - Configuration:
        - Each stack's `Pulumi.<stack>.yaml` holds its plain values: the account, the region, the sizes and the host names. It holds no secret.
        - The production image digests are in `machines/hosted/Pulumi.production.yaml`. Deploys are continuous and event-driven, with no polling. A build of ctxpipe `main` pushes an image to the production ECR. An EventBridge rule on that push then calls GitHub's `workflow_dispatch` for the factory digest workflow, through an EventBridge API destination. That workflow opens the pull request that changes the digests. It changes only the `images` key, and a check fails the pull request if it changes another line. The digest workflow ignores digests in its dispatch input: it reads each digest from the production ECR. The GitHub token of the API destination has only `actions:write` on the factory repo. It lives in the EventBridge connection in the production account, the guard job writes it, and no repo code can read it. The ctxpipe repo holds no credential for the factory repo. An agent merges the pull request when the merge gate passes. Thus `main` always holds what runs, and a change to the infrastructure only does not roll back an image.
        - Values cross a stack boundary by fixed names, not by stack outputs. For example, the ECS task definition of `hosted` refers to the tunnel token by its fixed secret name, and Pulumi never reads the value. Also, the edge stack finds the SES DKIM tokens with an AWS lookup. A stack reads the outputs of another stack only in the same backend and at the same trust level: a preview stack reads `previews/base`.
        - The preview workflow gives each preview stack its configuration when it runs: the PR number, the image digests and the clone endpoint. No file holds the configuration of one preview.
        - `machines/hosted`, `previews/base` and `previews/pr` share one package of components. The edge stack does not import it, because the guard job loads it.
    - Deploy roles: each one is scoped to its environment and has a permission boundary. Pulumi calls the AWS APIs with that role.
    - OIDC trust: a deploy role trusts only its GitHub environment (`Production`, or `preview` for `preview-deploy`), and that environment admits only `main`. It also trusts only its named workflow files on `main` (`job_workflow_ref`). A credentialed workflow has no `workflow_call` trigger, so another workflow cannot call it and use its pin. GitHub puts `job_workflow_ref` into the OIDC token of every job, also of a workflow that is not reusable: a probe workflow showed this on 2026-11-11. Thus another workflow in the same environment cannot assume the role. Only the plan role trusts pull requests.
    - Approvals: the normal path needs no manual approval. `pulumi preview` runs on each pull request with the read-only plan role. An agent merges a pull request when the merge gate passes. `pulumi up` then runs from `main`.
    - The plan role reads only metadata (`Describe*`, `List*`), the state bucket and the state key. Its boundary denies data reads: objects outside the state bucket, log events, secret values, and other keys.
    - Accepted security risk (the CTO, 2026-11-10): `pulumi preview` runs unreviewed pull-request code with the plan role. Thus a pull-request author can read the production Pulumi state and AWS metadata. The state holds no high-value secret, the guard state and key are out of reach, and the repo takes no forks. The real diff lets the policy pack block a replace or a delete of a protected resource before the merge.
    - The plan job gets no Cloudflare token, because it previews no stack with a Cloudflare resource. It gets no GitHub token with write rights.
    - **Rule: normal deploy credentials cannot change a guard.** The normal deploy role and the normal GitHub token cannot change:
        - IAM boundaries, role trust to other accounts, or a role without the workload boundary (no path to more rights);
        - aws-core: the organization, identity and SCPs;
        - cross-account access. The preview path of decision 21 is the only exception. It uses its own previews role, not the normal deploy role.
        - the tags and the deletion protection of protected resources, or delete such a resource;
        - any Cloudflare resource. No normal job holds a Cloudflare token with edit rights. The edge stack holds all DNS records of both zones, the tunnels and Access, and only the guard job runs it;
        - GitHub environments, branch rules and admin settings.
        - the deploy dispatch path: the EventBridge connection, every API destination and rule that can use it, and their target. The target is fixed to the factory digest workflow on `main`;
    - aws-core changes deploy only through the code-owned `aws-core.yml`. A separate guard job holds only the edge rights: Cloudflare, the tunnel tokens and the deploy dispatch path. It runs from `guard.yml` on `main` only. The guard role trusts only that workflow file on `main`. Only the guard role can read the edge tokens (the Cloudflare edit token and the Google OAuth client secret), which are in production Secrets Manager. The guard role cannot read the production app secrets. A person copies those into Secrets Manager once, at the cutover.
    - A guard change merges on the merge gate, like other code. The guard role and the separate guard state key limit what a guard job can reach.
    - Accepted security risk (the CTO, 2026-11-10): a change that passes the merge gate can change `guard.yml` or the gate scripts and thus use the guard role. It then reaches the Cloudflare edit token, the edge stack and the deploy dispatch path. The CTO does not treat edge configuration as really sensitive. The nightly audit finds such a change after the merge.
    - The guard job runs the edge stack (Access, tunnels, internal DNS) and writes the tunnel tokens. The edge stack has its own state prefix and key, which only the guard role can use. The guard job runs `pulumi preview` before `up`, and the policy pack blocks a replace or a delete of a protected resource.
    - The phase plans hold the exact guard details: IAM conditions, file lists and token scopes. A security review checks them in each phase pull request.
    - Defaults that close: deny-by-default Access apps on `ctxpipe.dev` and `*.ctxpipe.dev`, and every tunnel's ingress ends with a 404 catch-all.
    - Code owners and a branch rule hold only the files that can change a guardrail, for a person's review (the CTO, 2026-11-10):
        - `machines/aws-core/` and its deploy workflow `aws-core.yml`: the organization, the roles, the permission boundaries and the SCPs;
        - the `CODEOWNERS` file itself;
        - the security risk register (`risk-register.md`).
    - Everything else merges on the merge gate: `ci.yml` and the gate scripts, the edge stack, `guard.yml`, the deploy workflows and the policy pack. The nightly audit checks changes to the gate. The permission boundaries in aws-core keep the deploy and guard roles away from aws-core and the boundaries. A deploy role can create only roles that carry the workload boundary. The guard role can change no IAM resource. Only the app's task roles can read the production app secrets.
    - No GitHub environment holds a long-lived secret, because any workflow on `main` can name an environment. A job gets a long-lived secret from AWS Secrets Manager, through a role that pins its workflow file.
    - The policy pack blocks a replace or a delete of a protected resource.
    - The organization stays in CDK (`machines/aws-core`).
    - The public `@ctxpipe/aws-cdk` construct stays CDK, for simple, single-tenant self-hosting. Hosted does not use it. Hosted and self-host share only the container images and the environment contract.
    - Images: the ctxpipe repo only pushes images to ECR. It loses its deploy trust in the production account and keeps only an ECR push role. ECR tags are immutable. Each deploy pins its images by digest.
    - Image accounts: only builds of `main` push to the production account. PR builds push to the preview account, with a different role.

**Production**

6. Backend and UI on Fargate ARM. A cloudflared sidecar in each backend task replaces a load balancer. Every production image runs on arm64 (Graviton). An image that does not run on arm64 is a bug ([CTX-1234](https://linear.app/ctxpipe/issue/CTX-1234)).
7. The worker is one Fargate Spot task that scales up on queue depth. It does not scale to zero.
8. Aurora PostgreSQL 17 Serverless v2, writer only, with a minimum of 0.5 ACU. It does not pause. No RDS Proxy. A customer-managed KMS key from day one.
9. FalkorDB and the codesearch query server run on one plain Graviton EC2 instance (ECS, EC2 launch type) with gp3 EBS volumes. Recovery is a runbook: restore the snapshot, then redeploy.
10. S3 is the codesearch cold tier: durable Zoekt shards in S3, the EBS volume is an LRU cache. Indexing stays on the host.
11. Outbound traffic goes through a NAT instance with a fixed Elastic IP.
12. Email goes through the SES API with the task role, not SES SMTP: SMTP needs an IAM user with access keys. Self-host keeps SMTP. Secrets are in Secrets Manager. The production secrets keep their current values at cutover: we copy them into Secrets Manager and do not rotate them. This includes the connection-secret encryption key, so the stored connector tokens still decrypt. All of them got new values after the Railway incident ([CTX-983](https://linear.app/ctxpipe/issue/CTX-983)). Keeping them avoids provider-side rotations in the cutover window, and users stay logged in. The CTO, as the design owner, decided this. The design owner accepts the residual risk: a copy that someone took from Railway or a GitHub environment after that rotation stays valid. The Railway copies go away when phase 7 deletes the Railway project. The design owner also accepts that a person who gets the production connection-secret key can decrypt the stored connector tokens from any database copy. Secrets of new resources get new values: the Aurora passwords, the tunnel tokens and each preview's secrets (decision 22).
13. GuardDuty runs in every account. AWS Backup copies Aurora and the EBS volumes to the archive account each day (35 days).

**Sandboxes**

14. AgentCore Runtime V2 microVMs replace Vercel Sandbox, one session for each conversation or ingest shard. A repository-size cap replaces a second compute type. Production invokes a named runtime endpoint, so that a new sandbox version needs an explicit promote and can roll back at once. Previews use the `DEFAULT` endpoint, which follows the newest version by itself.
15. The backend reaches a session only through `InvokeAgentRuntime` and `InvokeAgentRuntimeCommand` over PrivateLink. No session endpoints. A resource policy, an SCP and the VPC endpoint condition let only backend roles invoke.
16. The sandbox reaches the backend's tool bridge and model proxy over the private network. It goes through Agent Vault, as in self-host ([ADR-049](ADR-049-self-host-chat-sandbox-stock-docker.md)). Agent Vault is the only egress proxy of the sandbox. Sandbox subnets have no internet route. They reach Agent Vault and the VPC endpoints for ECR, logs and AgentCore. Each of these endpoints has a policy that allows only resources and principals of this account (`aws:ResourceAccount`, `aws:PrincipalAccount`). The S3 gateway endpoint allows only the ECR layer bucket.
17. The V2 memory snapshot holds only our shim. OpenCode starts after the restore. Secrets in the sandbox come from `/dev/urandom` per request.
18. A conversation resumes from git: a fresh clone of the Workspace repository and a private conversation ref. An S3 base bundle is added only if the clone is slower than about 3 s. Hosted ctxpipe stops the creation, selection and cleanup of Workspace bases (Vercel snapshots). The Docker Workspace base stays for self-host.

**Previews**

19. `factory preview up <PR>` starts a factory workflow with a `preview-deploy` role in the preview account.
20. Each preview database is a copy-on-write clone of the production cluster, in the production account. Test 9 of the spike showed why: a cross-account clone cannot be cloned again. Also, an account can hold only one cross-account clone of a clone group.
    - The clones sit in a separate preview-data VPC of the production account. That VPC has no connection to the production VPC.
    - The preview-data VPC is peered with the preview VPC. Each clone has its own security group, which admits only the tasks of its own preview.
    - The preview workflow creates and deletes the clones itself. It uses a `preview-db` role in the production account, which can act only on resources tagged `env=preview`. The role creates a clone, its instance and its security group. It sets a new master password and deletes the clone. It cannot connect to a database.
    - Limits of the `preview-db` role:
        - Only the preview workflow can assume it: the OIDC subject of the factory repo's `preview` environment on `main`, and the workflow file `preview.yml`. No preview task role can assume it, and the workload boundary denies `sts:AssumeRole` on it.
        - It sets tags only when it creates a resource. It cannot add, change or remove a tag on an existing resource.
        - It can use the production cluster only as a clone source, and the production key only through RDS for a clone.
        - It can put clones only in the preview-data subnet group.
    - The preview's migrate task sets new passwords for the database roles before it runs the migrations.
21. The preview infrastructure has three parts, all in `machines/previews` (the CTO, 2026-11-12: "preview should never be in aws-core"; "previews should be in pulumi in its own machine"):
    - `base`, in the preview account: the network, a router in the preview VPC that sends each host name to its preview, and one preview AgentCore runtime.
    - `data`, in the production account: the preview-data VPC, the production side of the peering, the `preview-db` role, and the bucket policies that give the preview account read access to the codesearch shard prefix and the FalkorDB backups.
    - The `previews` role deploys `base` and `data` from `main`. aws-core makes one `previews` role in the production account and one in the preview account. In the preview account, it is the `preview-deploy` role of decision 19.
    - OIDC trust of each `previews` role: only the `preview` environment on `main`, and only the named previews workflow files (`job_workflow_ref`), as for the deploy roles.
    - State of each `previews` role: only the `previews/` prefix of its account's state bucket. It cannot read the state of `hosted` or of a guard stack.
    - The boundary of the production `previews` role is an allow-list. It allows only the resources of `data`: the preview-data VPC with its subnets, routes and security groups (tagged at creation), the peering, `role/ctxpipe/preview-` roles, and the policies of the shard and dump buckets. It denies every other resource in the production account, for example an endpoint service. It allows the cross-account actions only on these resources:
        - a peering only between the preview-data VPC (requester, production) and the preview VPC (accepter, preview account). The boundary names both VPC ids, which aws-core config holds. Until a person adds the ids after the first deploy of `data` and `base`, the boundary allows no peering;
        - roles under `role/ctxpipe/preview-` only, and each one must carry the previews workload boundary. That boundary is narrower than the production workload boundary: in production it allows only the clone actions of decision 20 and the reads of decision 21;
        - bucket policies on the shard and dump buckets only.
    - IAM cannot limit the content of a trust policy or a bucket policy. These limits hold the content:
        - A resource control policy (RCP) of the organization denies S3 access and role assumption to principals outside the organization. So no grant can reach an outside account.
        - The same RCP denies `sts:AssumeRoleWithWebIdentity` with a GitHub token in the production account unless the token's subject is on one list in aws-core config. That list holds exact repository and environment pairs (for example factory with `Production`, `preview`, `guard` or `iac-plan`, and ctxpipe with `ecr-push`) and the `main` branch subject of the digest workflow. Only an aws-core change can add a subject. So a gate-merged trust policy in production cannot admit another repository, environment or branch.
        - The policy pack checks the content against the forms of decisions 20 and 21: the `preview-db` trust and limits, and read only on the named prefixes for the preview account's named roles.
        - The nightly audit compares the deployed policies with these forms.
    - The normal deploy role keeps its deny on all cross-account actions.
    - `data` finds the buckets and the cluster of `hosted` by their fixed names (decision 5). The preview VPC id comes from a fixed value in `Pulumi.data.yaml`. `data` requests the peering, and `base` accepts it in the preview account.
    - `data` keeps its state in the production account's state bucket. `base` and `pr` keep theirs in the preview account. No preview stack reads the outputs of `data`.
    - Accepted design (the CTO, 2026-11-12): a change to `machines/previews` merges on the merge gate. Such a change can replace the policy pack. It can then widen the path from preview code to production customer data, but only inside the organization (the RCP) and only on the resources that the `previews` boundary names. The nightly audit finds such a change after the merge.
    - `pr`: one small stack for each preview.

     The edge stack holds the Cloudflare parts of previews: one wildcard DNS record, one tunnel rule for the preview host names, and the Access apps.

     The router runs its own preview tunnel with its own token. Only the router task can read that token. The preview account never holds the production tunnel token. A preview is one small Pulumi stack with its ECS services, plus one clone that the preview workflow makes. A preview stack holds no Cloudflare credential. Thus a compromised preview workflow cannot change the production tunnel or the Access policies. The preview workflow runs the stack through the Pulumi Automation API. `factory preview down` destroys the stack.
22. A preview keeps the isolation that `.github/workflows/pr-deploy.yaml` enforces today:
    - It does not build a PR from a fork.
    - Each preview gets its own `AUTH_SECRET` and its own connection-secret encryption key. Connection secrets that the clone copies from production do not decrypt on a preview.
    - Previews use the preview GitHub App, not the production app.
    - Each clone gets new passwords for its database roles. The clone copies the production passwords, and a preview does not use them.
    - The `Production` and `Preview` environments never share a token, key or secret.
    - The preview clone is not scrubbed. It keeps the session tokens and the OAuth tokens that it copies from production (`sessions`, `accounts`). The Neon preview branches of today do the same. The design owner accepts this residual risk. Unreviewed PR code can read these tokens. It can replay a copied session token against the production app. It can also use a copied OAuth token against a customer's provider. The account boundary does not stop these two effects. It only keeps PR code away from the AWS resources of the production account, except the network path to its own clone.
23. Cloudflare Access protects all of `pr-N.ctxpipe.dev`, `/mcp` and the OAuth paths too. A developer's device passes Access through its WARP identity, so MCP clients and OAuth redirects on that device work without a login page. An agent host uses an Access service token. Only the webhook path skips Access, because GitHub, Slack and Linear cannot log in. The app checks the signature of each webhook.
24. At most 15 previews exist at a time. A preview is deleted on PR close, or 3 days after the last `preview up`. A warm pool of 1 to 2 paused clones keeps the first `preview up` short. In the spike, a clone and its instance took 8 to 8.5 minutes. An idle preview resumes in about 13 seconds on its first request.

**Observability**

25. HyperDX (ClickStack) is the only observability tool. Langfuse goes away. Spans keep the prompt text. Traces stay 30 days.
    - AWS metrics and the logs that only CloudWatch holds come through native paths: CloudWatch Metric Streams and log subscription filters, through Firehose, to the collector. The EC2 hosts send host metrics from the collector's `hostmetrics` receiver. We write no custom poller.
    - Accepted security risk (the CTO, 2026-11-10): agents read the content of every production and preview log group, the exported Aurora logs too, through the audit role. They also read HyperDX spans with prompt text. This content reaches the model provider that runs the agent. The paseo-hub app deploys as admin in the factory account, so a change to it can change the audit role.
    - Agent access is a hard requirement. An agent must be able to debug production and previews without a person. It queries HyperDX through its MCP server with an Access service token. It reads AWS state through the read-only audit role. The cutover does not start before an agent on a factory host and an agent on a laptop both pass this test.

## Alternatives not taken

- **Preview applications in the production account.** Rejected: an account boundary keeps unreviewed code out of the production account, for about $10 a month more.
- **Preview databases in the preview account, from a cross-account clone or a shared snapshot.** Rejected: a cross-account clone cannot be cloned again (spike test 9). A snapshot gives a full copy that is up to a day old, plus a base cluster and a refresh job.
- **Previews in the factory account.** Rejected: previews hold customer data, and the factory account holds none.
- **Filtered preview data.** Rejected: copy-on-write clones cannot filter, and previews must hold real data for debugging.
- **Neptune for the graph.** Rejected for now: FalkorDB isolates each organization in its own graph, and [CTX-996](https://linear.app/ctxpipe/issue/CTX-996) replaces FalkorDB later.
- **EFS for stateful services.** Rejected: EBS is about four times cheaper per GB, and git and Zoekt work better on a local disk.
- **CDK for hosted, with Terraform for Cloudflare.** Rejected for three reasons. It is two tools. CloudFormation is too slow for a stack for each preview: in the spike, two failed deploys stopped in `ROLLBACK_FAILED`. Composing the self-host construct would push multi-tenant and cost features into a product for single-tenant self-hosters.
- **Terraform or OpenTofu for hosted.** Rejected. It is one tool too. But a stack for each preview is clumsy to drive from code, and CDKTF is deprecated. HCL is also weaker than TypeScript for the conditional parts. ADR-013 picked Terraform for self-hosters. That reason does not apply to internal infrastructure.
- **Nitro Sandboxes on ECS Managed Instances (announced 2026-11-09), for now.** It is simpler: plain VPC networking, fast releases, no snapshot RNG issue, and the same container model as self-host. But it pays for at least one host. Below about 2 concurrent sandboxes on average, AgentCore costs less. Re-evaluate when the AgentCore spend shows that average.
- **AgentCore session endpoints.** Rejected: they are public only, and a resource policy cannot name their action.
- **AgentCore Instances compute type, ASG self-healing, worker scale-to-zero, a separate indexer.** Rejected in the simplicity audit. Each adds machinery for a need that we did not measure.
- **RDS Proxy, an ALB, a NAT gateway, an Aurora reader.** Rejected for cost at our load. Each one is a small IaC change if the load grows.

## Consequences

- Sub-processors become AWS, Cloudflare and OpenRouter, plus Vercel for the marketing site and docs only. The model provider of the team's agents also receives log and span content (decision 25).
- Production costs about $300 a month, plus AgentCore usage. Previews cost about $40 to $45 a month fixed, plus about $8 for each 3-day preview. The aws-core budgets change to match, with a new preview budget.
- The stateful host and the NAT instance are single instances. A loss means up to 4 hours of degraded search and graph, or a short outbound outage. Both have runbooks.
- Unreviewed preview code runs in the preview account. Its customer data is in its clone in the production account. For AWS resources, the account boundary is the security boundary. It does not cover the copied session and OAuth tokens: decision 22 records that accepted risk. The production account gives the preview account three things, each narrow:
    - a network path from the preview VPC to the preview-data VPC, with one security group for each clone;
    - the `preview-db` role, which only the preview workflow can assume, and which acts only on resources tagged `env=preview` (decision 20);
    - read access to the codesearch shard prefix and the FalkorDB backups: only the preview FalkorDB and codesearch task roles can read them.
- Telemetry holds customer prompt content for 30 days. The data map ([CTX-1175](https://linear.app/ctxpipe/issue/CTX-1175)) must say so. It must also list the model provider of the agents as a recipient of telemetry and log content.
- Hosted infrastructure does not shape `@ctxpipe/aws-cdk`. A hosted feature goes into the construct only when self-hosters need it too.
- A failed Pulumi update does not roll back: the stack stays partial, and we fix forward. Production changes are additive and run in a preview first.
- After cutover: [ADR-013](ADR-013-switch-infra-from-pulumi-to-terraform.md) (for hosted infrastructure), [ADR-029](ADR-029-railway-us-east-next-to-neon.md), [ADR-038](ADR-038-self-hosted-clickstack-langfuse.md), [ADR-039](ADR-039-production-image-deploys-one-environment.md) and [ADR-054](ADR-054-secrets-sync-from-github-to-railway.md) are superseded. [ADR-048](ADR-048-native-postgres-sandbox-ownership.md) and [ADR-049](ADR-049-self-host-chat-sandbox-stock-docker.md) are amended. `infra/`, `ops/infra`, the Railway scripts, `railway-wake.ts`, the Vercel sandbox provider and the Langfuse files are deleted.
- aws-core gains a preview account and OU. The factory `modify-aws` account table changes to match.
