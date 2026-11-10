import { randomBytes } from "node:crypto"
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http"

import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
  InvokeAgentRuntimeCommandCommand,
  ResourceNotFoundException,
  StopRuntimeSessionCommand,
} from "@aws-sdk/client-bedrock-agentcore"
import {
  createExecBackedGit,
  type ExecResult,
  type ProcessOptions,
  type SandboxCapabilities,
  type SandboxHandle,
  type SandboxProvider,
  type SpawnHandle,
} from "@tanstack/ai-sandbox"
import { z } from "zod"

import { log } from "../../observability/logger.js"

/**
 * Chat and ingest sandboxes on Amazon Bedrock AgentCore Runtime (CTX-1219).
 * One runtime session (a microVM) is one sandbox. The backend reaches a
 * session only through the AgentCore API over the VPC endpoint:
 *
 * - Commands, file operations and git go through `InvokeAgentRuntimeCommand`.
 *   A background process is one long command stream.
 * - A port in the session (the OpenCode server) goes through the image's
 *   shim (`scripts/chat-sandbox/agentcore-shim.mjs`): a loopback bridge in
 *   this process sends each HTTP request as one `InvokeAgentRuntime` call.
 *
 * A session lives until it is idle too long or reaches its lifetime limit.
 * Then AgentCore starts a new microVM for the same session id. A marker file
 * tells the two apart: `resume` gives null for a new microVM, and the caller
 * makes a new sandbox from git.
 */

/** The runtime that sessions run on. */
export type AgentCoreRuntime = {
  client: BedrockAgentCoreClient
  runtimeArn: string
  /**
   * The runtime endpoint. Production invokes a named endpoint, so that a new
   * sandbox image needs an explicit promote and can roll back at once;
   * previews use `DEFAULT`, which follows the newest version (ADR-061
   * decision 14, AWS migration design). AgentCore uses `DEFAULT` when it is
   * not set.
   */
  qualifier?: string
}

/**
 * The deployment's AgentCore runtime, or undefined when it has none. The
 * region comes from the runtime ARN.
 */
export function agentCoreRuntime(
  env: Record<string, string | undefined> = process.env,
): AgentCoreRuntime | undefined {
  const runtimeArn = env.AGENTCORE_RUNTIME_ARN?.trim()
  if (!runtimeArn) return undefined
  const region = runtimeArn.split(":")[3]
  if (!runtimeArn.startsWith("arn:") || !region)
    throw new Error("AGENTCORE_RUNTIME_ARN must be an AgentCore runtime ARN")
  return {
    // One attempt: a retry after a server error could run a command twice.
    client: new BedrockAgentCoreClient({ region, maxAttempts: 1 }),
    runtimeArn,
    qualifier: env.AGENTCORE_RUNTIME_QUALIFIER?.trim() || undefined,
  }
}

const AGENTCORE_CAPS: SandboxCapabilities = {
  fs: true,
  exec: true,
  env: true,
  ports: true,
  backgroundProcesses: true,
  writableStdin: false,
  killableProcesses: true,
  snapshots: false,
  networkPolicy: false,
  // The files go with the microVM; a new one starts empty.
  durableFilesystem: false,
  fork: false,
}

/**
 * Where a session keeps its marker and its create environment, its
 * workspace, and the Unix socket where commands read the shim's blobs.
 */
type SessionLayout = { state: string; workdir: string; shim: string }

/** POSIX single-quote escape for `sh -c`. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function exportLines(env: Record<string, string> | undefined): string {
  return Object.entries(env ?? {})
    .map(([name, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
        throw new Error(`Not a valid environment variable name: ${name}`)
      return `export ${name}=${shellQuote(value)}\n`
    })
    .join("")
}

/** One event of the shim's answer (see `agentcore-shim.mjs`). */
const shimEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("head"),
    status: z.number().int(),
    headers: z.record(z.string(), z.string()),
  }),
  z.object({ type: z.literal("body"), data: z.string() }),
  z.object({ type: z.literal("end") }),
  z.object({ type: z.literal("stored") }),
  z.object({ type: z.literal("error"), message: z.string() }),
])

type ShimEvent = z.infer<typeof shimEventSchema>

