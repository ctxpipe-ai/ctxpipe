import { createServer, request as httpRequest } from "node:http"
import {
  createSecrets,
  defineSandbox,
  memorySandboxSnapshots,
  type SandboxHandle,
  type SandboxInstanceRecord,
  startHostToolBridge,
} from "@tanstack/ai-sandbox"
import { runSandboxInstanceStoreConformance } from "@tanstack/ai-sandbox/testkit"
import { dockerSandbox } from "@tanstack/ai-sandbox-docker"
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process"
import Dockerode from "dockerode"
import { eq } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, expect, it } from "vitest"
import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import { conversations } from "../../db/schema/conversations.js"
import { workspaces } from "../../db/schema/workspaces.js"
import { generateObjectId } from "../../lib/id.js"
import { persistSandboxInstance } from "../../models/workspaces.js"
import { WORKSPACE_CHAT_DOCKER_SANDBOX } from "./chat-runtime.js"
import { postgresSandboxInstanceStore } from "./sandbox-instance-store.js"
import { postgresSandboxLocks } from "./sandbox-lock-store.js"

it(
  "enforces native Docker egress and revokes exact per-run tool bridge access",
  { timeout: 90_000 },
  async () => {
    const target = createServer((_request, response) =>
      response.end("model-ok"),
    )
    await new Promise<void>((resolve, reject) => {
      target.once("error", reject)
      target.listen(0, "0.0.0.0", resolve)
    })
    let handle: SandboxHandle | undefined
    let bridge: Awaited<ReturnType<typeof startHostToolBridge>> | undefined
    let channel:
      | Awaited<ReturnType<SandboxHandle["ports"]["connect"]>>
      | undefined
    let primaryError: unknown
    const cleanupErrors: unknown[] = []
    try {
      const address = target.address()
      if (!address || typeof address === "string")
        throw new Error("Missing target port")
      const host = "host.docker.internal"
      const modelUrl = `http://${host}:${address.port}/chat/completions`
      const provider = dockerSandbox({
        image: WORKSPACE_CHAT_DOCKER_SANDBOX.image,
        workdir: "/tmp",
        publishPorts: [8080],
        egress: {
          proxyImage: WORKSPACE_CHAT_DOCKER_SANDBOX.image,
          allowConnect: [],
          allowHttp: [
            { host, port: address.port, paths: ["/chat/completions"] },
          ],
          ingress: [{ listenPort: 8081, targetPort: 8080 }],
        },
      })
      expect(provider.capabilities().networkPolicy).toBe(true)
      handle = await provider.create({
        id: `egress-${generateObjectId("ws")}`,
        workspace: {
          identity: `org-egress:${generateObjectId("ws")}`,
          source: { type: "none" },
        },
      })
      await handle.fs.write(
        "probe.cjs",
        `
const http = require('node:http');
const target = process.env.PROBE_URL;
const proxy = new URL(process.env.HTTP_PROXY);
const request = http.request({hostname: proxy.hostname, port: proxy.port,
  method: 'POST', path: target, headers: {
    authorization: 'Bearer ' + (process.env.PROBE_TOKEN || ''),
    accept: 'application/json, text/event-stream', 'content-type': 'application/json'
  }}, response => {
    let body = ''; response.setEncoding('utf8');
    response.on('data', chunk => body += chunk);
    response.on('end', () => process.stdout.write(JSON.stringify({status: response.statusCode, body})));
  });
request.setTimeout(5000, () => request.destroy(new Error('proxy timeout')));
request.on('error', error => { process.stderr.write(error.message); process.exitCode = 1; });
request.end(JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list'}));
`,
      )
      async function probe(url: string, token = "") {
        if (!handle) throw new Error("Missing native sandbox")
        const result = await handle.process.exec("node /tmp/probe.cjs", {
          env: { PROBE_URL: url, PROBE_TOKEN: token },
        })
        expect(result.exitCode, result.stderr).toBe(0)
        return JSON.parse(result.stdout) as { status: number; body: string }
      }
      expect(await probe(modelUrl)).toEqual({ status: 200, body: "model-ok" })
      expect((await probe(`http://${host}:${address.port}/admin`)).status).toBe(
        403,
      )
      expect(
        (await probe("http://169.254.169.254/latest/meta-data/")).status,
      ).toBe(403)
      expect((await probe("http://example.com/")).status).toBe(403)

      bridge = await startHostToolBridge([], {
        hostForSandbox: host,
        bindAddress: "0.0.0.0",
        sandbox: handle,
      })
      expect((await probe(bridge.url, "wrong-token")).status).toBe(403)
      expect((await probe(`${bridge.url}/other`, bridge.token)).status).toBe(
        403,
      )
      expect((await probe(bridge.url, bridge.token)).status).toBe(200)
      await bridge.close()
      expect((await probe(bridge.url, bridge.token)).status).toBe(403)

      const direct = await handle.process.exec(
        `node -e 'const net = require("node:net"); const socket = net.connect({host:"1.1.1.1",port:443}); socket.setTimeout(1500,()=>{socket.destroy();process.stdout.write("blocked")}); socket.on("connect",()=>{socket.destroy();process.stdout.write("escaped")}); socket.on("error",()=>process.stdout.write("blocked"));'`,
      )
      expect(direct.exitCode, direct.stderr).toBe(0)
      expect(direct.stdout).toBe("blocked")

      await handle.fs.write(
        "ingress.cjs",
        `require('node:http').createServer((_req, res) => res.end('ingress-ok')).listen(8080, '0.0.0.0', () => process.stdout.write('ready\\n'))`,
      )
      const server = await handle.process.spawn("node /tmp/ingress.cjs")
      let readyTimer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          (async () => {
            for await (const output of server.stdout) {
              if (output.includes("ready")) return
            }
            throw new Error("Native ingress fixture exited before readiness")
          })(),
          new Promise<never>((_resolve, reject) => {
            readyTimer = setTimeout(
              () =>
                reject(new Error("Native ingress fixture startup timed out")),
              10_000,
            )
          }),
        ])
      } finally {
        if (readyTimer) clearTimeout(readyTimer)
      }
      channel = await handle.ports.connect(8080)
      const unauthenticated = await fetch(channel.url)
      await unauthenticated.text()
      expect(unauthenticated.status).toBe(401)
      const authorized = await fetch(channel.url, { headers: channel.headers })
      expect(authorized.status).toBe(200)
      expect(await authorized.text()).toBe("ingress-ok")
      const priorHeaders = channel.headers
      if (!channel.close) throw new Error("Native ingress must be revocable")
      await channel.close()
      channel = await handle.ports.connect(8080)
      const stale = await fetch(channel.url, { headers: priorHeaders })
      await stale.text()
      expect(stale.status).toBe(401)
      const replacement = await fetch(channel.url, { headers: channel.headers })
      expect(replacement.status).toBe(200)
      expect(await replacement.text()).toBe("ingress-ok")
    } catch (error) {
      primaryError = error
    } finally {
      try {
        await bridge?.close()
      } catch (error) {
        cleanupErrors.push(error)
      }
      try {
        await channel?.close?.()
      } catch (error) {
        cleanupErrors.push(error)
      }
      try {
        await handle?.destroy()
      } catch (error) {
        cleanupErrors.push(error)
      }
      await new Promise<void>((resolve) => target.close(() => resolve()))
    }
    if (cleanupErrors.length)
      throw new AggregateError(
        primaryError === undefined
          ? cleanupErrors
          : [primaryError, ...cleanupErrors],
        "Native egress proof and cleanup failed",
        primaryError === undefined ? undefined : { cause: primaryError },
      )
    if (primaryError !== undefined) throw primaryError
  },
)

