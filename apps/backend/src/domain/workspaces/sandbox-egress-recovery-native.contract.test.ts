import { type ChildProcess, spawn } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer, request as httpRequest } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { dockerSandbox } from "@tanstack/ai-sandbox-docker"
import Dockerode from "dockerode"
import { expect, it } from "vitest"
import { holdDockerAllocationReply } from "../../test/native-docker-ack-loss.js"

const MANAGED_LABEL = "com.tanstack.ai.sandbox.managed-by"
const SCHEMA_LABEL = "com.tanstack.ai.sandbox.schema"
const SANDBOX_KEY_LABEL = "com.tanstack.ai.sandbox.sandbox-key"
const OWNERSHIP_LABEL = "com.tanstack.ai.sandbox.ownership-v2"

type OwnedLabels = Record<string, string>

function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error && "statusCode" in error && error.statusCode === 404
  )
}

function ownershipFilters(labels: OwnedLabels): Array<string> {
  const key = labels[SANDBOX_KEY_LABEL]
  const owner = labels[OWNERSHIP_LABEL]
  if (!key || !owner) throw new Error("Native egress ownership labels missing")
  return [
    `${MANAGED_LABEL}=tanstack-ai`,
    `${SCHEMA_LABEL}=1`,
    `${SANDBOX_KEY_LABEL}=${key}`,
    `${OWNERSHIP_LABEL}=${owner}`,
  ]
}

async function removeOwnedResources(
  docker: Dockerode,
  labels: OwnedLabels | undefined,
): Promise<void> {
  if (!labels) return
  const filters = { label: ownershipFilters(labels) }
  const containers = await docker.listContainers({ all: true, filters })
  for (const container of containers) {
    try {
      await docker.getContainer(container.Id).remove({ force: true, v: true })
    } catch (error) {
      if (!isNotFound(error)) throw error
    }
  }
  const networks = await docker.listNetworks({ filters })
  for (const network of networks) {
    try {
      await docker.getNetwork(network.Id).remove()
    } catch (error) {
      if (!isNotFound(error)) throw error
    }
  }
}

function directDockerOptions(): Dockerode.DockerOptions {
  const host = process.env.DOCKER_HOST
  if (host && !host.startsWith("unix://"))
    throw new Error("Native egress recovery requires a Unix Docker socket")
  return { socketPath: host?.slice("unix://".length) ?? "/var/run/docker.sock" }
}

function childExit(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  )
}

async function killAndWait(
  child: ChildProcess,
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
): Promise<void> {
  if (
    child.exitCode === null &&
    child.signalCode === null &&
    !child.kill("SIGKILL")
  )
    throw new Error("Native egress recovery child could not be killed")
  const result = await Promise.race([
    exited,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Native egress recovery child did not exit")),
        10_000,
      )
      timer.unref()
    }),
  ])
  if (result.signal !== "SIGKILL" && result.code !== null)
    throw new Error(
      `Native egress recovery child exited before SIGKILL (${result.code})`,
    )
}