/** The two actions of the shim. */
type ShimRequest =
  | { action: "put"; id: string; data: string }
  | {
      action: "http"
      port: number
      method: string
      path: string
      headers: Record<string, string>
      body?: string
    }

/** The events of one `InvokeAgentRuntime` call to the shim. */
async function* shimEvents(
  runtime: AgentCoreRuntime,
  sessionId: string,
  payload: ShimRequest,
  signal?: AbortSignal,
): AsyncGenerator<ShimEvent> {
  const output = await runtime.client.send(
    new InvokeAgentRuntimeCommand({
      agentRuntimeArn: runtime.runtimeArn,
      qualifier: runtime.qualifier,
      runtimeSessionId: sessionId,
      contentType: "application/json",
      accept: "text/event-stream",
      payload: Buffer.from(JSON.stringify(payload)),
    }),
    signal ? { abortSignal: signal } : {},
  )
  let buffer = ""
  const decoder = new TextDecoder()
  for await (const chunk of output.response as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true })
    for (
      let end = buffer.indexOf("\n\n");
      end >= 0;
      end = buffer.indexOf("\n\n")
    ) {
      const block = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      if (block.startsWith("data: "))
        yield shimEventSchema.parse(JSON.parse(block.slice("data: ".length)))
    }
  }
}

/**
 * Store `data` in the session's shim for one read by a command, and give its
 * id. AgentCore writes the text of each command to the runtime's CloudWatch
 * log group, but not an invocation payload (the API model marks it
 * sensitive). Thus each script and each file goes this way, and a command's
 * text holds only the id: no proxy session, no password, no repository
 * content.
 */
async function stage(
  runtime: AgentCoreRuntime,
  sessionId: string,
  data: Buffer,
): Promise<string> {
  const id = randomBytes(16).toString("hex")
  for await (const event of shimEvents(runtime, sessionId, {
    action: "put",
    id,
    data: data.toString("base64"),
  })) {
    if (event.type === "stored") return id
    if (event.type === "error")
      throw new Error(`Sending data to the sandbox failed: ${event.message}`)
  }
  throw new Error("The shim did not store the data")
}

/**
 * Shell text that reads a staged blob once, to stdout, from the shim's
 * socket. Only root and `node` can reach the socket.
 */
function readStaged(layout: SessionLayout, id: string): string {
  return `curl -sSf --noproxy '*' --unix-socket ${shellQuote(layout.shim)} http://shim/blobs/${id}`
}

/**
 * Shell text that reads a staged script once and runs it with `sh`. The
 * script deletes its own file first (see {@link stagedScript}).
 */
function runStaged(layout: SessionLayout, id: string): string {
  return `f=$(mktemp) && ${readStaged(layout, id)} > "$f" && exec sh "$f"`
}

function stagedScript(script: string): Buffer {
  return Buffer.from(`rm -f "$0"\n${script}`)
}

/** One event of a command stream: output, or the end with its exit code. */
type CommandEvent =
  | { stdout?: string; stderr?: string }
  | { exitCode: number; timedOut: boolean }

/** The events of one `InvokeAgentRuntimeCommand` call, until its exit code. */
async function* commandEvents(
  runtime: AgentCoreRuntime,
  sessionId: string,
  command: string,
  signal?: AbortSignal,
): AsyncGenerator<CommandEvent> {
  const output = await runtime.client.send(
    new InvokeAgentRuntimeCommandCommand({
      agentRuntimeArn: runtime.runtimeArn,
      qualifier: runtime.qualifier,
      runtimeSessionId: sessionId,
      // The longest that AgentCore allows (3,600 s): the ingest shard limit.
      body: { command, timeout: 3_600 },
    }),
    signal ? { abortSignal: signal } : {},
  )
  for await (const event of output.stream ?? []) {
    const { chunk } = event
    if (!chunk) {
      const [kind, detail] = Object.entries(event)[0] ?? ["unknown", {}]
      throw new Error(
        `The AgentCore command stream failed (${kind}): ${(detail as { message?: string })?.message ?? ""}`,
      )
    }
    if (chunk.contentDelta) yield chunk.contentDelta
    if (chunk.contentStop) {
      const { exitCode, status } = chunk.contentStop
      // -1 is an AgentCore platform error, not the command's exit code.
      if (exitCode === undefined || exitCode < 0)
        throw new Error(
          `AgentCore could not run the command (status ${status ?? "unknown"})`,
        )
      yield { exitCode, timedOut: status === "TIMED_OUT" }
      return
    }
  }
  throw new Error("The AgentCore command stream ended without an exit code")
}

