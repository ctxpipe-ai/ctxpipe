# ADR-049: Self-host chat sandboxes: stock Docker on DinD and an EC2 host

**Status:** Accepted | **Date:** 2026-10-05 (credentials: 2026-10-08) | **Tags:** sandbox, self-host, docker, compose, aws-cdk, security

## Context

Each Workspace conversation runs its agent in a sandbox ([ADR-044](ADR-044-workspace-chat-stock-tanstack.md), [ADR-048](ADR-048-native-postgres-sandbox-ownership.md)). Hosted ctx| uses Vercel Sandbox (`SANDBOX_PROVIDER=vercel`). The Terraform module in `infra/` is our own hosted Railway layout, and it sets that provider. Self-hosters on the Docker Compose path ([ADR-015](ADR-015-docker-compose-profiles-and-small-scale-deploy.md)) and the `@ctxpipe/aws-cdk` path need a sandbox that runs in their own infrastructure.

Earlier PR 280 work had a custom sandbox runner for Compose. It was Docker-in-Docker (DinD) with a Btrfs storage file, a quota probe, an egress proxy, and a model relay. On CDK, Fargate has no Docker daemon, so chat would have run without a sandbox. ADR-048 removed the vendor patches that the custom design needed. This ADR records the self-host design that replaces it.

## Decision

### Provider

- Self-host uses the stock TanStack `dockerSandbox`. There is no vendor patch and no application-level sandbox registry. Ownership, locks, and lifecycle are the same as in ADR-048.
- The backend and the worker connect to a Docker daemon over TCP with mutual TLS (`DOCKER_HOST`, `DOCKER_TLS_VERIFY`, `DOCKER_CERT_PATH`). They never mount the host Docker socket.
- `SANDBOX_CHAT_IMAGE` names the chat image. Compose builds it inside DinD from the checkout. CDK uses `ghcr.io/ctxpipe-ai/chat-sandbox:<commit SHA>`, at the tag that the package pins (`PINNED_SERVICE_IMAGE_TAG`). `deploy.yaml` publishes it for arm64 and amd64 with the service images. The backend pulls it through the daemon on first use, so a release does not replace the host.
- With a remote daemon, sandboxes send requests to the backend on the local address that the backend uses to reach the daemon. `SANDBOX_CALLBACK_HOST` overrides this address.

### Docker Compose

- The `deploy` profile runs `dind`: stock `docker:dind` at a pinned digest, privileged, with TLS from `DOCKER_TLS_CERTDIR`. It is the only privileged container. Sandboxes are not privileged.
- `dind`, `backend`, `worker`, and `chat-sandbox-image` share a separate `sandbox` network. Compose does not publish the Docker API (port 2376) on the host.
- `scripts/sandbox-dind/` holds the daemon config and a small entrypoint. They put all sandboxes in one cgroup parent, capped at 85% of the memory `dind` can use and 8192 processes. They also set `icc: false`, log rotation at 3 × 10 MB, and a raw-table drop of instance-metadata traffic.
- The CDK host has more: `CPUWeight=50` on the sandbox slice, `live-restore`, a host `INPUT` reject from `docker0`, and a metadata `REJECT` in `DOCKER-USER`.
- The one-shot `chat-sandbox-image` service builds the chat image inside `dind`. No service waits for it. Until the image exists, chat returns 503 and the rest of the app works.

### AWS CDK

- `CtxPipe` always creates `SandboxHostConstruct` (`packages/aws-cdk/src/internal/sandbox-host-construct.ts`). There is no opt-out, because the sandbox is a safety feature.
- The host is one instance in an Auto Scaling group, so a failed host is replaced. It runs Amazon Linux 2023 on Graviton (arm64). `size` selects `t4g.medium`, `t4g.large`, or `t4g.xlarge`. The optional props `sandboxHost.instanceType` (Graviton only) and `sandboxHost.dockerVolumeSizeGiB` change the size. There are no new required props, so the release is a minor (ticket 09).
- A gp3 volume holds `/var/lib/docker`. The volume is deleted with the instance, because sandboxes are disposable.
- TLS: the first host makes a CA, a server certificate, and a client certificate. It writes them to two Secrets Manager secrets and discards the CA key. A replacement host uses the stored certificates again.
- Address: after a TLS ping, the host registers `sandbox-host.ctxpipe.local` in Cloud Map. Then it signals CloudFormation, so `cdk deploy` waits for a ready host.
- An init container in the backend and worker tasks writes the client certificates to a task volume. The app container mounts that volume read-only. The private key never goes into the app environment.
- CloudWatch alarms watch Docker disk (80%) and host memory (85%). They have no actions. Operators subscribe them through `sandboxHostAlarms`.