const fixtures: Array<{ orgId: string; workspaceId: string }> = []

it(
  "replays a native Docker snapshot restore without allocating a second worktree",
  { timeout: 60_000 },
  async () => {
    const provider = dockerSandbox({ image: "alpine:3.22", workdir: "/tmp" })
    const restored: SandboxHandle[] = []
    const source = await provider.create({
      id: `restore-source-${generateObjectId("ws")}`,
    })
    let snapshotId: string | undefined
    let primaryError: unknown
    const cleanupErrors: unknown[] = []
    try {
      if (!source.snapshot || !provider.restoreSnapshot)
        throw new Error("Native snapshots are required")
      await source.fs.write("restore-marker.txt", "snapshot")
      snapshotId = (await source.snapshot()).id
      const id = `restore-child-${generateObjectId("ws")}`
      const first = await provider.restoreSnapshot({ snapshotId, id })
      restored.push(first)
      await first.fs.write("restore-marker.txt", "after-first-restore")
      // A second caller only knows the deterministic restore input because the
      // first allocation's acknowledgement/store write was lost.
      const second = await provider.restoreSnapshot({ snapshotId, id })
      restored.push(second)
      expect(second.id).toBe(first.id)
      expect(await second.fs.read("restore-marker.txt")).toBe(
        "after-first-restore",
      )
    } catch (error) {
      primaryError = error
    } finally {
      for (const handle of [...restored, source]) {
        try {
          await handle.destroy()
        } catch (error) {
          cleanupErrors.push(error)
        }
      }
      if (snapshotId) {
        try {
          await provider.deleteSnapshot?.({ snapshotId })
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
        "Native snapshot replay proof and cleanup failed",
        primaryError === undefined ? undefined : { cause: primaryError },
      )
    if (primaryError !== undefined) throw primaryError
  },
)

beforeAll(() => {
  const url = process.env.DATABASE_URL
  if (!url)
    throw new Error(
      "DATABASE_URL is required for native sandbox ownership proof",
    )
  initDb(url)
})

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await withOrgDbContext(fixture.orgId, (db) =>
      db.delete(workspaces).where(eq(workspaces.id, fixture.workspaceId)),
    )
    await getSystemDb()
      .delete(organizations)
      .where(eq(organizations.id, fixture.orgId))
  }
})

afterAll(closeDb)

async function makeStore() {
  const orgId = generateObjectId("org")
  const workspaceId = generateObjectId("ws")
  await getSystemDb().insert(organizations).values({
    id: orgId,
    slug: orgId,
    name: "Native sandbox ownership",
    createdAt: new Date(),
  })
  fixtures.push({ orgId, workspaceId })
  await withOrgDbContext(orgId, (db) =>
    db.insert(workspaces).values({
      id: workspaceId,
      orgId,
      slug: "context",
      displayName: "Context",
      workspaceRepositoryUrl: "https://example.test/context.git",
    }),
  )
  return postgresSandboxInstanceStore({
    orgId,
    workspaceId,
  })
}

runSandboxInstanceStoreConformance("native Postgres", makeStore)