/** An async iterable that a producer pushes text into. */
function textChannel() {
  const queued: string[] = []
  let ended = false
  let wake: (() => void) | undefined
  const notify = () => {
    wake?.()
    wake = undefined
  }
  return {
    push(text: string) {
      queued.push(text)
      notify()
    },
    end() {
      ended = true
      notify()
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        const next = queued.shift()
        if (next !== undefined) yield next
        else if (ended) return
        else await new Promise<void>((resolve) => (wake = resolve))
      }
    },
  }
}

/**
 * The marker that a background job prints with its process group id. Bash
 * starts each command as a job in its own process group (`set -m`), so
 * `kill` reaches the command and its children. Dash turns job control off
 * without a terminal, so the wrapper must be bash.
 */
const PGID_MARKER = "__ctxpipe_agentcore_pgid:"

/**
 * Wait until AgentCore has read the command's output pipes, at most 5 s for
 * each. AgentCore stops reading the pipes when the command exits, so up to
 * one pipe buffer (64 KiB) at the end of the output was lost in a test
 * against a real runtime (2 of 6 large outputs). `FIONREAD` (0x541B) gives
 * the bytes that are still in a pipe. The arguments are the file
 * descriptors. Perl is in every Debian image.
 */
function drainCommand(...fds: number[]): string {
  return `perl -e 'for my $fd (@ARGV) { open(my $fh, ">&=", $fd) or next; for (1..500) { my $n = pack("i", 0); ioctl($fh, 0x541B, $n) or last; last if unpack("i", $n) == 0; select(undef, undef, undef, 0.01) } }' ${fds.join(" ")}`
}

