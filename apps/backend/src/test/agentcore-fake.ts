import {
  type ChildProcessWithoutNullStreams,
  execFileSync,
  spawn,
} from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import {
  createServer,
  type IncomingMessage,
  request as httpRequest,
  type Server,
} from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { BedrockAgentCoreClient } from "@aws-sdk/client-bedrock-agentcore"
import { EventStreamCodec } from "@smithy/eventstream-codec"

import type { AgentCoreRuntime } from "../domain/workspaces/agentcore-sandbox-provider.js"

export const RUNTIME_ARN =
  "arn:aws:bedrock-agentcore:us-west-2:111122223333:runtime/ctxpipe_test-abc123"
const SESSION_HEADER = "x-amzn-bedrock-agentcore-runtime-session-id"

const codec = new EventStreamCodec(
  (bytes) => new TextDecoder().decode(bytes),
  (text) => new TextEncoder().encode(text),
)

/** One event-stream message as AgentCore sends it. */
function message(
  headers: Record<string, string>,
  body: unknown,
): Uint8Array<ArrayBuffer> {
  return codec.encode({
    headers: Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [
        name,
        { type: "string" as const, value },
      ]),
    ),
    body: new TextEncoder().encode(JSON.stringify(body)),
  }) as Uint8Array<ArrayBuffer>
}

const chunk = (body: unknown) =>
  message(
    {
      ":message-type": "event",
      ":event-type": "chunk",
      ":content-type": "application/json",
    },
    body,
  )

/**
 * A fake AgentCore endpoint on loopback, with one fake microVM whose files
 * are in `root`. A call to a session that is not running starts a new
 * microVM with empty folders, as AgentCore does. It is a real HTTP server,
 * not msw: msw does not close the answer when the caller closes the
 * connection, and the port bridge depends on that close.
 */
/** Where the fake microVM runs: this host's shell, or a container. */
type MicroVm = {
  /** Runs the command text with a shell in the workspace folder. */
  run: (command: string) => ChildProcessWithoutNullStreams
  /** Empties the microVM, as a new session would find it. */
  reset: () => void
  /** The shim's port 8080 as this host reaches it. */
  shimPort: number
}

function fakeAgentCoreServer(microVm: MicroVm) {
  const running = new Set<string>()
  const calls: { api: string; sessionId: string; qualifier: string | null }[] =
    []
  /** The text of each command, as AgentCore writes it to its log group. */
  const commandTexts: string[] = []
  let failNext: "platform" | "exception" | undefined
  const freshMicroVm = (sessionId: string) => {
    if (running.has(sessionId)) return
    microVm.reset()
    running.add(sessionId)
  }
  const readBody = async (request: IncomingMessage) => {
    const chunks: Buffer[] = []
    for await (const part of request) chunks.push(part as Buffer)
    return Buffer.concat(chunks)
  }
  const server = createServer((request, response) => {
    void (async () => {
      const sessionId = String(request.headers[SESSION_HEADER] ?? "")
      const url = new URL(request.url ?? "/", "http://agentcore")
      const api = url.pathname.split("/").at(-1) ?? ""
      const body = await readBody(request)
      calls.push({
        api,
        sessionId,
        qualifier: url.searchParams.get("qualifier"),
      })
      if (api === "stopruntimesession") {
        if (!running.delete(sessionId)) {
          response.writeHead(404, {
            "content-type": "application/json",
            "x-amzn-errortype": "ResourceNotFoundException",
          })
          response.end(JSON.stringify({ message: "No such session" }))
          return
        }
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({ runtimeSessionId: sessionId }))
        return
      }
      freshMicroVm(sessionId)
      if (api === "invocations") {
        // The microVM's port 8080: the real shim of the image.
        const upstream = httpRequest(
          {
            host: "127.0.0.1",
            port: microVm.shimPort,
            method: "POST",
            path: "/invocations",
          },
          (answer) => {
            response.writeHead(200, { "content-type": "text/event-stream" })
            answer.pipe(response)
          },
        )
        response.on("close", () => upstream.destroy())
        upstream.end(body)
        return
      }
      const { command } = JSON.parse(body.toString()) as { command: string }
      commandTexts.push(command)
      response.writeHead(200, {
        "content-type": "application/vnd.amazon.eventstream",
      })
      response.write(chunk({ contentStart: {} }))
      const fail = failNext
      failNext = undefined
      if (fail === "exception") {
        response.end(
          message(
            {
              ":message-type": "exception",
              ":exception-type": "validationException",
              ":content-type": "application/json",
            },
            { message: "The command is too long" },
          ),
        )
        return
      }
      if (fail === "platform") {
        response.end(
          chunk({ contentStop: { exitCode: -1, status: "COMPLETED" } }),
        )
        return
      }
      // AgentCore runs the command text with a shell.
      const child = microVm.run(command)
      child.stdout.on("data", (data: Buffer) =>
        response.write(chunk({ contentDelta: { stdout: data.toString() } })),
      )
      child.stderr.on("data", (data: Buffer) =>
        response.write(chunk({ contentDelta: { stderr: data.toString() } })),
      )
      child.on("error", () =>
        response.end(
          chunk({ contentStop: { exitCode: -1, status: "COMPLETED" } }),
        ),
      )
      child.on("close", (code) =>
        response.end(
          chunk({
            contentStop: { exitCode: code ?? 137, status: "COMPLETED" },
          }),
        ),
      )
    })()
  })
  return {
    server,
    calls,
    commandTexts,
    running,
    failNextCommand: (kind: "platform" | "exception") => (failNext = kind),
  }
}