it(
  "recovers native Docker egress resources after allocation acknowledgement loss",
  { timeout: 120_000 },
  async () => {
    const dockerOptions = directDockerOptions()
    const docker = new Dockerode(dockerOptions)
    const directory = mkdtempSync(join(tmpdir(), "ctxpipe-egress-recovery-"))
    const id = `gate4-egress-recovery-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const input = {
      id,
      workspace: {
        identity: `gate4-egress-workspace-${id}`,
        source: { type: "none" as const },
      },
    }
    const config = {
      image:
        "node@sha256:8a34c4ab3ea2c5cd194f07e317b2a8f09461d3c8b05c4e34c8ccd56d56024c4d",
      workdir: "/tmp",
      dockerodeOptions: dockerOptions,
      egress: {
        proxyImage:
          "node@sha256:8a34c4ab3ea2c5cd194f07e317b2a8f09461d3c8b05c4e34c8ccd56d56024c4d",
        allowConnect: [],
        allowHttp: [],
      },
    }
    let fault: Awaited<ReturnType<typeof holdDockerAllocationReply>> | undefined
    const script = join(directory, "create-and-hold.mjs")
    const packageEntry = new URL(
      "../../../node_modules/@tanstack/ai-sandbox-docker/dist/esm/index.js",
      import.meta.url,
    ).href
    try {
      fault = await holdDockerAllocationReply(join(directory, "docker.sock"), {
        holdAnyNamedAllocation: true,
      })
      writeFileSync(
        script,
        `const { dockerSandbox } = await import(${JSON.stringify(packageEntry)});
const provider = dockerSandbox(${JSON.stringify({
          ...config,
          dockerodeOptions: { socketPath: join(directory, "docker.sock") },
        })});
await provider.create(${JSON.stringify(input)});
process.stdout.write("created\\n");
await new Promise(() => {});
`,
      )
    } catch (error) {
      try {
        await fault?.close()
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Native egress recovery fixture setup and cleanup failed",
        )
      }
      rmSync(directory, { recursive: true, force: true })
      throw error
    }
    let child: ChildProcess | undefined
    let exited:
      | Promise<{ code: number | null; signal: NodeJS.Signals | null }>
      | undefined
    let recovered:
      | Awaited<ReturnType<ReturnType<typeof dockerSandbox>["create"]>>
      | undefined
    let ownedLabels: OwnedLabels | undefined
    let primaryError: unknown
    const cleanupErrors: unknown[] = []
    try {
      child = spawn(process.execPath, [script], {
        cwd: process.cwd(),
        env: { ...process.env, DOCKER_HOST: `unix://${fault.socketPath}` },
        stdio: ["ignore", "ignore", "pipe"],
      })
      let stderr = ""
      child.stderr?.on("data", (chunk) => {
        stderr = (stderr + chunk.toString()).slice(-8_000)
      })
      exited = childExit(child)
      const allocation = await Promise.race([
        fault.allocation.then((value) => ({
          kind: "allocation" as const,
          value,
        })),
        exited.then((value) => ({ kind: "exit" as const, value })),
        new Promise<{ kind: "timeout" }>((resolve) => {
          const timer = setTimeout(() => resolve({ kind: "timeout" }), 30_000)
          timer.unref()
        }),
      ])
      if (allocation.kind !== "allocation")
        throw new Error(
          `Native egress allocation was not held (${allocation.kind})${stderr ? `: ${stderr}` : ""}`,
        )
      const allocatedInfo = await docker
        .getContainer(allocation.value.id)
        .inspect()
      ownedLabels = allocatedInfo.Config.Labels ?? undefined
      expect(ownedLabels?.[MANAGED_LABEL]).toBe("tanstack-ai")
      expect(ownedLabels?.[SCHEMA_LABEL]).toBe("1")
      expect(ownedLabels?.[SANDBOX_KEY_LABEL]).toBe(id)
      expect(ownedLabels?.[OWNERSHIP_LABEL]).toBeTruthy()

      await killAndWait(child, exited)
      fault.release()

      recovered = await dockerSandbox(config).create(input)
      const recoveredInfo = await docker.getContainer(recovered.id).inspect()
      expect(recoveredInfo.Config.Labels?.[SANDBOX_KEY_LABEL]).toBe(id)
      await recovered.fs.write("crash-recovery.txt", "recovered-after-ack-loss")
      expect(await recovered.fs.read("crash-recovery.txt")).toBe(
        "recovered-after-ack-loss",
      )
      ownedLabels = recoveredInfo.Config.Labels ?? ownedLabels
      await recovered.destroy()
      recovered = undefined
      // Observe provider teardown before the fixture's emergency cleanup.
      if (!ownedLabels)
        throw new Error("Recovered sandbox ownership is missing")
      const filters = { label: ownershipFilters(ownedLabels) }
      expect(await docker.listContainers({ all: true, filters })).toHaveLength(
        0,
      )
      expect(await docker.listNetworks({ filters })).toHaveLength(0)
    } catch (error) {
      primaryError = error
    } finally {
      if (
        child &&
        exited &&
        child.exitCode === null &&
        child.signalCode === null
      ) {
        try {
          await killAndWait(child, exited)
        } catch (error) {
          cleanupErrors.push(error)
        }
      }
      if (fault) {
        try {
          fault.release()
        } catch (error) {
          cleanupErrors.push(error)
        }
      }
      if (recovered) {
        try {
          await recovered.destroy()
        } catch (error) {
          cleanupErrors.push(error)
        }
      }
      try {
        await removeOwnedResources(docker, ownedLabels)
      } catch (error) {
        cleanupErrors.push(error)
      }
      if (fault) {
        try {
          await fault.close()
        } catch (error) {
          cleanupErrors.push(error)
        }
      }
      try {
        rmSync(directory, { recursive: true, force: true })
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    if (primaryError !== undefined && cleanupErrors.length)
      throw new AggregateError(
        [primaryError, ...cleanupErrors],
        "Native egress recovery and cleanup failed",
        { cause: primaryError },
      )
    if (primaryError !== undefined) throw primaryError
    if (cleanupErrors.length)
      throw new AggregateError(
        cleanupErrors,
        "Native egress recovery cleanup failed",
      )
  },
)

