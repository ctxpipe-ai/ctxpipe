# Quota-capable sandbox runner

This is the Docker-in-Docker infrastructure runner for the native sandbox resource
contract. Build with `docker build -t ctxpipe-sandbox-runner scripts/sandbox-runner`.
It requires a privileged **infrastructure** container and a kernel with Btrfs quota
support. Agent containers receive neither privilege nor access to runner storage.

The runner keeps Docker's native Btrfs storage driver on a sparse filesystem in
`/var/lib/ctxpipe-sandbox-storage`. Preserve that named volume across restarts.
`CTXPIPE_SANDBOX_STORAGE_GIB` sets its initial aggregate capacity (default 64 GiB,
minimum 8); changing it does not resize existing storage. A volume lock prevents
two runners from mounting the same image. Startup fails if mounting or enabling
quotas fails, and existing storage is never reformatted.

Native sandbox `StorageOpt.size` caps each container; snapshots and forks continue
through Docker's normal commit/restore APIs. Btrfs counts referenced image data
as well as new writes, so the cap can be stricter than a writable-layer-only limit.
Volumes and logs do not share that quota: the native isolation profile forbids
external mounts and disables container logging. The aggregate filesystem and host
disk still need capacity monitoring. Loop-backed storage is intended for the
locked small-scale Compose topology, not a general high-I/O container platform.

Native `docker-init` owns PID 1 and child reaping. Startup removes stale daemon
PID files only from `/run/docker`; persistent image data and certificates survive
runner restarts. Compose mounts the Btrfs data and TLS CA/server/client volumes,
waits for the Btrfs daemon healthcheck, and shares only read-only client
certificates with backend and worker. The daemon API is not host-published.

Docker's TLS-enabled entrypoint remains the default. Do not publish an unauthenticated
daemon API beyond a disposable test runner's loopback endpoint. Network enforcement,
production chat-image activation, callback routing and provider wiring remain
separate Gate 4 work;
this resource contract alone does not establish complete sandbox isolation.

References: [Docker Btrfs driver](https://docs.docker.com/engine/storage/drivers/btrfs-driver/)
and [per-container storage options](https://docs.docker.com/reference/cli/dockerd/#btrfs-options).
