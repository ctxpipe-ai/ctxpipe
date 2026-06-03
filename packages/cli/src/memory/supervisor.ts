import { spawn, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import {
  agentMemoryHomeDir,
  ensureRepoStateDir,
  runtimeStateFile,
  type RepoFingerprint,
} from "./paths.js"

export const PINNED_AGENTMEMORY_VERSION = "0.9.21"

export type AgentMemoryPorts = {
  rest: number
  streams: number
  viewer: number
  engineWs: number
}

export type RuntimeState = {
  provider: "agentmemory"
  agentmemoryVersion: string
  url: string
  viewerUrl: string
  pid: number
  startedAt: string
  mode: "local-only" | "signed-in"
  hostedModel: "available" | "signed-out"
  ports: AgentMemoryPorts
  /** AgentMemory REST bearer; env + in-process only (omitted from runtime.json). */
  secret?: string
}

export type SupervisorOptions = {
  fingerprint: RepoFingerprint
  /** Override for tests. Defaults to `npx -y @agentmemory/agentmemory@<pin>`. */
  command?: { command: string; args: string[] }
  /** Optional callback that returns the OAuth bearer to forward as OPENAI_API_KEY. */
  getAccessToken?: () => Promise<string | null>
  /** Override for tests so we can keep tests fully offline. */
  liveZUrl?: (ports: AgentMemoryPorts) => string
  /** OpenAI base URL to forward chat/embeddings through; usually the backend proxy. */
  openaiBaseUrl?: string
  chatModel?: string
  embeddingModel?: string
  /** Max ms to wait for /agentmemory/livez. Default 30_000. */
  readinessTimeoutMs?: number
}

export type Supervisor = {
  /** Returns existing state if alive, otherwise spawns the runtime and waits for livez. */
  ensureRunning(): Promise<RuntimeState>
  /** Stop the runtime if we started it; returns true if we killed something. */
  stop(): Promise<boolean>
  /** Return the current state or null if nothing is running. */
  current(): RuntimeState | null
}

export function createSupervisor(opts: SupervisorOptions): Supervisor {
  let child: ChildProcess | null = null
  let runtime: RuntimeState | null = readSavedRuntime(opts.fingerprint)
  if (runtime && !isPidAlive(runtime.pid)) {
    runtime = null
    clearSavedRuntime(opts.fingerprint)
  }

  async function ensureRunning(): Promise<RuntimeState> {
    if (runtime?.secret && isPidAlive(runtime.pid)) return runtime
    if (runtime && isPidAlive(runtime.pid) && !runtime.secret) {
      try {
        process.kill(runtime.pid, "SIGTERM")
      } catch {
        // ignored
      }
      clearSavedRuntime(opts.fingerprint)
      runtime = null
    }
    const ports = await allocatePorts()
    const secret = generateAgentMemorySecret()
    const home = ensureHome(opts.fingerprint)
    const accessToken = opts.getAccessToken
      ? await opts.getAccessToken().catch(() => null)
      : null
    const cmd = opts.command ?? {
      command: process.platform === "win32" ? "npx.cmd" : "npx",
      args: ["-y", `@agentmemory/agentmemory@${PINNED_AGENTMEMORY_VERSION}`],
    }
    const env: Record<string, string> = {
      ...process.env,
      HOME: home,
      AGENTMEMORY_SECRET: secret,
      AGENTMEMORY_URL: `http://127.0.0.1:${ports.rest}`,
      AGENTMEMORY_AUTO_COMPRESS: "false",
      AGENTMEMORY_INJECT_CONTEXT: "false",
      CONSOLIDATION_ENABLED: "false",
      GRAPH_EXTRACTION_ENABLED: "false",
      III_REST_PORT: String(ports.rest),
      III_STREAMS_PORT: String(ports.streams),
      III_VIEWER_PORT: String(ports.viewer),
      III_ENGINE_PORT: String(ports.engineWs),
      CTXPIPE_AGENTMEMORY_PORTS: JSON.stringify(ports),
    }
    if (accessToken && opts.openaiBaseUrl) {
      env.OPENAI_BASE_URL = opts.openaiBaseUrl
      env.OPENAI_API_KEY = accessToken
      if (opts.chatModel) env.OPENAI_MODEL = opts.chatModel
      if (opts.embeddingModel) env.OPENAI_EMBEDDING_MODEL = opts.embeddingModel
    }
    child = spawn(cmd.command, cmd.args, {
      env,
      cwd: home,
      stdio: ["ignore", "pipe", "pipe"],
    })
    child.unref()
    const liveZ = (opts.liveZUrl ?? defaultLiveZ)(ports)
    const ok = await waitForLiveZ(liveZ, opts.readinessTimeoutMs ?? 30_000, () =>
      child !== null && child.exitCode === null,
    )
    if (!ok) {
      try {
        child?.kill("SIGTERM")
      } catch {
        // ignored
      }
      throw new Error(
        `AgentMemory failed to become ready at ${liveZ} within ${opts.readinessTimeoutMs ?? 30_000}ms`,
      )
    }
    runtime = {
      provider: "agentmemory",
      agentmemoryVersion: PINNED_AGENTMEMORY_VERSION,
      url: `http://127.0.0.1:${ports.rest}`,
      viewerUrl: `http://127.0.0.1:${ports.viewer}`,
      pid: child.pid ?? -1,
      startedAt: new Date().toISOString(),
      mode: accessToken ? "signed-in" : "local-only",
      hostedModel: accessToken ? "available" : "signed-out",
      ports,
      secret,
    }
    // Persist a copy without the secret so it never reaches disk.
    const { secret: _omitSecret, ...persisted } = runtime
    persistRuntime(opts.fingerprint, persisted as RuntimeState)
    return runtime
  }

  async function stop(): Promise<boolean> {
    if (!runtime) return false
    let killed = false
    try {
      process.kill(runtime.pid, "SIGTERM")
      killed = true
    } catch {
      killed = false
    }
    clearSavedRuntime(opts.fingerprint)
    runtime = null
    child = null
    return killed
  }

  function current(): RuntimeState | null {
    return runtime
  }

  return { ensureRunning, stop, current }
}

function defaultLiveZ(ports: AgentMemoryPorts): string {
  return `http://127.0.0.1:${ports.rest}/agentmemory/livez`
}

async function waitForLiveZ(
  url: string,
  timeoutMs: number,
  childAlive: () => boolean,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  let delay = 100
  while (Date.now() < deadline) {
    if (!childAlive()) return false
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) })
      if (res.ok) return true
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, delay))
    delay = Math.min(delay * 2, 1_500)
  }
  return false
}