it.each([
  "workspace",
  "conversation",
] as const)("rejects a global sandbox key collision across %s owners", async (scope) => {
  const orgId = generateObjectId("org")
  const firstWorkspaceId = generateObjectId("ws")
  const secondWorkspaceId = generateObjectId("ws")
  const firstConversationId = generateObjectId("conv")
  const secondConversationId = generateObjectId("conv")
  const key = `forced-global-key-collision-${orgId}`
  await getSystemDb().insert(organizations).values({
    id: orgId,
    slug: orgId,
    name: "Sandbox collision proof",
    createdAt: new Date(),
  })
  try {
    await withOrgDbContext(orgId, (db) =>
      db.transaction(async (tx) => {
        await tx.insert(workspaces).values([
          {
            id: firstWorkspaceId,
            orgId,
            slug: "collision-a",
            displayName: "Collision A",
            workspaceRepositoryUrl: "https://example.test/collision-a.git",
          },
          {
            id: secondWorkspaceId,
            orgId,
            slug: "collision-b",
            displayName: "Collision B",
            workspaceRepositoryUrl: "https://example.test/collision-b.git",
          },
        ])
        await tx.insert(conversations).values([
          {
            id: firstConversationId,
            orgId,
            workspaceId: firstWorkspaceId,
          },
          {
            id: secondConversationId,
            orgId,
            workspaceId:
              scope === "workspace" ? secondWorkspaceId : firstWorkspaceId,
          },
        ])
      }),
    )
    const first = postgresSandboxInstanceStore({
      orgId,
      workspaceId: firstWorkspaceId,
      conversationId: firstConversationId,
      provider: "docker",
      image: "node:22",
    })
    const second = postgresSandboxInstanceStore({
      orgId,
      workspaceId: scope === "workspace" ? secondWorkspaceId : firstWorkspaceId,
      conversationId: secondConversationId,
      provider: "docker",
      image: "node:22",
    })
    const owned: SandboxInstanceRecord = {
      key,
      provider: "docker",
      providerSandboxId: "container-owned-by-a",
      threadId: firstConversationId,
      updatedAt: 1,
    }
    await first.upsert(owned)
    await expect(second.get(key)).rejects.toThrow(
      "already owned by another workspace identity",
    )
    await expect(
      second.upsert({
        ...owned,
        providerSandboxId: "container-owned-by-b",
        threadId: secondConversationId,
      }),
    ).rejects.toThrow("already owned by another workspace identity")
    await expect(second.delete(key)).rejects.toThrow(
      "already owned by another workspace identity",
    )
    expect(await first.get(key)).toEqual(owned)
  } finally {
    await withOrgDbContext(orgId, (db) =>
      db.transaction(async (tx) => {
        await tx.delete(conversations).where(eq(conversations.orgId, orgId))
        await tx.delete(workspaces).where(eq(workspaces.orgId, orgId))
      }),
    )
    await getSystemDb().delete(organizations).where(eq(organizations.id, orgId))
  }
})

it("moves a sandbox to the fenced revision without requiring the old revision to match", async () => {
  const orgId = generateObjectId("org")
  const workspaceId = generateObjectId("ws")
  const conversationId = generateObjectId("conv")
  const oldSha = "1".repeat(40)
  const newSha = "2".repeat(40)
  const oldKey = `transition-old-key-${orgId}`
  const nextKey = `transition-next-key-${orgId}`
  const transitionKey = `stable-transition-${orgId}`
  const remote = {
    url: "https://example.test/transition.git",
    connectionId: null,
  }
  const oldRevision = {
    workspaceId,
    generation: 1,
    remote,
    defaultBranch: "main",
    sha: oldSha,
    access: "read" as const,
  }
  const nextRevision = { ...oldRevision, sha: newSha }
  await getSystemDb().insert(organizations).values({
    id: orgId,
    slug: orgId,
    name: "Sandbox transition proof",
    createdAt: new Date(),
  })
  try {
    await withOrgDbContext(orgId, (db) =>
      db.transaction(async (tx) => {
        await tx.insert(workspaces).values({
          id: workspaceId,
          orgId,
          slug: "transition",
          displayName: "Transition",
          workspaceRepositoryUrl: remote.url,
          desiredGeneration: nextRevision.generation,
          desiredSha: nextRevision.sha,
          desiredDefaultBranch: nextRevision.defaultBranch,
        })
        await tx.insert(conversations).values({
          id: conversationId,
          orgId,
          workspaceId,
        })
      }),
    )
    await persistSandboxInstance({
      id: oldKey,
      kind: "chat",
      orgId,
      workspaceId,
      conversationId,
      provider: "docker",
      providerSandboxId: "transition-container",
      image: "node:22",
      transitionKey,
      revision: oldRevision,
      state: "live",
      lastHeartbeatAt: new Date(1),
    })
    const store = postgresSandboxInstanceStore({
      orgId,
      workspaceId,
      conversationId,
      revision: nextRevision,
      image: "node:22",
      provider: "docker",
    })
    const previous = await store.findByTransitionKey?.(transitionKey)
    if (!previous) throw new Error("Expected previous transition owner")
    await store.move?.(previous.key, {
      ...previous,
      key: nextKey,
      updatedAt: 2,
    })
    expect(await store.get(nextKey)).toMatchObject({
      key: nextKey,
      providerSandboxId: "transition-container",
      threadId: conversationId,
    })
  } finally {
    await withOrgDbContext(orgId, (db) =>
      db.transaction(async (tx) => {
        await tx.delete(conversations).where(eq(conversations.orgId, orgId))
        await tx.delete(workspaces).where(eq(workspaces.orgId, orgId))
      }),
    )
    await getSystemDb().delete(organizations).where(eq(organizations.id, orgId))
  }
})

const original: SandboxInstanceRecord = {
  key: "revision-a",
  provider: "docker",
  providerSandboxId: "container-a",
  threadId: "thread-1",
  latestSnapshotId: "snapshot-a",
  updatedAt: 1,
}

it("does not attach another revision when an exact sandbox key is absent", async () => {
  const store = await makeStore()
  await store.upsert(original)
  expect(await store.get("revision-b")).toBeNull()
})