it.each(["proxy", "network"] as const)(
  "retries native egress teardown after the %s daemon operation fails",
  { timeout: 90_000 },
  async (failedResource) => {
    const dockerOptions = directDockerOptions()
    const docker = new Dockerode(dockerOptions)
    const image =
      "node@sha256:8a34c4ab3ea2c5cd194f07e317b2a8f09461d3c8b05c4e34c8ccd56d56024c4d"
    const config = {
      image,
      workdir: "/tmp",
      dockerodeOptions: dockerOptions,
      egress: { proxyImage: image, allowConnect: [], allowHttp: [] },
    }
    const provider = dockerSandbox(config)
    const id = `egress-delete-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const directory = mkdtempSync(join(tmpdir(), "ctxpipe-egress-delete-"))
    const socketPath = join(directory, "docker.sock")
    let handle: Awaited<ReturnType<typeof provider.create>> | undefined
    let ownedLabels: OwnedLabels | undefined
    let fault: ReturnType<typeof createServer> | undefined
    let primaryError: unknown
    const cleanupErrors: unknown[] = []
    try {
      handle = await provider.create({
        id,
        workspace: { identity: id, source: { type: "none" } },
      })
      const info = await docker.getContainer(handle.id).inspect()
      ownedLabels = info.Config.Labels
      if (!ownedLabels)
        throw new Error("Native egress ownership labels missing")
      const filters = { label: ownershipFilters(ownedLabels) }
      const resources = await docker.listContainers({ all: true, filters })
      const proxy = resources.find(
        (resource) =>
          resource.Labels["com.tanstack.ai.sandbox.role"] === "proxy",
      )
      if (!proxy) throw new Error("Native egress proxy missing")
      const proxyNames = new Set([
        proxy.Id,
        ...proxy.Names.map((name) => name.replace(/^\//, "")),
      ])
      const networks = await docker.listNetworks({ filters })
      const networkNames = new Set(
        networks.flatMap((network) => [network.Id, network.Name]),
      )
      let rejected = false
      fault = createServer((request, response) => {
        const url = new URL(request.url ?? "/", "http://docker")
        const target = decodeURIComponent(
          url.pathname.split(
            failedResource === "proxy" ? "/containers/" : "/networks/",
          )[1] ?? "",
        )
        if (
          !rejected &&
          request.method === "DELETE" &&
          (failedResource === "proxy" ? proxyNames : networkNames).has(target)
        ) {
          rejected = true
          response.writeHead(503, { "content-type": "application/json" })
          response.end(
            JSON.stringify({
              message: `fixture ${failedResource} removal unavailable`,
            }),
          )
          return
        }
        const forwarded = httpRequest(
          {
            socketPath: dockerOptions.socketPath,
            method: request.method,
            path: request.url,
            headers: request.headers,
          },
          (upstream) => {
            response.writeHead(upstream.statusCode ?? 502, upstream.headers)
            upstream.pipe(response)
          },
        )
        forwarded.on("error", () => {
          if (!response.headersSent) response.writeHead(502)
          response.end()
        })
        request.pipe(forwarded)
      })
      await new Promise<void>((resolve, reject) => {
        fault?.once("error", reject)
        fault?.listen(socketPath, resolve)
      })
      const failingProvider = dockerSandbox({
        ...config,
        dockerodeOptions: { socketPath },
      })
      await expect(failingProvider.destroy({ id: handle.id })).rejects.toThrow(
        `fixture ${failedResource} removal unavailable`,
      )
      expect(rejected).toBe(true)
      // Retry knows only the original persisted provider ID.
      await provider.destroy({ id: handle.id })
      expect(await docker.listContainers({ all: true, filters })).toHaveLength(
        0,
      )
      expect(await docker.listNetworks({ filters })).toHaveLength(0)
      handle = undefined
    } catch (error) {
      primaryError = error
    } finally {
      try {
        await handle?.destroy()
      } catch (error) {
        cleanupErrors.push(error)
      }
      try {
        await removeOwnedResources(docker, ownedLabels)
      } catch (error) {
        cleanupErrors.push(error)
      }
      if (fault) {
        const server = fault
        server.closeAllConnections()
        try {
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          )
        } catch (error) {
          cleanupErrors.push(error)
        }
      }
      try {
        rmSync(directory, { recursive: true, force: true })
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    if (cleanupErrors.length)
      throw new AggregateError(
        primaryError === undefined
          ? cleanupErrors
          : [primaryError, ...cleanupErrors],
        "Native egress teardown proof and cleanup failed",
        primaryError === undefined ? undefined : { cause: primaryError },
      )
    if (primaryError !== undefined) throw primaryError
  },
)

it(
  "reclaims owned egress topology after its persisted agent is externally removed",
  { timeout: 120_000 },
  async () => {
    const dockerOptions = directDockerOptions()
    const docker = new Dockerode(dockerOptions)
    const image =
      "node@sha256:8a34c4ab3ea2c5cd194f07e317b2a8f09461d3c8b05c4e34c8ccd56d56024c4d"
    const config = {
      image,
      workdir: "/tmp",
      dockerodeOptions: dockerOptions,
      egress: { proxyImage: image, allowConnect: [], allowHttp: [] },
    }
    const provider = dockerSandbox(config)
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const handles: Awaited<ReturnType<typeof provider.create>>[] = []
    const owners: OwnedLabels[] = []
    let primaryError: unknown
    const cleanupErrors: unknown[] = []
    try {
      for (const owner of ["removed", "survivor"] as const) {
        const id = `egress-detached-${owner}-${suffix}`
        const handle = await provider.create({
          id,
          workspace: { identity: id, source: { type: "none" } },
        })
        handles.push(handle)
        const info = await docker.getContainer(handle.id).inspect()
        if (!info.Config.Labels)
          throw new Error("Native egress ownership labels missing")
        owners.push(info.Config.Labels)
      }
      const removed = handles[0]
      const survivorLabels = owners[1]
      if (!removed || !survivorLabels)
        throw new Error("Native detached egress fixture was not created")
      const removedFilters = { label: ownershipFilters(owners[0] ?? {}) }
      const survivorFilters = { label: ownershipFilters(survivorLabels) }
      const survivorContainerIds = (
        await docker.listContainers({ all: true, filters: survivorFilters })
      )
        .map(({ Id }) => Id)
        .sort()
      const survivorNetworkIds = (
        await docker.listNetworks({ filters: survivorFilters })
      )
        .map(({ Id }) => Id)
        .sort()

      await docker.getContainer(removed.id).remove({ force: true, v: true })
      await dockerSandbox({ image, dockerodeOptions: dockerOptions }).destroy({
        id: removed.id,
      })

      expect(
        await docker.listContainers({ all: true, filters: removedFilters }),
      ).toHaveLength(0)
      expect(
        await docker.listNetworks({ filters: removedFilters }),
      ).toHaveLength(0)
      expect(
        (await docker.listContainers({ all: true, filters: survivorFilters }))
          .map(({ Id }) => Id)
          .sort(),
      ).toEqual(survivorContainerIds)
      expect(
        (await docker.listNetworks({ filters: survivorFilters }))
          .map(({ Id }) => Id)
          .sort(),
      ).toEqual(survivorNetworkIds)
    } catch (error) {
      primaryError = error
    } finally {
      for (const handle of handles) {
        try {
          await handle.destroy()
        } catch (error) {
          cleanupErrors.push(error)
        }
      }
      for (const labels of owners) {
        try {
          await removeOwnedResources(docker, labels)
        } catch (error) {
          cleanupErrors.push(error)
        }
      }
    }
    if (cleanupErrors.length)
      throw new AggregateError(
        primaryError === undefined
          ? cleanupErrors
          : [primaryError, ...cleanupErrors],
        "Native detached egress cleanup proof failed",
      )
    if (primaryError !== undefined) throw primaryError
  },
)

it(
  "resumes and forks an isolated Docker worktree with independent owned topology",
  { timeout: 120_000 },
  async () => {
    const dockerOptions = directDockerOptions()
    const docker = new Dockerode(dockerOptions)
    const image =
      "node@sha256:8a34c4ab3ea2c5cd194f07e317b2a8f09461d3c8b05c4e34c8ccd56d56024c4d"
    const config = {
      image,
      workdir: "/tmp",
      dockerodeOptions: dockerOptions,
      egress: { proxyImage: image, allowConnect: [], allowHttp: [] },
    }
    const provider = dockerSandbox(config)
    const id = `egress-fork-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const owned: OwnedLabels[] = []
    const handles: Awaited<ReturnType<typeof provider.create>>[] = []
    let forkImage: string | undefined
    let primaryError: unknown
    const cleanupErrors: unknown[] = []
    try {
      const parent = await provider.create({
        id,
        workspace: { identity: id, source: { type: "none" } },
      })
      handles.push(parent)
      const parentInfo = await docker.getContainer(parent.id).inspect()
      owned.push(parentInfo.Config.Labels)
      await parent.fs.write("recovery.txt", "preserved parent edits")
      const resources = await docker.listContainers({
        all: true,
        filters: { label: ownershipFilters(parentInfo.Config.Labels) },
      })
      const proxy = resources.find(
        (resource) =>
          resource.Labels["com.tanstack.ai.sandbox.role"] === "proxy",
      )
      if (!proxy) throw new Error("Native egress proxy missing")
      await Promise.all([
        docker.getContainer(parent.id).stop({ t: 1 }),
        docker.getContainer(proxy.Id).stop({ t: 1 }),
      ])
      const restarted = dockerSandbox(config)
      const resumed = await restarted.resume({ id: parent.id })
      if (!resumed?.fork)
        throw new Error("Native Docker resume and fork are required")
      expect(resumed.id).toBe(parent.id)
      expect(await resumed.fs.read("recovery.txt")).toBe(
        "preserved parent edits",
      )
      expect(
        (await docker.getContainer(proxy.Id).inspect()).State.Running,
      ).toBe(true)
      const child = await resumed.fork()
      handles.push(child)
      const childInfo = await docker.getContainer(child.id).inspect()
      owned.push(childInfo.Config.Labels)
      forkImage = childInfo.Image
      expect(childInfo.Config.Labels[OWNERSHIP_LABEL]).not.toBe(
        parentInfo.Config.Labels[OWNERSHIP_LABEL],
      )
      expect(Object.keys(childInfo.NetworkSettings.Networks)).not.toEqual(
        Object.keys(parentInfo.NetworkSettings.Networks),
      )
      expect(await child.fs.read("recovery.txt")).toBe("preserved parent edits")
      await child.fs.write("recovery.txt", "independent child edits")
      expect(await resumed.fs.read("recovery.txt")).toBe(
        "preserved parent edits",
      )
      await restarted.destroy({ id: parent.id })
      const resumedChild = await dockerSandbox(config).resume({ id: child.id })
      if (!resumedChild) throw new Error("Native Docker fork did not resume")
      expect(await resumedChild.fs.read("recovery.txt")).toBe(
        "independent child edits",
      )
      await resumedChild.destroy()
      for (const labels of owned) {
        const filters = { label: ownershipFilters(labels) }
        expect(
          await docker.listContainers({ all: true, filters }),
        ).toHaveLength(0)
        expect(await docker.listNetworks({ filters })).toHaveLength(0)
      }
      await expect(docker.getImage(forkImage).inspect()).rejects.toMatchObject({
        statusCode: 404,
      })
    } catch (error) {
      primaryError = error
    } finally {
      for (const handle of handles) {
        try {
          await handle.destroy()
        } catch (error) {
          cleanupErrors.push(error)
        }
      }
      for (const labels of owned) {
        try {
          await removeOwnedResources(docker, labels)
        } catch (error) {
          cleanupErrors.push(error)
        }
      }
      if (forkImage) {
        try {
          await docker.getImage(forkImage).remove()
        } catch (error) {
          if (!isNotFound(error)) cleanupErrors.push(error)
        }
      }
    }
    if (cleanupErrors.length)
      throw new AggregateError(
        primaryError === undefined
          ? cleanupErrors
          : [primaryError, ...cleanupErrors],
        "Native egress fork proof and cleanup failed",
      )
    if (primaryError !== undefined) throw primaryError
  },
)