export async function allocatePorts(): Promise<AgentMemoryPorts> {
  const [rest, streams, viewer, engineWs] = await Promise.all([
    allocateOne(),
    allocateOne(),
    allocateOne(),
    allocateOne(),
  ])
  return { rest, streams, viewer, engineWs }
}

function allocateOne(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer()
    srv.unref()
    srv.on("error", rej)
    srv.listen({ port: 0, host: "127.0.0.1" }, () => {
      const addr = srv.address()
      if (addr && typeof addr === "object") {
        const port = addr.port
        srv.close(() => res(port))
      } else {
        srv.close()
        rej(new Error("Could not allocate port"))
      }
    })
  })
}

function generateAgentMemorySecret(): string {
  return randomBytes(32).toString("hex")
}

function ensureHome(fingerprint: RepoFingerprint): string {
  ensureRepoStateDir(fingerprint)
  const home = agentMemoryHomeDir(fingerprint)
  if (!existsSync(home)) mkdirSync(home, { recursive: true })
  return home
}

function persistRuntime(
  fingerprint: RepoFingerprint,
  state: RuntimeState,
): void {
  ensureRepoStateDir(fingerprint)
  writeFileSync(runtimeStateFile(fingerprint), `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  })
}

function readSavedRuntime(fingerprint: RepoFingerprint): RuntimeState | null {
  const file = runtimeStateFile(fingerprint)
  if (!existsSync(file)) return null
  try {
    const raw = readFileSync(file, "utf8").trim()
    if (!raw) return null
    return JSON.parse(raw) as RuntimeState
  } catch {
    return null
  }
}

function clearSavedRuntime(fingerprint: RepoFingerprint): void {
  const file = runtimeStateFile(fingerprint)
  if (existsSync(file)) {
    try {
      writeFileSync(file, "")
    } catch {
      // ignored
    }
  }
}

function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