it("keeps native identities for two revisions of the same thread distinct", async () => {
  const store = await makeStore()
  await store.upsert(original)
  const next = {
    ...original,
    key: "revision-b",
    providerSandboxId: "container-b",
    latestSnapshotId: "snapshot-b",
  }
  await store.upsert(next)
  expect(await store.get(original.key)).toEqual(original)
  expect(await store.get(next.key)).toEqual(next)
})

it("one static definition isolates runtime bindings, rotates secrets and saves the selected workspace", async () => {
  const store = await makeStore()
  const fixture = fixtures.at(-1)
  if (!fixture) throw new Error("Native ownership fixture missing")
  const locks = postgresSandboxLocks(fixture.orgId)
  const definition = defineSandbox({
    id: "static-runtime-workspace",
    provider: localProcessSandbox(),
    lifecycle: { reuse: "thread", snapshot: "none" },
  })
  const common = {
    threadId: "same-thread",
    runId: "runtime-binding",
    store,
    locks,
    tenant: { orgId: fixture.orgId },
  }
  const workspace = {
    identity: "revision-a",
    source: { type: "none" as const },
    setup: ["printf '%s' 'native bound workspace' > marker.txt"],
    secrets: createSecrets({ FIXTURE_TOKEN: "credential-a" }),
  }
  const a = { ...common, workspace }
  const b = {
    ...common,
    workspace: {
      ...workspace,
      identity: "revision-b",
      secrets: createSecrets({ FIXTURE_TOKEN: "credential-b" }),
    },
  }
  try {
    expect(definition.key(a)).not.toBe(definition.key(b))
    const [first, second] = await Promise.all([
      definition.ensure(a),
      definition.ensure(b),
    ])
    expect(first.id).not.toBe(second.id)
    await first.fs.write("/workspace/marker.txt", "first binding edit")
    expect(await second.fs.read("/workspace/marker.txt")).toBe(
      "native bound workspace",
    )
    const rotated = {
      ...a,
      workspace: {
        ...workspace,
        secrets: createSecrets({ FIXTURE_TOKEN: "credential-c" }),
      },
    }
    const resumed = await definition.ensureExisting(rotated)
    expect(resumed?.id).toBe(first.id)
    expect(
      (await resumed?.process.exec("printenv FIXTURE_TOKEN"))?.stdout.trim(),
    ).toBe("credential-c")
    expect(
      (await second.process.exec("printenv FIXTURE_TOKEN")).stdout.trim(),
    ).toBe("credential-b")
    const snapshotInput = {
      sandbox: definition,
      instances: store,
      locks,
      tenant: common.tenant,
      workspace: rotated.workspace,
    }
    const snapshots = await memorySandboxSnapshots(snapshotInput)
    const checkpoint = await snapshots.save({
      threadId: common.threadId,
      runId: "named",
      label: "selected revision",
    })
    const file = checkpoint.files.find((entry) => entry.path === "marker.txt")
    if (file?.kind !== "file")
      throw new Error("Named snapshot omitted the selected workspace")
    const blob = await snapshots.persistence.stores.blobs.get(file.blobKey)
    expect(new TextDecoder().decode(await blob?.arrayBuffer())).toBe(
      "first binding edit",
    )
    await definition.destroy(a)
    expect(await definition.ensureExisting(a)).toBeNull()
    expect(await second.fs.read("/workspace/marker.txt")).toBe(
      "native bound workspace",
    )
  } finally {
    await definition.destroy(a)
    await definition.destroy(b)
  }
})

it(
  "cancels an in-flight native Docker filesystem write before a new owner can use the worktree",
  { timeout: 30_000 },
  async () => {
    const provider = dockerSandbox(WORKSPACE_CHAT_DOCKER_SANDBOX)
    const handle = await provider.create({
      workspace: { source: { type: "none" } },
    })
    const controller = new AbortController()
    let settled = false
    let failure = ""
    try {
      expect((await handle.process.exec("mkfifo blocked-write")).exitCode).toBe(
        0,
      )
      const pending = handle.fs
        .write("/workspace/blocked-write", "must not survive lease loss", {
          signal: controller.signal,
        })
        .then(
          () => {
            settled = true
            return "completed"
          },
          (error) => {
            settled = true
            failure = String(error)
            return "aborted"
          },
        )
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(settled, failure).toBe(false)
      controller.abort(new Error("Native ownership lost"))
      await expect.poll(() => settled, { timeout: 5_000 }).toBe(true)
      expect(await pending).toBe("aborted")
      const observed = await handle.process.exec("timeout 1 cat blocked-write")
      expect(observed.stdout).toBe("")
      expect(observed.exitCode).toBe(124)
      const valid = new AbortController()
      await handle.fs.write(
        "relative-notes.md",
        "A subsequent owner can write",
        { signal: valid.signal },
      )
      expect(
        await handle.fs.read("relative-notes.md", { signal: valid.signal }),
      ).toBe("A subsequent owner can write")
      await handle.fs.remove("relative-notes.md", { signal: valid.signal })
    } finally {
      controller.abort()
      await handle.destroy()
    }
  },
)