function agentCoreHandle(
  runtime: AgentCoreRuntime,
  sessionId: string,
  paths: SessionLayout,
  /** Runs the handle's commands as this user; else as the image user. */
  user?: string,
): {
  handle: SandboxHandle
  /** A command as the image user, without the session env. */
  run: (command: string) => Promise<ExecResult>
} {
  const handleEnv: Record<string, string> = {}
  const abs = (path: string) =>
    path === "/workspace"
      ? paths.workdir
      : path.startsWith("/workspace/")
        ? `${paths.workdir}/${path.slice("/workspace/".length)}`
        : path.startsWith("/")
          ? path
          : `${paths.workdir}/${path}`
  const envFile = `${paths.state}/env.sh`

  /** The shell text of one command: its env, its folder, the command. */
  const script = (command: string, options: ProcessOptions = {}) =>
    `${exportLines(handleEnv)}${exportLines(options.env)}cd ${shellQuote(abs(options.cwd ?? paths.workdir))} || exit 1\n${command}`

  const spawn = async (
    command: string,
    options: ProcessOptions = {},
  ): Promise<SpawnHandle> => {
    const stdout = textChannel()
    const stderr = textChannel()
    const stream = new AbortController()
    let pgid: number | undefined
    let resolvePgid: (pgid: number) => void = () => undefined
    let rejectPgid: (error: unknown) => void = () => undefined
    const started = new Promise<number>((resolve, reject) => {
      resolvePgid = resolve
      rejectPgid = reject
    })
    const kill = async (signal: NodeJS.Signals | number = "SIGTERM") => {
      const group = pgid ?? (await started.catch(() => undefined))
      if (group === undefined) return
      const name =
        typeof signal === "number" ? String(signal) : signal.replace(/^SIG/, "")
      // Dash's `kill` refuses `--`: the group id follows the signal.
      await run(`kill -${name} -${group} 2>/dev/null; true`)
    }
    // The outer shell reads the session env (only the image user can) and
    // passes it on (`runuser -m`). The job reads its staged script. The
    // outer shell's job notices go to /dev/null; the job keeps stderr,
    // which fd 3 keeps open for the drain.
    // `-m` keeps the session env; HOME, USER and LOGNAME become the user's.
    const runAs = user
      ? `runuser -u ${shellQuote(user)} -m -- env HOME="$(getent passwd ${shellQuote(user)} | cut -d: -f6)" USER=${shellQuote(user)} LOGNAME=${shellQuote(user)} `
      : ""
    let pending = ""
    const exited = (async () => {
      try {
        const id = await stage(
          runtime,
          sessionId,
          stagedScript(script(command, options)),
        )
        const wrapped = `[ -r ${shellQuote(envFile)} ] && . ${shellQuote(envFile)}\nset -m\n${runAs}sh -c ${shellQuote(runStaged(paths, id))} &\necho "${PGID_MARKER}$!"\nexec 3>&2 2>/dev/null\nwait $!\ncode=$?\n${drainCommand(1, 3)}\nexit $code`
        for await (const event of commandEvents(
          runtime,
          sessionId,
          `bash -c ${shellQuote(wrapped)}`,
          stream.signal,
        )) {
          if ("exitCode" in event) {
            if (pending) stdout.push(pending)
            if (pgid === undefined)
              rejectPgid(new Error("The command did not start"))
            // An aborted command fails, also when it ended before the abort
            // reached the stream.
            options.signal?.throwIfAborted()
            return event.timedOut ? 124 : event.exitCode
          }
          if (event.stderr) stderr.push(event.stderr)
          if (!event.stdout) continue
          if (pgid !== undefined) {
            stdout.push(event.stdout)
            continue
          }
          // Hold stdout until the marker line is out of it.
          pending += event.stdout
          const at = pending.indexOf(PGID_MARKER)
          const end = at < 0 ? -1 : pending.indexOf("\n", at)
          if (end < 0) continue
          pgid = Number(pending.slice(at + PGID_MARKER.length, end))
          resolvePgid(pgid)
          const rest = pending.slice(0, at) + pending.slice(end + 1)
          pending = ""
          if (rest) stdout.push(rest)
        }
        throw new Error("The AgentCore command stream ended early")
      } catch (error) {
        rejectPgid(error)
        throw error
      } finally {
        stdout.end()
        stderr.end()
      }
    })()
    // `wait` gives the error; this keeps an unread failure from crashing.
    exited.catch(() => undefined)
    if (options.signal) {
      const onAbort = () => {
        void kill("SIGKILL").finally(() => stream.abort())
      }
      if (options.signal.aborted) onAbort()
      else options.signal.addEventListener("abort", onAbort, { once: true })
    }
    return {
      pid: await started,
      stdout,
      stderr,
      stdin: {
        write: () =>
          Promise.reject(new Error("AgentCore processes have no stdin")),
        end: () => Promise.resolve(),
      },
      wait: () => exited,
      kill,
    }
  }

  const exec = async (
    command: string,
    options: ProcessOptions = {},
  ): Promise<ExecResult> => {
    const job = await spawn(command, options)
    const collect = async (stream: AsyncIterable<string>) => {
      let text = ""
      for await (const chunk of stream) text += chunk
      return text
    }
    const [stdout, stderr, exitCode] = await Promise.all([
      collect(job.stdout),
      collect(job.stderr),
      job.wait(),
    ])
    return { stdout, stderr, exitCode }
  }

  const run = async (command: string): Promise<ExecResult> => {
    let stdout = ""
    let stderr = ""
    const id = await stage(
      runtime,
      sessionId,
      stagedScript(`${command}\ncode=$?\n${drainCommand(1, 2)}\nexit $code`),
    )
    for await (const event of commandEvents(
      runtime,
      sessionId,
      `sh -c ${shellQuote(runStaged(paths, id))}`,
    )) {
      if ("exitCode" in event)
        return { stdout, stderr, exitCode: event.exitCode }
      stdout += event.stdout ?? ""
      stderr += event.stderr ?? ""
    }
    throw new Error("The AgentCore command stream ended early")
  }

  const checked = async (step: string, command: string) => {
    const result = await exec(command)
    if (result.exitCode !== 0)
      throw new Error(`${step} failed: ${result.stderr.trim()}`)
    return result
  }

  const readBytes = async (path: string) =>
    Buffer.from(
      (await checked("read", `base64 < ${shellQuote(abs(path))}`)).stdout,
      "base64",
    )

  const processApi = { exec, spawn }
  const handle: SandboxHandle = {
    id: sessionId,
    provider: "agentcore",
    workspaceRoot: paths.workdir,
    capabilities: AGENTCORE_CAPS,
    process: processApi,
    git: createExecBackedGit(processApi, paths.workdir),
    fs: {
      read: async (path) => (await readBytes(path)).toString("utf8"),
      readBytes: async (path) => new Uint8Array(await readBytes(path)),
      write: async (path, data) => {
        const target = abs(path)
        const id = await stage(runtime, sessionId, Buffer.from(data))
        await checked(
          "write",
          `mkdir -p ${shellQuote(target.replace(/\/[^/]*$/, "") || "/")} && ${readStaged(paths, id)} > ${shellQuote(target)}`,
        )
      },
      list: async (path) =>
        (await checked("list", `ls -1Ap ${shellQuote(abs(path))}`)).stdout
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((entry) => {
            const dir = entry.endsWith("/")
            const name = dir ? entry.slice(0, -1) : entry
            return {
              name,
              path: `${path.replace(/\/$/, "")}/${name}`,
              type: dir ? ("dir" as const) : ("file" as const),
            }
          }),
      mkdir: async (path) => {
        await checked("mkdir", `mkdir -p ${shellQuote(abs(path))}`)
      },
      remove: async (path) => {
        await checked("remove", `rm -rf ${shellQuote(abs(path))}`)
      },
      rename: async (from, to) => {
        await checked(
          "rename",
          `mv ${shellQuote(abs(from))} ${shellQuote(abs(to))}`,
        )
      },
      exists: async (path) =>
        (await exec(`test -e ${shellQuote(abs(path))}`)).exitCode === 0,
    },
    env: {
      set: async (vars) => {
        Object.assign(handleEnv, vars)
      },
    },
    ports: {
      connect: async (port) => ({
        url: await portBridgeUrl({ runtime, sessionId, port }),
      }),
    },
    destroy: () => stopSession(runtime, sessionId),
  }
  return { handle, run }
}

