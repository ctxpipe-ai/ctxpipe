import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type SandboxOpencodeServer,
  startOpencodeServerInSandbox,
  startOpencodeSession,
} from "@tanstack/ai-opencode"
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process"
import { expect, it } from "vitest"
import { workspaceChatOpenCodeConfig } from "./workspace-chat-opencode-contract.js"

/**
 * CTX-874. The chat OpenCode config denies the `read` tool on `*.env`, but the
 * agent also has `bash`, which OpenCode allows by default. Each test drives
 * real OpenCode with the production chat permission config and a synthetic
 * model that issues one `bash` tool call, then reads the tool result the model
 * sees. The deny rules must stop bash from reading an `*.env` file or the
 * `OPENCODE_SERVER_PASSWORD`, while an ordinary command still runs.
 */

const PASSWORD = "ctx874-server-secret"
const ENV_MARKER = "CTX874_ENV_FILE_SECRET=must-not-leak"

function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      if (!address || typeof address === "string") {
        probe.close()
        reject(new Error("free port probe did not bind"))
        return
      }
      probe.close(() => resolve(address.port))
    })
  })
}

function completionChunk(delta: Record<string, unknown>, finish?: string) {
  return {
    id: "ctx874",
    object: "chat.completion.chunk",
    created: 1,
    model: "probe",
    choices: [{ index: 0, delta, finish_reason: finish ?? null }],
  }
}

/**
 * Runs one `bash` command through real OpenCode under the production chat
 * config and returns the text of every tool result the model receives.
 */
async function runBashProbe(command: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ctxpipe-ctx874-"))
  await writeFile(join(directory, "leak.env"), `${ENV_MARKER}\n`)
  await writeFile(join(directory, "allowed.txt"), "ordinary-file-contents\n")
  const bodies: string[] = []
  const model = createServer((request, response) => {
    if (request.url !== "/model/v1/chat/completions") {
      response.writeHead(404)
      response.end()
      return
    }
    let body = ""
    request.on("data", (chunk) => {
      body += chunk
    })
    request.on("end", () => {
      bodies.push(body)
      const chunks = body.includes("call_bash")
        ? [
            completionChunk({ role: "assistant", content: "done" }),
            completionChunk({}, "stop"),
          ]
        : [
            completionChunk({
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call_bash",
                  type: "function",
                  function: {
                    name: "bash",
                    arguments: JSON.stringify({
                      command,
                      description: "probe",
                    }),
                  },
                },
              ],
            }),
            completionChunk({}, "tool_calls"),
          ]
      response.writeHead(200, { "content-type": "text/event-stream" })
      for (const chunk of chunks)
        response.write(`data: ${JSON.stringify(chunk)}\n\n`)
      response.end("data: [DONE]\n\n")
    })
  })
  const sandbox = await localProcessSandbox({
    dir: directory,
    removeOnDestroy: true,
  }).create({ id: directory, workspace: { source: { type: "none" } } })
  let server: SandboxOpencodeServer | undefined
  let session: Awaited<ReturnType<typeof startOpencodeSession>> | undefined
  try {
    await new Promise<void>((resolve) =>
      model.listen(0, "127.0.0.1", () => resolve()),
    )
    const address = model.address()
    if (!address || typeof address === "string")
      throw new Error("model fixture did not bind")
    await sandbox.env.set({
      OPENCODE_SERVER_PASSWORD: PASSWORD,
      XDG_CONFIG_HOME: join(directory, "config"),
      XDG_DATA_HOME: join(directory, "data"),
      XDG_STATE_HOME: join(directory, "state"),
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        enabled_providers: ["synthetic"],
        provider: {
          synthetic: {
            npm: "@ai-sdk/openai-compatible",
            name: "synthetic",
            options: {
              baseURL: `http://127.0.0.1:${address.port}/model/v1`,
              apiKey: "synthetic-test-key",
            },
            models: { probe: { name: "probe" } },
          },
        },
        permission: workspaceChatOpenCodeConfig({
          modelBase: "probe",
          proxyAddsCredentials: true,
        }).permission,
      }),
    })
    server = await startOpencodeServerInSandbox(sandbox, {
      port: await freeLoopbackPort(),
      hostname: "127.0.0.1",
      cwd: ".",
    })
    session = await startOpencodeSession({
      baseUrl: server.baseUrl,
      headers: {
        Authorization: `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}`,
      },
      providerID: "synthetic",
      modelID: "probe",
      onEvent: () => undefined,
      onPermissionRequest: () => "reject",
    })
    await session.prompt("Run the probe.")
  } finally {
    await session?.abort()
    await session?.dispose()
    await server?.dispose()
    await sandbox.destroy()
    model.closeAllConnections()
    model.close()
    await rm(directory, { recursive: true, force: true })
  }
  return bodies
    .flatMap((body) =>
      (
        JSON.parse(body) as {
          messages: Array<{ role: string; content: unknown }>
        }
      ).messages
        .filter((message) => message.role === "tool")
        .map((message) => JSON.stringify(message.content)),
    )
    .join("\n")
}

it(
  "denies a bash command that reads an .env file the read rules deny (CTX-874)",
  { timeout: 60_000 },
  async () => {
    const toolText = await runBashProbe("cat leak.env")
    expect(toolText).not.toContain(ENV_MARKER)
  },
)

it(
  "denies a bash command that reads the OpenCode server password (CTX-874)",
  { timeout: 60_000 },
  async () => {
    const toolText = await runBashProbe('echo "PW:[$OPENCODE_SERVER_PASSWORD]"')
    expect(toolText).not.toContain(PASSWORD)
  },
)

it(
  "still runs an ordinary bash command so Git keeps working",
  { timeout: 60_000 },
  async () => {
    const toolText = await runBashProbe("cat allowed.txt")
    expect(toolText).toContain("ordinary-file-contents")
  },
)