it(
  "keeps native Docker environment credentials out of request URLs",
  { timeout: 30_000 },
  async () => {
    const host = process.env.CTXPIPE_TEST_QUOTA_DOCKER_HOST
    const port = Number(process.env.CTXPIPE_TEST_QUOTA_DOCKER_PORT)
    if (!host || !Number.isInteger(port) || port <= 0)
      throw new Error("Native quota Docker endpoint is required")
    const paths: string[] = []
    let createBody = ""
    const proxy = createServer((request, response) => {
      paths.push(request.url ?? "")
      if (request.url?.includes("/containers/create"))
        request.on("data", (chunk) => {
          createBody += chunk.toString()
        })
      const upstream = httpRequest(
        {
          hostname: host,
          port,
          path: request.url,
          method: request.method,
          headers: request.headers,
        },
        (result) => {
          response.writeHead(result.statusCode ?? 502, result.headers)
          result.pipe(response)
        },
      )
      upstream.on("error", (error) => response.destroy(error))
      request.pipe(upstream)
    })
    await new Promise<void>((resolve, reject) => {
      proxy.once("error", reject)
      proxy.listen(0, "127.0.0.1", resolve)
    })
    const address = proxy.address()
    if (!address || typeof address === "string")
      throw new Error("Docker transport proxy did not bind")
    const provider = dockerSandbox({
      image: "alpine:3.22",
      workdir: "/tmp",
      keepAliveCommand: ["/ctxpipe-deliberately-missing-command"],
      dockerodeOptions: { host: "127.0.0.1", port: address.port },
    })
    try {
      await expect(
        provider.create({
          workspace: { source: { type: "none" } },
          env: { SYNTHETIC_CREDENTIAL: "ctxpipe-native-env-not-in-url" },
        }),
      ).rejects.toThrow(/no such file or directory|executable file not found/i)
      expect(JSON.parse(createBody).Env).toContain(
        "SYNTHETIC_CREDENTIAL=ctxpipe-native-env-not-in-url",
      )
      expect(
        paths.some((path) =>
          decodeURIComponent(path).includes("ctxpipe-native-env-not-in-url"),
        ),
      ).toBe(false)
    } finally {
      proxy.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        proxy.close((error) => (error ? reject(error) : resolve())),
      )
    }
  },
)

it(
  "preserves native Docker image and container environment during commands",
  { timeout: 30_000 },
  async () => {
    const host = process.env.CTXPIPE_TEST_QUOTA_DOCKER_HOST
    const port = Number(process.env.CTXPIPE_TEST_QUOTA_DOCKER_PORT)
    if (!host || !Number.isInteger(port) || port <= 0)
      throw new Error("Native quota Docker endpoint is required")
    const provider = dockerSandbox({
      image: "alpine:3.22",
      workdir: "/tmp",
      dockerodeOptions: { host, port },
    })
    const handle = await provider.create({
      env: { HOME: "/tmp/native-home", NATIVE_ENV: "container" },
    })
    try {
      await handle.env.set({ NATIVE_RUNTIME: "session" })
      const result = await handle.process.exec(
        'printf "%s|%s|%s|%s" "$HOME" "$NATIVE_ENV" "$NATIVE_RUNTIME" "$NATIVE_COMMAND"',
        { env: { NATIVE_COMMAND: "command" } },
      )
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe("/tmp/native-home|container|session|command")
      const resumed = await provider.resume({ id: handle.id })
      if (!resumed) throw new Error("Native Docker container did not resume")
      expect((await resumed.process.exec('printf "%s" "$HOME"')).stdout).toBe(
        "/tmp/native-home",
      )
    } finally {
      await handle.destroy()
    }
  },
)

it(
  "waits for a native Docker process after readiness consumption and kill",
  { timeout: 30_000 },
  async () => {
    const host = process.env.CTXPIPE_TEST_QUOTA_DOCKER_HOST
    const port = Number(process.env.CTXPIPE_TEST_QUOTA_DOCKER_PORT)
    if (!host || !Number.isInteger(port) || port <= 0)
      throw new Error("Native quota Docker endpoint is required")
    const handle = await dockerSandbox({
      image: "alpine:3.22",
      workdir: "/tmp",
      dockerodeOptions: { host, port },
    }).create({})
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const process = await handle.process.spawn(
        'printf "ready\\n"; exec sleep 60',
      )
      for await (const chunk of process.stdout) {
        expect(chunk).toContain("ready")
        break
      }
      await process.kill()
      // The transport may already be closed when its owner starts awaiting it.
      const status = await Promise.race([
        process.wait(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Native process wait missed termination")),
            3_000,
          )
        }),
      ])
      expect(typeof status).toBe("number")
    } finally {
      if (timer) clearTimeout(timer)
      await handle.destroy()
    }
  },
)

