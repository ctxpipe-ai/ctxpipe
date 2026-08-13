# Deployment storage and Docker-sandbox constraints

Type: research
Status: claimed

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