export const listen = (server: Server) =>
  new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      resolve(typeof address === "object" && address ? address.port : 0)
    }),
  )

/** A client of the fake endpoint, and the fake's controls. */
async function withFakeEndpoint(microVm: MicroVm, qualifier?: string) {
  const fake = fakeAgentCoreServer(microVm)
  const endpoint = `http://127.0.0.1:${await listen(fake.server)}`
  const runtime: AgentCoreRuntime = {
    client: new BedrockAgentCoreClient({
      region: "us-west-2",
      endpoint,
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
      maxAttempts: 1,
    }),
    runtimeArn: RUNTIME_ARN,
    ...(qualifier ? { qualifier } : {}),
  }
  return { ...fake, endpoint, runtime }
}

const SHIM_FILE = fileURLToPath(
  new URL(
    "../../../../scripts/chat-sandbox/agentcore-shim.mjs",
    import.meta.url,
  ),
)

/**
 * A fake AgentCore endpoint whose microVM is this host: commands run with the
 * host shell in a temporary folder, and the real shim of the image runs in
 * this process. `paths` are the microVM's folders for the provider.
 */
export async function startFakeAgentCore(qualifier?: string) {
  const root = mkdtempSync(join(tmpdir(), "agentcore-fake-"))
  // The shim is a plain ESM file of the sandbox image.
  const { shimServer } = (await import(pathToFileURL(SHIM_FILE).href)) as {
    shimServer: () => Server
  }
  const shim = shimServer()
  const shimPort = await listen(shim)
  const paths = {
    state: join(root, "state"),
    workdir: join(root, "workspace"),
    shim: `http://127.0.0.1:${shimPort}`,
  }
  const fake = await withFakeEndpoint(
    {
      shimPort,
      run: (command) => {
        mkdirSync(paths.workdir, { recursive: true })
        // AgentCore runs the command text with a shell.
        return spawn("/bin/sh", ["-c", command], { cwd: paths.workdir })
      },
      reset: () => {
        rmSync(paths.state, { recursive: true, force: true })
        rmSync(paths.workdir, { recursive: true, force: true })
      },
    },
    qualifier,
  )
  return {
    ...fake,
    paths,
    close() {
      shim.close()
      fake.server.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/**
 * A fake AgentCore endpoint whose microVM is a container of the chat sandbox
 * image, with the shim of this checkout as its entry point on port 8080: the
 * same as the image's `agentcore` target. Commands run as the image user with
 * the image's `sh` (dash), as on AgentCore.
 */
export async function startContainerAgentCore(image: string) {
  const docker = (args: string[]) =>
    execFileSync("docker", args, { encoding: "utf8" }).trim()
  const shimPath = "/usr/local/lib/ctxpipe/agentcore-shim.mjs"
  const container = docker([
    "run",
    "-d",
    "--rm",
    // tini as PID 1 and root as the user, as in the image's `agentcore`
    // target. The shim runs as node there; here it is root.
    "--init",
    "--user",
    "0",
    "-p",
    "127.0.0.1::8080",
    "-v",
    `${SHIM_FILE}:${shimPath}:ro`,
    image,
    "node",
    shimPath,
  ])
  try {
    const shimPort = Number(
      docker(["port", container, "8080/tcp"]).split(":").at(-1),
    )
    for (let attempt = 0; ; attempt++) {
      const ready = await fetch(`http://127.0.0.1:${shimPort}/ping`).then(
        (answer) => answer.ok,
        () => false,
      )
      if (ready) break
      if (attempt > 100) throw new Error("The shim did not start")
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const fake = await withFakeEndpoint({
      shimPort,
      run: (command) =>
        spawn("docker", [
          "exec",
          "-i",
          "-w",
          "/workspace",
          container,
          "sh",
          "-c",
          command,
        ]),
      reset: () =>
        docker([
          "exec",
          container,
          "sh",
          "-c",
          "rm -rf /tmp/ctxpipe /workspace/* /workspace/.[!.]*",
        ]),
    })
    return {
      ...fake,
      close() {
        fake.server.close()
        docker(["rm", "-f", container])
      },
    }
  } catch (error) {
    docker(["rm", "-f", container])
    throw error
  }
}