it(
  "connects to native Docker published ports through the public channel",
  { timeout: 60_000 },
  async () => {
    const host = process.env.CTXPIPE_TEST_QUOTA_DOCKER_HOST
    const port = Number(process.env.CTXPIPE_TEST_QUOTA_DOCKER_PORT)
    if (!host || !Number.isInteger(port) || port <= 0)
      throw new Error("Native quota Docker endpoint is required")
    const dockerodeOptions = { host, port }
    const docker = new Dockerode(dockerodeOptions)
    const baseConfig = {
      image: "alpine:3.22",
      workdir: "/tmp",
      dockerodeOptions,
      publishPorts: [8080],
    }
    const defaultProvider = dockerSandbox(baseConfig)
    const overrideProvider = dockerSandbox({
      ...baseConfig,
      advertisedPortHost: "http://localhost",
    })

    type RunningServer = {
      handle: SandboxHandle
      process: Awaited<ReturnType<SandboxHandle["process"]["spawn"]>>
      channel: { url: string }
    }
    async function startServer(
      provider: typeof defaultProvider,
      body: string,
    ): Promise<RunningServer> {
      const handle = await provider.create({
        workspace: { source: { type: "none" } },
      })
      let serverProcess: RunningServer["process"] | undefined
      try {
        const responseScript = [
          "#!/bin/sh",
          `body=${shellQuote(body)}`,
          `printf 'HTTP/1.1 200 OK\\r\\nContent-Length: %s\\r\\nConnection: close\\r\\nContent-Type: text/plain\\r\\n\\r\\n%s' "\${#body}" "$body"`,
        ].join("\n")
        await handle.fs.write("reply.sh", responseScript)
        await handle.process.exec("chmod +x reply.sh", { cwd: "/tmp" })
        serverProcess = await handle.process.spawn(
          "nc -lk -p 8080 -e /tmp/reply.sh",
          { cwd: "/tmp" },
        )
        const channel = await handle.ports.connect(8080)
        return { handle, process: serverProcess, channel }
      } catch (error) {
        const cleanup = await Promise.allSettled([
          serverProcess?.kill() ?? Promise.resolve(),
          handle.destroy(),
        ])
        const cleanupErrors = cleanup
          .filter(
            (result): result is PromiseRejectedResult =>
              result.status === "rejected",
          )
          .map((result) => result.reason)
        if (cleanupErrors.length)
          throw new AggregateError(
            [error, ...cleanupErrors],
            "Native port server startup and cleanup failed",
          )
        throw error
      }
    }
    async function fetchBody(url: string, expected: string): Promise<void> {
      // The quota daemon runs inside a privileged runner. A host-network
      // client inside that same daemon can reach its published loopback ports
      // even when the outer development host cannot route into the runner.
      const client = await docker.createContainer({
        Image: "alpine:3.22",
        Cmd: [
          "sh",
          "-c",
          `for attempt in $(seq 1 30); do wget -qO- --timeout=1 --tries=1 ${shellQuote(url)} && exit 0; sleep 0.1; done; exit 1`,
        ],
        HostConfig: { AutoRemove: false, NetworkMode: "host" },
      })
      try {
        await client.start()
        const result = await client.wait()
        const logs = await client.logs({ stderr: true, stdout: true })
        const output = logs.toString()
        expect(result.StatusCode, output).toBe(0)
        expect(output).toContain(expected)
      } finally {
        await removeClient(client)
      }
    }
    function shellQuote(value: string): string {
      return `'${value.replaceAll("'", "'\\''")}'`
    }
    async function removeClient(client: Dockerode.Container): Promise<void> {
      try {
        await client.remove({ force: true, v: true })
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "statusCode" in error &&
            error.statusCode === 404
          )
        )
          throw error
      }
    }
    async function disposeServer(server: RunningServer | undefined) {
      if (!server) return
      const cleanup = await Promise.allSettled([
        server.process.kill(),
        server.handle.destroy(),
      ])
      const cleanupErrors = cleanup
        .filter(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        )
        .map((result) => result.reason)
      if (cleanupErrors.length)
        throw new AggregateError(
          cleanupErrors,
          "Native port server cleanup failed",
        )
    }

    let defaultServer: RunningServer | undefined
    let overrideServer: RunningServer | undefined
    let testError: unknown
    try {
      defaultServer = await startServer(defaultProvider, "default-channel")
      const defaultUrl = new URL(defaultServer.channel.url)
      expect(defaultUrl.hostname).toBe(host)
      await fetchBody(defaultUrl.href, "default-channel")

      overrideServer = await startServer(overrideProvider, "override-channel")
      const overrideUrl = new URL(overrideServer.channel.url)
      expect(overrideUrl.hostname).toBe("localhost")
      await fetchBody(overrideUrl.href, "override-channel")
    } catch (error) {
      testError = error
    }
    const cleanup = await Promise.allSettled([
      disposeServer(overrideServer),
      disposeServer(defaultServer),
    ])
    const cleanupErrors = cleanup
      .filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      )
      .map((result) => result.reason)
    if (testError && cleanupErrors.length)
      throw new AggregateError(
        [testError, ...cleanupErrors],
        "Native port contract and cleanup both failed",
      )
    if (testError) throw testError
    if (cleanupErrors.length)
      throw new AggregateError(cleanupErrors, "Native port cleanup failed")
  },
)

it(
  "owns native Docker fork images through teardown and process loss",
  { timeout: 60_000 },
  async () => {
    const host = process.env.CTXPIPE_TEST_QUOTA_DOCKER_HOST
    const port = Number(process.env.CTXPIPE_TEST_QUOTA_DOCKER_PORT)
    if (!host || !Number.isInteger(port) || port <= 0)
      throw new Error("Native quota Docker endpoint is required")
    const dockerodeOptions = { host, port }
    const docker = new Dockerode(dockerodeOptions)
    const config = { image: "alpine:3.22", workdir: "/tmp", dockerodeOptions }
    const provider = dockerSandbox(config)
    const containers = new Set<string>()
    const images = new Set<string>()
    const input = { workspace: { source: { type: "none" as const } } }
    async function removeContainer(id: string) {
      try {
        await docker.getContainer(id).remove({ force: true, v: true })
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "statusCode" in error &&
            error.statusCode === 404
          )
        )
          throw error
      }
    }
    async function removeImage(id: string) {
      try {
        await docker.getImage(id).remove()
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "statusCode" in error &&
            error.statusCode === 404
          )
        )
          throw error
      }
    }
    try {
      const parent = await provider.create(input)
      containers.add(parent.id)
      if (!parent.fork) throw new Error("Native Docker fork is required")
      const child = await parent.fork()
      containers.add(child.id)
      const image = (await docker.getContainer(child.id).inspect()).Image
      images.add(image)
      await child.destroy()
      await expect(docker.getImage(image).inspect()).rejects.toMatchObject({
        statusCode: 404,
      })

      const second = await parent.fork()
      containers.add(second.id)
      const secondImage = (await docker.getContainer(second.id).inspect()).Image
      images.add(secondImage)
      const restarted = dockerSandbox(config)
      const resumed = await restarted.resume({ id: second.id })
      if (!resumed?.snapshot)
        throw new Error("Native Docker resume and snapshot are required")
      const snapshot = await resumed.snapshot("owned-fork")
      images.add(snapshot.id)
      await resumed.destroy()
      // A durable snapshot can retain its ancestor layer until explicitly deleted.
      expect((await docker.getImage(snapshot.id).inspect()).Id).toMatch(
        /^sha256:/,
      )

      const third = await parent.fork()
      containers.add(third.id)
      const thirdImage = (await docker.getContainer(third.id).inspect()).Image
      images.add(thirdImage)
      await provider.destroy({ id: parent.id })
      // A source can disappear while its child still legitimately owns the image.
      expect((await docker.getImage(thirdImage).inspect()).Id).toBe(thirdImage)
      // Docker survives a lost caller; a later provider operation collects its orphan.
      await removeContainer(third.id)
      const next = await dockerSandbox(config).create(input)
      containers.add(next.id)
      await expect(docker.getImage(thirdImage).inspect()).rejects.toMatchObject(
        { statusCode: 404 },
      )
      expect((await docker.getImage(snapshot.id).inspect()).Id).toMatch(
        /^sha256:/,
      )
      if (!restarted.deleteSnapshot)
        throw new Error("Native snapshot deletion is required")
      await restarted.deleteSnapshot({ snapshotId: snapshot.id })
      await restarted.destroy({ id: next.id })
      await expect(
        docker.getImage(secondImage).inspect(),
      ).rejects.toMatchObject({ statusCode: 404 })
    } finally {
      for (const id of containers) await removeContainer(id)
      for (const id of [...images].reverse()) await removeImage(id)
    }
  },
)