async function stopSession(
  runtime: AgentCoreRuntime,
  sessionId: string,
): Promise<void> {
  // A later request to an old port URL would start a new, empty microVM.
  for (const [token, route] of bridgeRoutes)
    if (route.sessionId === sessionId) bridgeRoutes.delete(token)
  try {
    await runtime.client.send(
      new StopRuntimeSessionCommand({
        agentRuntimeArn: runtime.runtimeArn,
        qualifier: runtime.qualifier,
        runtimeSessionId: sessionId,
      }),
    )
  } catch (error) {
    // A session that already stopped counts as stopped.
    if (!(error instanceof ResourceNotFoundException)) throw error
  }
}

/**
 * Sandboxes on an AgentCore runtime. `create` starts a new session and
 * writes the create environment (the run's proxy session) to a file that
 * each command reads, as a Docker container keeps its create environment.
 * `paths` is for tests that run the commands on this host.
 */
export function agentCoreSandboxProvider(input: {
  runtime: AgentCoreRuntime
  paths?: SessionLayout
  /**
   * Runs the handle's commands as this user. The image user is root, which
   * the provider's own steps and an ingest sandbox's root commands need.
   */
  user?: string
}): SandboxProvider {
  const { runtime } = input
  const paths = input.paths ?? {
    state: "/tmp/ctxpipe",
    workdir: "/workspace",
    shim: "/tmp/ctxpipe-shim/blobs.sock",
  }
  return {
    name: "agentcore",
    capabilities: () => AGENTCORE_CAPS,
    async create(createInput) {
      // AgentCore needs at least 33 characters. The backend is not
      // snapshotted, so its random values do not repeat.
      const sessionId = `ctxpipe-${randomBytes(16).toString("hex")}`
      const { handle, run } = agentCoreHandle(
        runtime,
        sessionId,
        paths,
        input.user,
      )
      try {
        // The marker tells `resume` that the microVM is this sandbox's.
        const marked = await run(
          `umask 077 && mkdir -p ${shellQuote(paths.state)} && printf %s ${shellQuote(sessionId)} > ${shellQuote(`${paths.state}/session`)}`,
        )
        if (marked.exitCode !== 0)
          throw new Error(
            `Starting the AgentCore session failed: ${marked.stderr.trim()}`,
          )
        // The create env (the run's proxy session) is readable only by the
        // image user, which reads it for each command.
        if (createInput.env && Object.keys(createInput.env).length > 0) {
          const id = await stage(
            runtime,
            sessionId,
            Buffer.from(exportLines(createInput.env)),
          )
          const written = await run(
            `umask 077 && ${readStaged(paths, id)} > ${shellQuote(`${paths.state}/env.sh`)}`,
          )
          if (written.exitCode !== 0)
            throw new Error(
              `Writing the AgentCore session env failed: ${written.stderr.trim()}`,
            )
        }
      } catch (error) {
        await stopSession(runtime, sessionId).catch((stopError: unknown) =>
          log.warn({
            step: "agentcore-sandbox-create",
            message: `Stopping a session whose create failed failed: ${String(stopError)}`,
            sessionId,
          }),
        )
        throw error
      }
      return handle
    },
    async resume({ id }) {
      const { handle, run } = agentCoreHandle(runtime, id, paths, input.user)
      // A call to a session that is gone starts a new, empty microVM.
      const marker = await run(
        `cat ${shellQuote(`${paths.state}/session`)} 2>/dev/null; true`,
      )
      if (marker.stdout === id) return handle
      await stopSession(runtime, id)
      return null
    },
    destroy: ({ id }) => stopSession(runtime, id),
  }
}

