# Deployment storage and sandbox capabilities

Researched 2026-08-13 from ctxpipe's deploy configuration and first-party
Railway, AWS, Docker, Git, and Zoekt sources. This describes capabilities and
constraints; it does not select a design.

## Executive summary

### Docker Compose `deploy`

- The actual Compose target is a single-server deployment with separate
  `backend`, `worker`, `ui`, and `codesearch` containers. Only `codesearch`
  mounts persistent checkout/index storage: `repo_cache` at
  `/data/repo-cache` and `zoekt_index_deploy` at `/data/zoekt-index`.
  Backend and worker mount neither volume. There is no shared named volume
  among backend, worker, and codesearch
  ([repo config](../../../../docker-compose.yml#L66-L183)). Docker describes
  Compose production as easiest on a
  [single server](https://docs.docker.com/compose/how-tos/production/#running-compose-on-a-single-server);
  this is the one actual target where one host is the normal deployment unit.
- The file defines `infra` and `deploy` profiles
  ([repo config](../../../../docker-compose.yml#L4-L8)), but no sandbox
  service, `/var/run/docker.sock` mount, or privileged/Docker-in-Docker
  service. Sibling Docker and DinD are therefore **not current ctxpipe
  capabilities**.
- Compose can define another service or launch a one-off container with
  [`docker compose run`](https://docs.docker.com/reference/cli/docker/compose/run/),
  but an application container cannot invoke the host daemon unless the
  deployment separately gives it a Docker API endpoint and credentials.
  Mounting the host socket is not a security boundary: Docker says the socket
  is root-owned and Docker access grants
  [root-level privileges](https://docs.docker.com/engine/install/linux-postinstall/#manage-docker-as-a-non-root-user).
- Docker also documents a separate
  [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/) product that puts
  each agent in a microVM with its own kernel, Docker daemon, filesystem, and
  network. It is not part of Compose or this repo's deploy file; Linux hosts
  require Ubuntu 24.04+, KVM (including nested virtualization when applicable),
  the `sbx` package, and login
  ([prerequisites](https://docs.docker.com/ai/sandboxes/get-started/#prerequisites)).

### Railway

- The actual Terraform deploys `backend`, `openworkflow`, `ui`, `codesearch`,
  `falkordb`, and telemetry as separate Railway services, each currently with
  one replica in one configured region
  ([repo config](../../../../infra/module/ctxpipe/railway.tf#L13-L21),
  [services](../../../../infra/module/ctxpipe/railway.tf#L154-L343)).
  Services communicate by private DNS, not a shared host
  ([repo config](../../../../infra/module/ctxpipe/railway.tf#L50-L151)).
- Only the `codesearch` service receives `codesearch-volume-vNK-` at `/data`
  ([repo config](../../../../infra/module/ctxpipe/railway.tf#L254-L266)).
  Railway states that a volume
  [can be attached to one service](https://docs.railway.com/infrastructure-as-code/reference#volumes),
  each service can have only one volume, and
  [replicas cannot be used with volumes](https://docs.railway.com/volumes/reference#volume-limits).
  Therefore backend/sandbox and codesearch cannot mount the same Railway
  volume, and this codesearch service cannot have multiple replicas while the
  volume remains attached.
- Railway services are containers and can be created/deployed through its
  [public GraphQL API](https://docs.railway.com/integrations/api/manage-services),
  so a separate long-running sandbox-runner service is platform-possible.
  Creating a service/deployment per conversation is also API-possible, but it
  uses the normal image build/deploy lifecycle rather than an ephemeral
  execution primitive. It would require a Railway API token; project tokens
  are scoped to one project environment
  ([API authentication](https://docs.railway.com/integrations/api#project-token)).
- Railway now documents a purpose-built
  [Sandbox API/TypeScript SDK](https://docs.railway.com/sandboxes):
  short-lived VMs created per task/session, with `exec`, files,
  checkpoints/forks, and idle teardown. Default network mode is
  `ISOLATED`: outbound Internet through NAT, **no** private-network
  access to other Railway services. `PRIVATE` joins the environment
  private network and **keeps outbound Internet**. Neither mode is
  egress-deny. Idle timeout counts **client interactions** (`exec` /
  SSH), not processes running inside; a running agent does not by
  itself prevent destruction. Hobby/Pro default 30 minutes (max 120);
  Trial/Free default 5 (max 5). Concurrent sandbox cap is per
  environment (Hobby 50, Pro 100). Feature is
  [Priority Boarding](https://docs.railway.com/platform/priority-boarding)
  with warned breaking changes.

### AWS CDK / ECS Fargate

- `@ctxpipe/aws-cdk` creates separate Fargate task definitions and services for
  backend, worker, UI, and codesearch
  ([task definitions](../../../../packages/aws-cdk/src/internal/task-definitions-construct.ts#L30-L45),
  [services](../../../../packages/aws-cdk/src/internal/services-construct.ts#L14-L84)).
  Large size profiles run two backend and two worker tasks while codesearch
  remains one task
  ([profile](../../../../packages/aws-cdk/src/ctxpipe.ts#L83-L108)).
  Fargate spreads service tasks across accessible Availability Zones on a
  best-effort basis; task co-location is not a contract
  ([AWS task placement](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-placement.html#task-placement-fargate)).
- The stack creates one EFS file system and one `/codesearch` access point
  ([repo config](../../../../packages/aws-cdk/src/internal/data-plane-construct.ts#L72-L103)).
  Only the codesearch task declares that EFS volume and mounts it read-write at
  `/data`; backend and worker do not
  ([repo config](../../../../packages/aws-cdk/src/internal/task-definitions-construct.ts#L52-L75),
  [mount](../../../../packages/aws-cdk/src/internal/task-definitions-construct.ts#L163-L190)).
  Thus backend and codesearch are **not** on one access point in the actual
  stack. The EFS security group would permit NFS from the app security group,
  but task definition, IAM, and mount configuration still have to grant access
  ([repo config](../../../../packages/aws-cdk/src/internal/networking-construct.ts#L68-L76)).
- A separate Fargate task per conversation is platform-native via
  [`RunTask`](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/scheduling_tasks.html):
  AWS calls standalone tasks suitable for work pulled from a queue that exits
  when done. Each Fargate task has its own hardware-virtualized isolation
  boundary and does not share kernel, CPU, memory, network interface, or
  ephemeral storage with another task
  ([AWS isolation](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/security-shared-model.html#security-shared-responsibility-fargate)).
  This is not wired for chat sandboxes: the backend task has no sandbox task
  definition or `ecs:RunTask`/`iam:PassRole` grant. The stack's migration
  custom resource demonstrates those grants only for its migration task
  ([repo config](../../../../packages/aws-cdk/src/internal/migrate-on-deploy-construct.ts#L144-L165)).
- Fargate cannot provide sibling Docker or DinD. AWS says Fargate prevents
  access to the underlying host filesystem, devices, networking, and container
  runtime, and does not support privileged containers; it explicitly identifies
  Docker-in-Docker as affected
  ([AWS Fargate security](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-security-considerations.html)).
- AWS also documents a separate managed sandbox:
  [Amazon Bedrock AgentCore Code Interpreter](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-tool.html).
  Each session runs in a dedicated microVM with isolated CPU, memory, and
  filesystem; sessions are started through
  [`StartCodeInterpreterSession`](https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_StartCodeInterpreterSession.html)
  and use an execution role and configurable network mode. This service is not
  provisioned or authorized by the current ctxpipe CDK package.

### No Kubernetes product deploy

No Helm chart, Kustomize base, Kubernetes workload manifest, or Kubernetes
product deployment target exists in the reviewed repo. The only
Kubernetes-named artifact is
`apps/codesearch/scripts/manual-kubernetes-ingest-memory.sh`, a manual test that
indexes the Kubernetes source repository; it is not a Kubernetes deployment.
Kubernetes storage/sandbox capabilities are therefore outside ctxpipe's actual
targets.

## Findings with citations

### Isolated containers for chat sandboxes

#### Sibling Docker (`/var/run/docker.sock`)

| Target | Platform support | Actual ctxpipe state |
| --- | --- | --- |
| Compose | A service can be given a bind mount to the host socket, after which it controls the host daemon. Docker warns that Docker access confers root-level host privilege ([daemon socket](https://docs.docker.com/reference/cli/dockerd/#daemon-socket-option), [daemon attack surface](https://docs.docker.com/engine/security/#docker-daemon-attack-surface)). This is orchestration access, not isolation from hostile code. | No socket mount and no sandbox service in `docker-compose.yml`. |
| Railway | Railway exposes managed service/container lifecycle, not the host container runtime. Its documented service surface is image deployment through services/API ([services](https://docs.railway.com/services)); no host socket is exposed in the actual service config. | Not available through the current deployment. |
| Fargate | Unsupported: Fargate prevents access to the host container runtime and does not support host `sourcePath` bind mounts ([host volume API](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_HostVolumeProperties.html)). | Not available. |

#### Docker-in-Docker

| Target | Platform support | Actual ctxpipe state |
| --- | --- | --- |
| Compose | Docker documents `--privileged` as enabling Docker-in-Docker, but also says a privileged container is not securely sandboxed and can take control of the host ([privileged mode](https://docs.docker.com/reference/cli/docker/container/run/#privileged)). Even rootless DinD still requires `--privileged` to disable seccomp/AppArmor/mount masks ([rootless DinD](https://docs.docker.com/engine/security/rootless/tips/#rootless-docker-in-docker)). | No DinD image or `privileged: true`. |
| Railway | Railway's documented service and Sandbox APIs do not expose a customer-controlled privileged host container. The managed Sandbox VM can run general Linux work and is the documented isolation primitive; it is not DinD in ctxpipe's service. | Not configured. |
| Fargate | Explicitly unsupported because privileged containers are unavailable ([unsupported task parameters](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-tasks-services.html#fargate-task-defs)). | Not possible on this launch type. |

#### Separate sandbox unit per conversation or per host

**Compose.** A persistent `sandbox-runner` service would be one container per
Compose project/host, but conversations sharing it would not gain
container-per-conversation isolation. Compose can create one-off containers
from a declared service with `docker compose run --rm`; doing that from ctxpipe
requires an out-of-process host controller, a protected remote Docker API, or
the dangerous host socket. Startup includes container/image preparation, but
Docker publishes no latency guarantee, so no fixed cold-start number is
supportable. Credentials would need explicit per-service/per-run injection;
Compose grants declared secrets only to services that request them
([Compose secrets](https://docs.docker.com/compose/how-tos/use-secrets/)).

**Railway.** A normal service can be a per-environment runner and can scale
independently, but it is long-running/shared unless the application provides
its own inner isolation. Creating a service per conversation through the
GraphQL API incurs the normal build/deploy lifecycle
([deployment lifecycle](https://docs.railway.com/deployments/reference)).
Railway's purpose-built Sandbox SDK is the documented per-session alternative:
creation returns only when the VM accepts commands, templates/checkpoints/forks
reduce repeated setup, and idle timeout destroys abandoned sandboxes
([Railway Sandboxes](https://docs.railway.com/sandboxes)). There is no published
creation-latency SLA in that page, so "cold start" can only honestly mean a
provisioning wait, not a promised duration. The caller needs a Railway API
token/environment ID, while workload credentials are separately injected into
the sandbox.

**AWS.** A persistent ECS service is a per-deployment runner and is shared
unless it creates stronger inner boundaries. `RunTask` can create a distinct
Fargate task per conversation. Its cold path includes `PROVISIONING` (capacity
and ENI), `PENDING`, and `ACTIVATING` (image pull, container creation,
networking)
([task lifecycle](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-lifecycle-explanation.html)).
Fargate does not cache image layers on its single-use instances, so each task
pulls the image and image size directly affects startup time
([image pull behavior](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-pull-behavior.html)).
The caller needs `ecs:RunTask` and, where roles are supplied, scoped
`iam:PassRole`; the task execution role lets ECS pull images/read launch
secrets, while the task role is the workload's AWS credential
([ECS role overview](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ecs-iam-role-overview.html),
[`RunTask` authorization](https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonelasticcontainerservice.html#amazonelasticcontainerservice-actions-as-permissions)).

AgentCore Code Interpreter is a second AWS path, distinct from ECS: it provides
managed per-session microVMs and explicit start/invoke/stop APIs, but supports
its defined runtimes/tool contract rather than arbitrary ctxpipe container
images. Its default session timeout is 15 minutes and maximum is 8 hours
([session characteristics](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-session-characteristics.html)).

#### What “all deployments support an isolated container sandbox” can honestly mean

It **cannot** mean that the checked-in deployments already expose one portable
sandbox API, that all targets can mount Docker's socket, that all targets can
run DinD, or that every sandbox can share the codesearch checkout disk.

The strongest accurate cross-target statement is:

> Each deployment family has a target-specific route to separately provisioned
> execution after additional infrastructure and credentials: host-controlled
> one-off containers or Docker Sandboxes for a compatible Compose host,
> Railway Sandboxes (currently Priority Boarding), and separate Fargate tasks
> or AgentCore Code Interpreter sessions on AWS.

Even that sentence needs two qualifications:

1. It describes **provider capability, not current ctxpipe wiring**.
2. “Isolated” is not one guarantee: ordinary Compose containers share the host
   kernel; Railway documents isolated VMs; Fargate documents a
   hardware-virtualized task boundary; Docker Sandboxes and AgentCore document
   microVM boundaries.

If “isolated sandbox” means a strong boundary for untrusted code, the
unqualified claim that all **actual current deployments** support it is false.

### Disk and checkout sharing

#### Railway: two services and replicas

- A Railway volume can attach to only one service
  ([IaC reference](https://docs.railway.com/infrastructure-as-code/reference#volumes)).
  Backend and a sandbox service therefore cannot mount the existing codesearch
  volume at the same time.
- A service with a volume cannot use replicas, and Railway prevents two
  deployments from being active against that volume to avoid corruption,
  causing brief redeploy downtime
  ([volume limits](https://docs.railway.com/volumes/reference#volume-limits)).
- Other services can scale independently and requests may reach any replica
  ([scaling](https://docs.railway.com/deployments/scaling#horizontal-scaling-with-replicas)).
  A Railway project is not one machine; the current one-replica Terraform
  setting does not create a co-location contract.
- Sharing checkout content across Railway services therefore requires a
  different transfer/storage boundary (for example API/object storage/database
  or an external shared filesystem); the existing volume cannot do it.

#### Fargate and EFS

- EFS can be mounted concurrently by multiple NFS clients
  ([EFS operation](https://docs.aws.amazon.com/efs/latest/ug/how-it-works.html)).
  Access points enforce a root directory and POSIX identity and can be combined
  with task-role IAM
  ([ECS EFS volumes](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/efs-volumes.html)).
  Therefore a future sandbox task could technically mount the same file system
  and access point if its task definition, role, security group, and POSIX
  permissions permit it.
- The actual stack does not do so: the codesearch task alone mounts the sole
  `/codesearch` access point at `/data`; backend/worker do not mount EFS.
- EFS locking is NFSv4 **advisory** locking. Reads/writes do not check
  conflicting locks, applications must coordinate and account for
  close-to-open consistency, and one file is limited to 512 locks
  ([EFS consistency and locking](https://docs.aws.amazon.com/efs/latest/ug/features.html#features-locking)).
  Merely mounting one access point into two tasks does not serialize Git,
  sandbox edits, Zoekt indexing, or shard replacement.
- There is a Zoekt-specific EFS risk beyond working-tree writes. Zoekt shards
  are mmap-friendly files
  ([Zoekt design](https://github.com/sourcegraph/zoekt/blob/33f1f18a/doc/design.md)),
  and the upstream project tracks that replacing a stable shard path from a
  different EFS client can invalidate a live mmap on later page fault
  ([Zoekt issue #1109](https://github.com/sourcegraph/zoekt/issues/1109)).
  The current ctxpipe stack avoids multi-task shard writers by keeping
  codesearch at desired count one, but EFS itself does not enforce that rule.

#### Compose named volumes

- Compose named volumes can be reused by multiple services, but each service
  must explicitly mount the volume
  ([Compose volume reference](https://docs.docker.com/reference/compose-file/volumes/)).
- The actual file explicitly mounts `repo_cache` and `zoekt_index_deploy` only
  into codesearch. Backend and worker are diskless with respect to those
  volumes. Therefore the premise “shared named volume among backend, worker,
  codesearch” is not true today.
- A future Compose service on the same Docker engine could mount `repo_cache`,
  but concurrent writers would need application-level coordination. Docker
  warns generally that multiple containers writing the same volume can corrupt
  data when the software is not designed for concurrent writers
  ([Docker volume behavior](https://docs.docker.com/reference/cli/docker/service/create/#create-a-service-using-a-named-volume)).
- The local named-volume model is host-local. Compose's documented simple
  production mode is one server; a cluster deployment needs a storage driver
  with shared-storage semantics rather than assuming the local driver
  ([Compose production](https://docs.docker.com/compose/how-tos/production/)).

#### Git worktree plus Zoekt on a shared working tree

Git worktrees make separate working trees share repository data. Git documents
that linked worktree administrative data lives under
`$GIT_COMMON_DIR/worktrees`, while some refs and configuration are shared
([repository layout](https://git-scm.com/docs/gitrepository-layout#_worktrees)).
Zoekt supports indexing a worktree path
([upstream worktree test](https://github.com/sourcegraph/zoekt/blob/33f1f18a/gitindex/index_test.go#L1170-L1205)).
Those facts make a **dedicated immutable worktree per index run** feasible; they
do not make simultaneous mutation and indexing of the **same** worktree safe.

The actual ctxpipe index path currently uses one checkout directory per
repository/check-out key
([repo paths](../../../../apps/codesearch/src/domain/repositories/paths.ts#L5-L33)).
The clone phase runs `git fetch`, then force-checks out the target commit in
that directory; the Zoekt phase later passes the same path to `zoekt-index`
([repo implementation](../../../../apps/codesearch/src/domain/indexing/phases.ts#L184-L204),
[checkout](../../../../apps/codesearch/src/domain/indexing/phases.ts#L469-L565)).
Git defines forced checkout as proceeding despite differences and throwing
away local changes/untracked files that obstruct the checkout
([`git checkout --force`](https://git-scm.com/docs/git-checkout#Documentation/git-checkout.txt--f)).

Zoekt's directory indexer walks the tree and reads files one by one; an
`os.ReadFile` error aborts the build
([upstream `zoekt-index`](https://github.com/sourcegraph/zoekt/blob/893a5238/cmd/zoekt-index/main.go#L113-L168)).
Consequently, if a sandbox or checkout mutates that same tree during indexing:

- a file discovered during the walk can disappear or be replaced before read,
  causing the indexing command to fail;
- files read before and after a concurrent edit/checkout can come from
  different logical revisions, producing a shard that is not a coherent commit
  snapshot even if every individual read succeeds;
- `git checkout -f` can discard sandbox edits in the shared worktree; and
- Git's index lock only serializes updates to Git's index file
  ([Git lockfile API](https://git-scm.com/docs/api-lockfile)); it does not lock
  arbitrary readers of working-tree files or Zoekt.

The repo's same-repository operation guard intentionally allows index
operations to overlap and is process-local
([repo implementation](../../../../apps/codesearch/src/domain/indexing/indexConcurrency.ts#L16-L27),
[test](../../../../apps/codesearch/src/domain/indexing/indexConcurrency.test.ts#L35-L80)).
It does not provide a distributed disk lock across services/tasks or protect an
indexer from sandbox writes. A coherent snapshot therefore requires a separate
immutable checkout/worktree, copy/snapshot, or an explicit cross-process
protocol; this research does not choose among them.

### Is “one machine” assumable?

| Target | Honest topology statement |
| --- | --- |
| Compose `deploy` | The checked-in mode is a Compose application on one Docker engine/server. Containers are separate but named volumes are local to that engine unless an operator substitutes another driver. |
| Railway | No. Services are independent deployment targets connected by private networking. The current config requests one replica each, but the platform can place and scale services independently; volumes further bind codesearch to one service/replica. |
| ECS Fargate | No. Backend, worker, UI, and codesearch are independent services/tasks. Fargate spreads tasks across Availability Zones and gives each task its own isolation boundary. EFS, service discovery, and the VPC—not co-location—are the sharing/communication mechanisms. |

## Constraints

1. **Current config versus platform potential must stay distinct.** None of the
   checked-in targets currently exposes a chat-sandbox API or shares
   codesearch checkout storage with a sandbox.
2. **Docker socket access is privilege, not hostile-code containment.** It
   grants control of the host daemon; DinD normally needs privileged mode, and
   Fargate forbids both.
3. **Per-conversation units have real startup paths.** Compose must create a
   container; Railway must provision a Sandbox VM or perform a service
   deployment; Fargate must provision capacity/networking and pull an uncached
   image. No cross-provider cold-start SLA was found.
4. **Control-plane credentials are powerful and provider-specific.** Compose
   needs protected Docker control access; Railway Sandboxes need a scoped API
   token and environment ID; ECS launchers need scoped `ecs:RunTask` and
   `iam:PassRole`; AgentCore needs its API and execution-role permissions.
5. **Storage semantics differ.** Compose local volumes are host-local; Railway
   volumes are single-service and incompatible with replicas; EFS is
   multi-client NFS with advisory locking.
6. **A shared mount is not a concurrency design.** Git, mutable worktrees,
   Zoekt's file walk, Zoekt shard publication, and EFS consistency each need
   an explicit ownership/snapshot/locking model.
7. **Managed sandbox offerings are not deployment-neutral.** Railway
   Sandboxes are currently beta/Priority Boarding; Docker Sandboxes require
   supported hosts with KVM and are not Compose wiring; AgentCore is a separate
   AWS service with its own runtime/tool contract.
8. **No Kubernetes fallback exists in the product deploy surface.** Kubernetes
   assumptions cannot fill gaps in Compose, Railway, or Fargate.

## Cost (published list prices, not a ctxpipe estimate)

These are the providers' own billing units. They are not a recommendation and
not a monthly forecast.

- **Compose:** no sandbox product to bill. Extra containers consume **host**
  CPU/RAM/disk. Docker documents sibling-daemon access as
  [root-equivalent](https://docs.docker.com/engine/install/linux-postinstall/#manage-docker-as-a-non-root-user).
  Docker Sandboxes are a separate product with host prerequisites, not a
  Compose line item in this repo.
- **Railway application services:** RAM $10/GB/month, CPU $20/vCPU/month,
  egress $0.05/GB, volume storage $0.15/GB/month, plus the plan's
  subscription fee ([plans](https://docs.railway.com/pricing/plans)).
- **Railway Sandboxes (VM primitive, beta):** billed while the VM runs,
  including idle; destroying or a short idle timeout is how you stop
  paying. Published VM rates: memory $50/GB/month, vCPU $50/vCPU/month,
  egress $0.05/GB
  ([sandbox pricing](https://docs.railway.com/sandboxes#pricing),
  [VM pricing](https://docs.railway.com/pricing/plans)).
- **AWS Fargate:** pay for requested vCPU, memory, OS, architecture, and
  ephemeral storage from image pull until the task/pod terminates,
  rounded to the second, 1-minute minimum (Linux)
  ([Fargate pricing](https://aws.amazon.com/fargate/pricing/)).
  Official US East (N. Virginia) Linux/X86 example rates on that page:
  $0.000011244 per vCPU-second, $0.000001235 per GB-second; 20 GB
  ephemeral storage included; additional ephemeral $0.0000000308 per
  GB-second. Spot is a separate, variable discount (up to 70% off) for
  interrupt-tolerant ECS Linux tasks. Extra AWS services (logs, NAT,
  public IPv4) bill separately.

## What this does NOT decide

- Whether ctxpipe should use per-conversation sandboxes, a pooled runner, or a
  long-lived per-host/per-deployment runner.
- Whether any managed sandbox offering is mature, available, economical, or
  contractually appropriate for ctxpipe.
- Which isolation boundary is sufficient for the product's threat model.
- Whether sandbox files should be copied, uploaded, exposed over an API, or
  mounted through shared storage.
- Whether checkout sharing should use Git worktrees, full clones, snapshots,
  object storage, or another artifact protocol.
- Which component owns lifecycle, retries, quotas, garbage collection,
  credentials, network policy, or billing.
- Whether the deployment interfaces should converge behind one abstraction.
- Any product promise, roadmap commitment, or provider selection.
- Whether Railway Sandboxes' beta/Priority Boarding status is acceptable.