it(
  "cleans the native Docker fork image when its container cannot start",
  { timeout: 30_000 },
  async () => {
    const host = process.env.CTXPIPE_TEST_QUOTA_DOCKER_HOST
    const port = Number(process.env.CTXPIPE_TEST_QUOTA_DOCKER_PORT)
    if (!host || !Number.isInteger(port) || port <= 0)
      throw new Error("Native quota Docker endpoint is required")
    const dockerodeOptions = { host, port }
    const docker = new Dockerode(dockerodeOptions)
    const provider = dockerSandbox({
      image: "alpine:3.22",
      workdir: "/tmp",
      dockerodeOptions,
    })
    const parent = await provider.create({
      workspace: { source: { type: "none" } },
    })
    try {
      if (!parent.fork) throw new Error("Native Docker fork is required")
      // The original process stays alive, but the committed image cannot boot.
      const before = (await docker.listContainers({ all: true }))
        .map((container) => container.Id)
        .sort()
      await parent.fs.remove("/bin/sh")
      await expect(parent.fork()).rejects.toThrow(
        /executable file not found|no such file or directory/i,
      )
      const images = await docker.listImages({
        filters: {
          reference: [`tanstack-ai-sandbox-fork:${parent.id.slice(0, 12)}-*`],
        },
      })
      expect(images).toEqual([])
      const containers = await docker.listContainers({ all: true })
      expect(containers.map((container) => container.Id).sort()).toEqual(before)
    } finally {
      await parent.destroy()
    }
  },
)