/** One port of one session behind the loopback bridge. */
type BridgeRoute = {
  runtime: AgentCoreRuntime
  sessionId: string
  port: number
  usedAt: number
}

/** Routes that nobody used for this long are removed. */
const BRIDGE_ROUTE_IDLE_MS = 8 * 60 * 60_000

/** The bridge's routes by token. */
const bridgeRoutes = new Map<string, BridgeRoute>()

let bridge: Promise<Server> | undefined

/**
 * The URL of a sandbox port: `http://127.0.0.1:<bridge>/<token>`. The bridge
 * is one loopback server for this process; the random token in the path
 * picks the session and the port. The OpenCode client appends its paths.
 */
async function portBridgeUrl(
  route: Omit<BridgeRoute, "usedAt">,
): Promise<string> {
  bridge ??= new Promise<Server>((resolve, reject) => {
    const server = createServer((request, response) => {
      void forward(request, response)
    })
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.unref()
      resolve(server)
    })
  }).catch((error: unknown) => {
    // The next connect tries again.
    bridge = undefined
    throw error
  })
  const server = await bridge
  const now = Date.now()
  for (const [token, entry] of bridgeRoutes)
    if (now - entry.usedAt > BRIDGE_ROUTE_IDLE_MS) bridgeRoutes.delete(token)
  const token = randomBytes(24).toString("hex")
  bridgeRoutes.set(token, { ...route, usedAt: now })
  const address = server.address()
  if (!address || typeof address === "string")
    throw new Error("The AgentCore port bridge has no address")
  return `http://127.0.0.1:${address.port}/${token}`
}

/** Send one HTTP request through the shim and stream its answer back. */
async function forward(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://bridge")
  const [, token = "", ...rest] = url.pathname.split("/")
  const route = bridgeRoutes.get(token)
  if (!route) {
    response.writeHead(404).end()
    return
  }
  route.usedAt = Date.now()
  const aborted = new AbortController()
  response.on("close", () => aborted.abort())
  try {
    // Inside the try: a client that leaves during its upload ends here.
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks)
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(request.headers))
      if (typeof value === "string") headers[name] = value
    for await (const event of shimEvents(
      route.runtime,
      route.sessionId,
      {
        action: "http",
        port: route.port,
        method: request.method ?? "GET",
        path: `/${rest.join("/")}${url.search}`,
        headers,
        ...(body.byteLength > 0 ? { body: body.toString("base64") } : {}),
      },
      aborted.signal,
    )) {
      if (event.type === "head") response.writeHead(event.status, event.headers)
      else if (event.type === "body")
        response.write(Buffer.from(event.data, "base64"))
      else if (event.type === "error")
        throw new Error(`The sandbox port did not answer: ${event.message}`)
      else if (event.type === "end") {
        response.end()
        return
      }
    }
    throw new Error("The shim answer ended early")
  } catch (error) {
    if (!response.headersSent)
      response
        .writeHead(502, { "content-type": "text/plain" })
        .end(String(error))
    else response.destroy(error instanceof Error ? error : undefined)
  }
}
