# ADR-049: Self-host chat sandboxes: stock Docker on DinD and an EC2 host

**Status:** Accepted | **Date:** 2026-10-05 | **Tags:** sandbox, self-host, docker, compose, aws-cdk, security

## Context

Each Workspace conversation runs its agent in a sandbox ([ADR-044](ADR-044-workspace-chat-stock-tanstack.md), [ADR-048](ADR-048-native-postgres-sandbox-ownership.md)). Hosted ctx| uses Vercel Sandbox. Self-hosters need a sandbox on the two supported deploy paths: Docker Compose ([ADR-015](ADR-015-docker-compose-profiles-and-small-scale-deploy.md)) and the `@ctxpipe/aws-cdk` construct.

Before PR 280, Compose ran a custom sandbox runner: Docker-in-Docker (DinD) with a Btrfs storage file, a quota probe, an egress proxy, and a model relay. The CDK stack ran only on Fargate, with no Docker daemon, so chat ran without a sandbox there. ADR-048 removed the vendor patches that the custom design needed. This ADR records the self-host design that replaces it.

Items marked *(ticket 03)* are decided but not yet shipped. See `.ai/scratchpad/pr-280-release/issues/03-docker-sandbox-self-host.md`.

## Decision

### Provider

- Self-host uses the stock TanStack `dockerSandbox`. There is no vendor patch and no application-level sandbox registry. Ownership, locks, and lifecycle are the same as in ADR-048.
- The backend and the worker connect to a Docker daemon over TCP with mutual TLS (`DOCKER_HOST`, `DOCKER_TLS_VERIFY`, `DOCKER_CERT_PATH`). They never mount the host Docker socket.
- `SANDBOX_CHAT_IMAGE` names the chat image. Compose builds it inside DinD from the checkout. CDK uses `ghcr.io/ctxpipe-ai/chat-sandbox:<release tag>`, which `deploy.yaml` publishes for arm64 and amd64 with the service images. The backend pulls it through the daemon on first use, so a release does not replace the host.
- Sandboxes call the backend back on the local address that the backend uses to reach the daemon. `SANDBOX_CALLBACK_HOST` overrides this address.

### Docker Compose

- The `deploy` profile runs `dind`: stock `docker:dind` at a pinned digest, privileged, with TLS from `DOCKER_TLS_CERTDIR`. It is the only privileged container. Sandboxes are not privileged.
- `dind`, `backend`, and `worker` share a separate `sandbox` network. Compose does not publish the Docker API (port 2376) on the host.
- `scripts/sandbox-dind/` holds the daemon config and a small entrypoint. They apply the same rules as the CDK host: one cgroup parent for all sandboxes (memory cap at 85% of the memory `dind` can use, 8192 processes), `icc: false`, log rotation at 3 × 10 MB, and the instance-metadata drop.
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

There is one documented policy for Compose and AWS (`apps/docs/content/docs/self-hosting/(getting-started)/architecture.mdx`, section "Chat sandbox network policy"):

- Inside the sandbox, only the stock TanStack policy applies.
- Sandboxes reach the internet and the backend model proxy and tool bridges.
- Data stores are never exposed to sandboxes. Compose does not publish Postgres or FalkorDB in any profile. Host dev gets its host ports from the infra-only `infra-host-ports` forwarder. On AWS, security groups admit only the app.
- One added rule drops traffic to instance metadata (`169.254.169.254`). On AWS, the host also blocks sandboxes from the host itself.
- Each agent port needs a per-conversation password. `icc: false` stops traffic between sandboxes on the bridge.
- Sandboxes can reach other services that are published on a sandbox host. The docs tell operators not to publish unauthenticated services there.

### Lifecycle

The lifecycle is the same as hosted (ADR-048):

- A sandbox stops (`docker stop`) after 5 minutes idle. The next turn starts it again (`docker start`) with its files.
- A stopped container is removed 30 days after last use.
- An organization runs at most 50 sandboxes at once.
- A run that nobody watches stops its container when the run ends.

Git is the durable state. When a host or a container is lost, no pushed work is lost.

### Fast start: Workspace base image (option B)

- Each Workspace has a base image. Our code builds it: it creates a sandbox from the stock chat image, clones the Workspace repository, runs setup, and commits the container to an image with owner labels. One build runs at a time per Workspace, under the Workspace lock. *(ticket 03)*
- A new conversation starts with `dockerSandbox({ image: base })`. The pre-turn update fetches the tip and checks out the session branch. *(ticket 03)*
- Our code rebuilds a stale base and deletes a base that no sandbox uses. *(ticket 03)*
- A periodic host prune removes orphan containers and images, so the Docker disk stays flat. Stock `dockerSandbox` sets no container labels, so the prune finds containers by the id in our sandbox row. It finds base images by our own labels. *(ticket 03)*

## Consequences

- Self-hosters get sandboxed chat with no extra settings on Compose and on AWS.
- Compose needs a host that can run a privileged container. Where it cannot, chat fails closed. The operator can select unsandboxed as a last resort.
- The Compose `sandbox_client_certs` volume and the AWS client TLS secret give root on the Docker host. Only the backend and the worker read them.
- Isolation is Docker plus stock policy. This is weaker than the microVMs that hosted uses. A self-host deployment is single-tenant, which decreases this risk.
- The CDK upgrade only adds resources (host, security groups, secrets, Cloud Map service, alarms) and changes the backend and worker services in place. It replaces nothing that holds data.
- On Compose, sandboxes use public DNS resolvers. Compose service names and private DNS zones do not resolve in a sandbox.
- Docker 29 uses the containerd image store, so the chat image uses more disk in DinD (about 1.9 GB).

## Alternatives considered

- **Custom sandbox runner** (DinD with a Btrfs storage file, per-sandbox disk quotas, a quota probe, an egress proxy, and a model relay). Rejected: it needed vendor patches (ADR-048) and much code to maintain. Stock policy and Docker limits are sufficient for a single-tenant deployment. PR 280 deleted it (ticket 03 deletion ledger).
- **Mount the host Docker socket into the backend.** Rejected: each process in the backend then has root on the host, and sandboxes share a daemon with the app containers.
- **Automatic unsandboxed fallback when the daemon does not answer.** Rejected: a daemon outage would silently run agents inside the backend, with its network access and credentials. The backend fails closed instead.
- **A private-range egress chain in DinD** (reject 10/8, 172.16/12, 192.168/16, 100.64/10, 169.254/16). Rejected after review: it did not block the host's public address, and it blocked private Git servers. The root cause was published data stores, so Compose no longer publishes them.
- **An opt-out prop for the CDK sandbox host.** Rejected: the sandbox is a safety feature.
- **ECS RunTask per conversation on AWS.** Rejected in ADR-048: slower start and higher cost per task than one shared host.
- **sbx (Docker microVM sandboxes).** Parked: it needs KVM, has no snapshots or forks, has a local-only CLI, and has unclear headless login and licensing.
- **Fast start from a patched shared base in `@tanstack/ai-sandbox`.** Rejected: option B gives the same start with stock `dockerSandbox({ image })` and no patch.

## Related

- [ADR-015](ADR-015-docker-compose-profiles-and-small-scale-deploy.md): Compose profiles, including `dind` and `chat-sandbox-image`.
- [ADR-048](ADR-048-native-postgres-sandbox-ownership.md): ownership, providers, lifecycle, and cleanup shared with hosted.
- Self-hosting docs: `apps/docs/content/docs/self-hosting/` (architecture, Docker, AWS, operations).