it(
  "enforces native Docker resource limits across resume and snapshots",
  { timeout: 180_000 },
  async () => {
    const host = process.env.CTXPIPE_TEST_QUOTA_DOCKER_HOST
    const port = Number.parseInt(
      process.env.CTXPIPE_TEST_QUOTA_DOCKER_PORT ?? "",
      10,
    )
    if (!host || !Number.isInteger(port) || port <= 0)
      throw new Error(
        "CTXPIPE_TEST_QUOTA_DOCKER_HOST and CTXPIPE_TEST_QUOTA_DOCKER_PORT are required",
      )

    const dockerodeOptions = { host, port }
    const docker = new Dockerode(dockerodeOptions)
    const policy = {
      user: "1000:1000",
      diskSize: "4G",
      memoryBytes: 1024 ** 3,
      nanoCpus: 1_000_000_000,
      pidsLimit: 128,
    }
    const provider = dockerSandbox({
      image: "alpine:3.22",
      workdir: "/tmp",
      dockerodeOptions,
      isolationPolicy: policy,
    })
    const cleanup = new Map<string, () => Promise<void>>()

    async function inspectPolicy(handle: { id: string }) {
      const info = await docker.getContainer(handle.id).inspect()
      expect(info.Config.User).toBe(policy.user)
      expect(info.HostConfig.NanoCpus).toBe(policy.nanoCpus)
      expect(info.HostConfig.Memory).toBe(policy.memoryBytes)
      expect(info.HostConfig.MemorySwap).toBe(policy.memoryBytes)
      expect(info.HostConfig.PidsLimit).toBe(policy.pidsLimit)
      expect(info.HostConfig.StorageOpt?.size).toBe(policy.diskSize)
      return info
    }

    async function assertPreservedFile(handle: {
      id: string
      fs: { read: (path: string) => Promise<string> }
    }) {
      await inspectPolicy(handle)
      expect(await handle.fs.read("native-policy-proof.txt")).toBe(
        "bounded workspace",
      )
    }

    async function assertCreatedPolicy(handle: {
      id: string
      process: {
        exec: (
          command: string,
        ) => Promise<{ exitCode: number; stdout: string; stderr?: string }>
      }
      fs: {
        write: (path: string, data: string) => Promise<void>
        read: (path: string) => Promise<string>
      }
    }) {
      const info = await inspectPolicy(handle)
      expect(info.HostConfig.CapDrop).toEqual(["ALL"])
      expect(info.HostConfig.SecurityOpt).toContain("no-new-privileges:true")
      expect(info.HostConfig.Privileged).not.toBe(true)
      expect(info.HostConfig.Devices ?? []).toEqual([])
      expect(info.HostConfig.LogConfig?.Type).toBe("none")

      const cgroup = await handle.process.exec(
        `sh -eu -c '
if [ -r /sys/fs/cgroup/memory.max ]; then
  printf "memory=%s\\n" "$(cat /sys/fs/cgroup/memory.max)"
  printf "pids=%s\\n" "$(cat /sys/fs/cgroup/pids.max)"
  printf "cpu=%s\\n" "$(cat /sys/fs/cgroup/cpu.max)"
else
  printf "memory=%s\\n" "$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes)"
  printf "pids=%s\\n" "$(cat /sys/fs/cgroup/pids/pids.max)"
  printf "cpu=%s/%s\\n" "$(cat /sys/fs/cgroup/cpu/cpu.cfs_quota_us)" "$(cat /sys/fs/cgroup/cpu/cpu.cfs_period_us)"
fi'`,
      )
      expect(cgroup.exitCode).toBe(0)
      expect(cgroup.stdout).toContain("memory=1073741824")
      expect(cgroup.stdout).toContain("pids=128")
      expect(cgroup.stdout).toMatch(/cpu=(100000 100000|100000\/100000)/)

      const identity = await handle.process.exec("id -u")
      expect(identity.exitCode).toBe(0)
      expect(Number.parseInt(identity.stdout.trim(), 10)).toBeGreaterThan(0)

      await handle.fs.write("native-policy-proof.txt", "bounded workspace")
      expect(await handle.fs.read("native-policy-proof.txt")).toBe(
        "bounded workspace",
      )
      // count=1 so BusyBox cannot buffer the 4 GiB fill. oflag=direct keeps
      // each 8 MiB write out of the 1 GiB page cache (conv=fsync every 1 MiB
      // ran ~150s on nested Btrfs and still OOM-killed before EDQUOT). Keep
      // the failing write on disk; Docker demux can drop the last stderr frame.
      const quotaWrite = await handle.process.exec(
        `sh -eu -c '
set +e
err=/tmp/native-policy-quota.err
: > /tmp/native-policy-quota.bin
i=0
status=0
while [ "$i" -lt 640 ]; do
  dd if=/dev/zero of=/tmp/native-policy-quota.bin bs=8192k count=1 seek="$i" oflag=direct conv=notrunc >"$err" 2>&1
  status=$?
  [ "$status" -eq 0 ] || break
  i=$((i + 1))
done
rm -f /tmp/native-policy-quota.bin
printf "quota-status=%s\\nquota-blocks=%s\\n" "$status" "$i"'`,
      )
      const quotaError = await handle.process.exec(
        "cat /tmp/native-policy-quota.err",
      )
      const quotaLog = `write:${quotaWrite.stdout}\nerror:${quotaError.stdout}`
      expect(quotaError.exitCode, quotaLog).toBe(0)
      expect(quotaError.stdout, quotaLog).toMatch(/quota exceeded/i)
      expect(quotaWrite.stdout, quotaLog).toMatch(/quota-status=[1-9]\d*/)
      expect(
        Number(/quota-blocks=(\d+)/.exec(quotaWrite.stdout)?.[1]),
        quotaLog,
      ).toBeGreaterThanOrEqual(500)
    }

    let testError: unknown
    try {
      const created = await provider.create({
        workspace: { source: { type: "none" } },
      })
      cleanup.set(`container:${created.id}`, () => created.destroy())
      await assertCreatedPolicy(created)

      const resumed = await provider.resume({ id: created.id })
      if (!resumed) throw new Error("Configured container did not resume")
      await assertPreservedFile(resumed)

      if (!created.snapshot || !created.fork)
        throw new Error("Docker handle must support native snapshots and forks")
      const snapshot = await created.snapshot("resource-policy")
      if (!provider.deleteSnapshot)
        throw new Error("Docker provider cannot delete snapshots")
      const deleteSnapshot = provider.deleteSnapshot.bind(provider)
      cleanup.set(`snapshot:${snapshot.id}`, () =>
        deleteSnapshot({ snapshotId: snapshot.id }),
      )
      if (!provider.restoreSnapshot)
        throw new Error("Docker provider cannot restore snapshots")
      const restored = await provider.restoreSnapshot({
        snapshotId: snapshot.id,
      })
      cleanup.set(`container:${restored.id}`, () => restored.destroy())
      await assertPreservedFile(restored)

      const forked = await created.fork()
      cleanup.set(`container:${forked.id}`, () => forked.destroy())
      await assertPreservedFile(forked)

      const insecureName = `ctxpipe-native-policy-insecure-${Date.now()}`
      const insecure = await docker.createContainer({
        name: insecureName,
        Image: "alpine:3.22",
        Cmd: ["sh", "-c", "tail -f /dev/null"],
      })
      cleanup.set(`container:${insecureName}`, () =>
        insecure.remove({ force: true, v: true }),
      )
      await insecure.start()
      await expect(provider.resume({ id: insecureName })).rejects.toThrow(
        /isolation policy/i,
      )
    } catch (error) {
      testError = error
    }

    const cleanupErrors: unknown[] = []
    // Remove containers before their backing images, and actually invoke each disposer.
    for (const containers of [true, false]) {
      const results = await Promise.allSettled(
        [...cleanup]
          .filter(([key]) => key.startsWith("container:") === containers)
          .map(([, dispose]) => dispose()),
      )
      for (const result of results)
        if (result.status === "rejected") cleanupErrors.push(result.reason)
    }
    if (testError && cleanupErrors.length)
      throw new AggregateError(
        [testError, ...cleanupErrors],
        "Native Docker policy proof and cleanup both failed",
      )
    if (testError) throw testError
    if (cleanupErrors.length)
      throw new AggregateError(
        cleanupErrors,
        "Native Docker policy cleanup failed",
      )
  },
)