### Fail closed

- When `SANDBOX_PROVIDER` is not set, the provider is Docker. If the daemon does not answer, the turn fails with 503. The backend never falls back to unsandboxed.
- `unsandboxed` runs only when an operator sets `SANDBOX_PROVIDER=unsandboxed` explicitly. The backend then logs a warning once per process. Compose and CDK never set it. The docs mark it as a last resort.

### Network policy

- One policy applies to Compose and AWS. The details are in the [chat sandbox network policy](<../../../apps/docs/content/docs/self-hosting/(getting-started)/architecture.mdx#chat-sandbox-network-policy>).
- The root cause of data-store exposure was published ports. Docker routes to published ports from other networks, so Compose publishes no data store in any profile. On AWS, security groups admit only the app.
- One added rule blocks instance metadata (`169.254.169.254`). The CDK host also blocks traffic to the host itself.

### Credentials: Agent Vault (2026-10-08)

- A Docker sandbox holds no credential of ours: no GitHub token, model proxy capability, tool bridge token, or Git run capability. Agent Vault (Infisical, open source, `infisical/agent-vault:latest`, not pinned) adds each credential in flight. The OpenCode config and `GH_TOKEN` hold the same placeholder as on hosted sandboxes.
- One rule list (`sandbox-credential-rules.ts`) serves the Vercel firewall and Agent Vault: GitHub hosts (Basic `x-access-token` for `github.com` and `codeload.github.com`, Bearer for `api.github.com`), and exact paths on the backend for the model proxy (`…/chat/completions`, `…/models`) and the run's tool bridge. Agent Vault matches the raw path and does not resolve `..`, so a rule never has a glob. Each rule sets the whole `Authorization` header (a custom header rule); Agent Vault sets `Host` from the target it dials.
- Sandbox traffic is forced through the proxy at the network level. On Compose, `scripts/sandbox-dind/entrypoint.sh` adds mangle-table rules in `dind`: replies, then TCP to the proxy (`CTXPIPE_SANDBOX_PROXY`), then drop; IPv6 from sandboxes is dropped (dind stops if it cannot). On AWS, `DOCKER-USER` rules let `docker0` reach only the Agent Vault bridge (`ctxpipe-av`) on the proxy port, and Agent Vault cannot reach the host or itself. Non-HTTP traffic and DNS from sandboxes are blocked (accepted). Hosts with no rule are forwarded, so HTTP(S) to the internet stays open, and Docker turns get the open network policy and `webfetch`.
- The proxy may dial private addresses only at the backend: Compose gives the backend a fixed address (`172.30.99.10`, alias `backend.sandbox.ctxpipe.internal`); AWS allows the backend subnets (the stack's only private subnets, which also hold RDS, Neptune, EFS, and the UI and codesearch tasks: only security groups keep the proxy out of them, so the sandbox host's group must never be admitted to them) and sets `SANDBOX_CALLBACK_DNS_SUFFIX`, so the backend calls itself back by its VPC DNS name. Rule hosts must be names, not addresses. The proxy never reaches Agent Vault's management API (tested on the Compose layout).
- Rate limits stay on (the login limit guards the owner account); only the proxy tier is raised, because all requests of a turn share one vault. Issue #380 (failed proxy logins share the `dind` address) is an accepted risk: turn ends stop the earlier turn's processes.
- One vault per run (a turn, a prepare, or a Workspace base build). The sandbox gets the proxy variables (from the SDK's `containerConfig` and `buildProxyEnv`, with the host the sandbox dials and the port Agent Vault reports) and the CA. `close` deletes the vault, then revokes the run's GitHub token through `run-git-tokens.ts`. The prune workflow sweeps vaults older than the session TTL (2 hours) once per window.
- The deployment generates the passwords: Compose uses two volumes (master password for Agent Vault only, owner password for backend and worker); AWS uses two Secrets Manager secrets. The backend registers the owner only while the instance has none; otherwise a refused login fails closed. No new customer-set variable.
- If Agent Vault is not configured or does not answer, Docker chat fails closed (503 with a clear error). The `git-credentials` route, `git-credential.mjs`, the `gh` wrapper, the Git run capability, and `CTXPIPE_CLONE_TOKEN` for Docker are removed.
- Known limit: Agent Vault matches the decoded path, so `chat%2Fcompletions` matches the model rule. The token still goes only to the backend, which routes on its own.
- Host dev is for a trusted machine: on Docker Desktop local containers reach the 127.0.0.1-bound API and the proxy. On a fresh volume a local container could register the owner first; the backend then fails closed (remove the `agent_vault_dev` volume). Production Compose and CDK are not affected.
- Known limits: Node's `fetch` tunnels plain-HTTP requests with `CONNECT`, which Agent Vault does not accept for HTTP targets (HTTPS works; Bun, curl, Git, and `gh` work). Host dev and CI have no forced egress. A Compose `sandbox` subnet that overlaps a host network needs a manual change.

### Lifecycle

Lifecycle, limits, and cleanup are as in [ADR-048](ADR-048-native-postgres-sandbox-ownership.md).

### Fast start: Workspace base image (option B)

- The Workspace base of [ADR-048](ADR-048-native-postgres-sandbox-ownership.md) is a Docker image on self-host. Our code commits a prepared builder container to an image. A new conversation starts from it with stock `dockerSandbox({ image })` and no patch.
- Our labels are on each base image, each builder, and each container started from a base. They are `ai.ctxpipe.sandbox` (kind), `ai.ctxpipe.store` (a hash of the deployment's database), `ai.ctxpipe.base`, and `ai.ctxpipe.org`.
- A host prune runs once per sweep window. It sweeps no organization: each organization's own sweep chain deletes what its rows record, and each base schedules the next sweep of its organization. Stock containers have no labels, so the sweep works from the container id in the row.
- The prune then removes labeled objects of this deployment that have no row. It removes a base image whose base row is gone, or whose row names another image while no build of that row holds its lease. It removes a labeled container that no row records and that is older than one hour, because a create can record its row late. It never touches unlabeled objects or objects of another deployment.

## Consequences

- Self-hosters get sandboxed chat with no extra settings on Compose and on AWS.
- Compose needs a host that can run a privileged container. Where it cannot, chat fails closed. The operator can select unsandboxed as a last resort.
- The Compose `sandbox_client_certs` volume and the AWS client TLS secret give root on the Docker host. Only the services that use the Docker API read them: on Compose `backend`, `worker`, and `chat-sandbox-image`; on AWS the backend and worker tasks.
- Isolation is Docker plus stock policy. This is weaker than the microVMs that hosted uses. A self-host deployment is single-tenant, which decreases this risk.
- The CDK upgrade only adds resources (host, security groups, secrets, Cloud Map service, alarms). It changes the backend and worker services in place. It replaces nothing that holds data.
- On Compose, sandboxes use public DNS resolvers. Compose service names and private DNS zones do not resolve in a sandbox.

## Alternatives considered

- **Custom sandbox runner** (DinD with a Btrfs storage file, per-sandbox disk quotas, a quota probe, an egress proxy, and a model relay). Rejected: it needed vendor patches (ADR-048) and much code to maintain. Stock policy and Docker limits are sufficient for a single-tenant deployment. PR 280 replaced it before release.
- **Mount the host Docker socket into the backend.** Rejected: each process in the backend then has root on the host, and sandboxes share a daemon with the app containers.
- **Automatic unsandboxed fallback when the daemon does not answer.** Rejected: a daemon outage would silently run agents inside the backend, with its network access and credentials. The backend fails closed instead.
- **A private-range egress chain in DinD** (reject 10/8, 172.16/12, 192.168/16, 100.64/10, 169.254/16). Rejected after review: it did not block the host's public address, and it blocked private Git servers. The root cause was published data stores. Compose no longer publishes them.
- **An opt-out prop for the CDK sandbox host.** Rejected: the sandbox is a safety feature.
- **sbx (Docker microVM sandboxes).** Parked: it needs KVM and has no snapshots or forks. Its CLI is local-only, and its headless login and licensing are unclear. It also adds a second runtime without a need that stock policy leaves unmet.
- **Fast start from a patched shared base in `@tanstack/ai-sandbox`.** Rejected: option B gives the same start with stock `dockerSandbox({ image })` and no patch.

## Related

- [ADR-015](ADR-015-docker-compose-profiles-and-small-scale-deploy.md): Compose profiles, including `dind` and `chat-sandbox-image`.
- [ADR-048](ADR-048-native-postgres-sandbox-ownership.md): ownership, providers, lifecycle, Workspace base, and cleanup shared with hosted.
- Self-hosting docs: `apps/docs/content/docs/self-hosting/` (architecture, configuration, Docker, AWS, operations).
