import { execFile, spawn } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const exec = promisify(execFile)

/** Run git in `cwd` and give its trimmed stdout. */
export async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await exec("git", args, { cwd })
  return stdout.trim()
}

/**
 * A bare repository `<root>/<name>` with one commit of `files` on `main`.
 * Returns the commit SHA.
 */
export async function bareRepository(
  root: string,
  name: string,
  files: Record<string, string | Uint8Array>,
): Promise<string> {
  const work = await mkdtemp(join(tmpdir(), "git-http-work-"))
  try {
    await git(["init", "-q", "-b", "main", work])
    for (const [path, text] of Object.entries(files))
      await writeFile(join(work, path), text)
    const who = ["-c", "user.email=t@example.com", "-c", "user.name=t"]
    await git([...who, "add", "."], work)
    await git([...who, "commit", "-qm", "fixture"], work)
    await git(["clone", "-q", "--bare", work, join(root, name)])
    return await git(["rev-parse", "HEAD"], work)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

/** One request that the server got: the method, the path, and the host. */
export type GitHttpRequest = { method: string; url: string; host: string }

/**
 * A real Git smart HTTP server on 127.0.0.1 (`git http-backend` over
 * `root`). `answer` can answer a request first (a redirect, a stall); when
 * it returns false, git answers.
 */
export async function startGitHttpServer(
  root: string,
  answer?: (request: IncomingMessage, response: ServerResponse) => boolean,
): Promise<{
  port: number
  requests: GitHttpRequest[]
  stop: () => Promise<void>
}> {
  const requests: GitHttpRequest[] = []
  const open = new Set<ServerResponse>()
  const server = createServer((request, response) => {
    requests.push({
      method: request.method ?? "",
      url: request.url ?? "",
      host: request.headers.host ?? "",
    })
    open.add(response)
    response.on("close", () => open.delete(response))
    if (answer?.(request, response)) return
    const url = new URL(request.url ?? "/", "http://fixture")
    const child = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: request.method ?? "GET",
        CONTENT_TYPE: request.headers["content-type"] ?? "",
        HTTP_CONTENT_ENCODING: String(
          request.headers["content-encoding"] ?? "",
        ),
        HTTP_GIT_PROTOCOL: String(request.headers["git-protocol"] ?? ""),
      },
    })
    request.pipe(child.stdin)
    const out: Buffer[] = []
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk))
    child.on("close", () => {
      const all = Buffer.concat(out)
      const split = all.indexOf("\r\n\r\n")
      if (split < 0) {
        response.writeHead(500)
        response.end()
        return
      }
      let status = 200
      const headers: Record<string, string> = {}
      for (const line of all.subarray(0, split).toString().split("\r\n")) {
        const colon = line.indexOf(":")
        const name = line.slice(0, colon)
        const value = line.slice(colon + 1).trim()
        if (name.toLowerCase() === "status") status = Number.parseInt(value, 10)
        else if (name) headers[name] = value
      }
      response.writeHead(status, headers)
      response.end(all.subarray(split + 4))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return {
    port: (server.address() as AddressInfo).port,
    requests,
    stop: async () => {
      for (const response of open) response.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
