# Deployment storage and Docker-sandbox constraints

Type: research
Status: resolved

## Question

What storage and isolated-container options do **our actual deploy targets** support, without pretending they are a single machine?

Targets (no Kubernetes product deploy):

- Docker Compose `deploy` profile — no Docker socket, no DinD; codesearch has volumes for `/data/repo-cache` and `/data/zoekt-index`; backend/worker are diskless.
- Railway — backend, worker, codesearch; codesearch has a persistent volume.
- AWS CDK `@ctxpipe/aws-cdk` — ECS **Fargate**; codesearch gets EFS at `/data`; Fargate has no host Docker socket.

Investigate primary sources and answer all of:

**Isolated containers for chat sandboxes**

- Sibling Docker (mount `/var/run/docker.sock`)
- Docker-in-Docker
- A **separate** sandbox unit per conversation or per host (Compose service, Railway service, ECS task) — cold start, cost, credentials
- Managed sandbox APIs those providers document
- What "all deployments support an isolated container sandbox" can honestly mean

**Disk / checkout sharing**

- Railway: two services, same volume? Multiple replicas?
- Fargate + EFS: backend and codesearch on one access point? locking?
- Compose: shared named volume among backend, worker, codesearch
- Git worktree + Zoekt on a shared working tree: index-while-write failure modes
- Whether "one machine" is a property we can assume (services scale independently)

Write findings to `.ai/scratchpad/git-backed-projects/assets/deploy-storage-and-sandbox.md` with citations. This feeds [Backend, codesearch, and sandbox-runner topology](08-backend-codesearch-sandbox-topology.md).

## Answer

**No current target ships a chat sandbox.** Sibling Docker and DinD are not wired. Honest isolated-container options differ by target:

- **Compose:** one host; can add a service or `compose run`; socket mount is root-equivalent; only codesearch has volumes.
- **Railway:** volumes are one-service and incompatible with replicas — **shared disk between backend and codesearch is not possible**. Sandbox API is beta VMs; `ISOLATED` still has outbound Internet; idle timeout ignores in-sandbox processes; Hobby 50 / Pro 100 concurrent per environment; billed at VM rates (~$50/vCPU/month and $50/GB/month) including idle.
- **Fargate:** no Docker socket; per-conversation `RunTask` is the native isolation; EFS can be shared if we mount it (today only codesearch does); pay per vCPU/memory-second from image pull (us-east-1 Linux/X86 example on AWS's page: $0.000011244 / vCPU-second).

"One machine" is only Compose. TanStack's first-party providers do not include Railway or Fargate.

Full write-up: [Deployment storage and sandbox capabilities](../assets/deploy-storage-and-sandbox.md). Sol reviewed; cost, Railway `ISOLATED`≠egress-deny, and idle-timeout-ignores-agent were added.
