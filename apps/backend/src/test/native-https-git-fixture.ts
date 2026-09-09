import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { PassThrough } from "node:stream"
import { finished } from "node:stream/promises"
import { promisify } from "node:util"
import type Docker from "dockerode"

const exec = promisify(execFile)

export interface NativeHttpsGitRemote {
  url: string
  sync(): Promise<void>
  observedRequests(): Promise<Array<NativeHttpsGitRequest>>
}

export interface NativeHttpsGitRequest {
  method: string
  path: string
  auth: "none" | "bootstrap" | "read" | "invalid"
}

export interface NativeHttpsGitServeOptions {
  hostname?: string
  repositoryPath?: string
  listenerPort?: number
  basicAuth?: {
    bootstrapToken: string
    readToken: string
  }
}

export interface NativeHttpsGitFixture {
  image: string
  serve<T>(
    directory: string,
    fn: (remote: NativeHttpsGitRemote) => Promise<T>,
    options?: NativeHttpsGitServeOptions,
  ): Promise<T>
}

function validateHostname(value: string): string {
  const hostname = value.trim()
  if (!hostname || /[/:?#@\s]/.test(hostname))
    throw new Error("Native HTTPS Git fixture hostname is invalid")
  return hostname
}

function validateRepositoryPath(value: string): string {
  if (
    !value.startsWith("/") ||
    value.includes("?") ||
    value.includes("#") ||
    value.includes("//") ||
    value.endsWith("/")
  )
    throw new Error("Native HTTPS Git fixture repository path is invalid")
  return value
}

function validateListenerPort(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65_535)
    throw new Error("Native HTTPS Git fixture listener port is invalid")
  return value
}

function validateBasicAuth(
  value: NativeHttpsGitServeOptions["basicAuth"],
): NativeHttpsGitServeOptions["basicAuth"] {
  if (!value) return undefined
  if (
    typeof value.bootstrapToken !== "string" ||
    typeof value.readToken !== "string" ||
    !value.bootstrapToken ||
    !value.readToken ||
    /\s/.test(value.bootstrapToken) ||
    /\s/.test(value.readToken) ||
    value.bootstrapToken === value.readToken
  )
    throw new Error("Native HTTPS Git fixture basic auth tokens are invalid")
  return { ...value }
}

/**
 * Create a one-test CA trusted by a derived prebuilt chat image, then serve the
 * repository through smart Git HTTPS on the nested daemon's bridge gateway.
 */
export async function withNativeHttpsGitFixture<T>(
  input: {
    baseImage: string
    docker: Docker
  },
  fn: (fixture: NativeHttpsGitFixture) => Promise<T>,
): Promise<T> {
  await input.docker.getImage(input.baseImage).inspect()
  const root = await mkdtemp(join(tmpdir(), "ctxpipe-native-https-git-"))
  const suffix = randomUUID().replaceAll("-", "")
  const derivedRepository = `ctxpipe-native-https-git-${suffix}`
  const derivedImage = `${derivedRepository}:fixture`
  const customizerName = `${derivedRepository}-ca`
  const serverName = `${derivedRepository}-server`
  let customizer: Docker.Container | undefined
  let server: Docker.Container | undefined
  let result: T | undefined
  let primaryError: unknown
  const cleanupErrors: unknown[] = []

  try {
    const caKey = join(root, "ca.key")
    const caCert = join(root, "ctxpipe-fixture-ca.crt")
    const serverKey = join(root, "server.key")
    const serverRequest = join(root, "server.csr")
    const serverCert = join(root, "server.crt")
    const extensions = join(root, "server.ext")
    await exec(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=ctxpipe-native-git-fixture-ca",
        "-keyout",
        caKey,
        "-out",
        caCert,
      ],
      { timeout: 10_000 },
    )
    await exec(
      "openssl",
      [
        "req",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-subj",
        "/CN=host.docker.internal",
        "-keyout",
        serverKey,
        "-out",
        serverRequest,
      ],
      { timeout: 10_000 },
    )
    await writeFile(
      extensions,
      "subjectAltName=DNS:host.docker.internal,DNS:github.com\nextendedKeyUsage=serverAuth\n",
    )
    await exec(
      "openssl",
      [
        "x509",
        "-req",
        "-days",
        "1",
        "-in",
        serverRequest,
        "-CA",
        caCert,
        "-CAkey",
        caKey,
        "-CAcreateserial",
        "-extfile",
        extensions,
        "-out",
        serverCert,
      ],
      { timeout: 10_000 },
    )

    const caArchive = join(root, "ca.tar")
    await exec(
      "tar",
      ["--no-xattrs", "-C", root, "-cf", caArchive, basename(caCert)],
      { timeout: 10_000 },
    )
    customizer = await input.docker.createContainer({
      name: customizerName,
      Image: input.baseImage,
      User: "0:0",
      Cmd: ["sh", "-c", "sleep 300"],
    })
    await customizer.start()
    await customizer.putArchive(await readFile(caArchive), {
      path: "/usr/local/share/ca-certificates",
    })
    await runExec(customizer, ["update-ca-certificates"], "0:0")
    await customizer.commit({
      repo: derivedRepository,
      tag: "fixture",
      changes: ["USER 1000:1000"],
    })
    await customizer.remove({ force: true, v: true })
    customizer = undefined

    result = await fn({
      image: derivedImage,
      async serve<R>(
        directory: string,
        remoteFn: (remote: NativeHttpsGitRemote) => Promise<R>,
        serveOptions: NativeHttpsGitServeOptions = {},
      ) {
        const bridge = await input.docker.getNetwork("bridge").inspect()
        const gateway = bridge.IPAM?.Config?.[0]?.Gateway
        if (!gateway || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(gateway))
          throw new Error("Native HTTPS Git fixture bridge gateway missing")

        const hostname = validateHostname(
          serveOptions.hostname ?? "host.docker.internal",
        )
        const repositoryPath = validateRepositoryPath(
          serveOptions.repositoryPath ?? "/repo.git",
        )
        const port = validateListenerPort(
          serveOptions.listenerPort ??
            30_000 + (Number.parseInt(suffix.slice(0, 8), 16) % 20_000),
        )
        const basicAuth = validateBasicAuth(serveOptions.basicAuth)
        const requestLog = "/tmp/ctxpipe-git-fixture/requests.log"
        if (hostname !== "host.docker.internal" && hostname !== "github.com")
          throw new Error("Native HTTPS Git fixture hostname is not supported")

        const staging = join(root, "staging")
        const fixtureDirectory = join(staging, "tmp", "ctxpipe-git-fixture")
        const repositoryDirectory = join(staging, "srv", "repo.git")
        await mkdir(fixtureDirectory, { recursive: true })
        await mkdir(join(staging, "srv"), { recursive: true })
        await exec("git", ["clone", "--bare", directory, repositoryDirectory], {
          timeout: 30_000,
        })
        await copyFile(serverKey, join(fixtureDirectory, "server.key"))
        await copyFile(serverCert, join(fixtureDirectory, "server.crt"))
        await chmod(join(fixtureDirectory, "server.key"), 0o644)
        await writeFile(
          join(fixtureDirectory, "server.mjs"),
          smartGitServerSource,
        )
        await writeFile(join(fixtureDirectory, "requests.log"), "", {
          mode: 0o666,
        })
        await chmod(join(fixtureDirectory, "requests.log"), 0o666)
        const serverArchive = join(root, "server.tar")
        await exec(
          "tar",
          ["--no-xattrs", "-C", staging, "-cf", serverArchive, "tmp", "srv"],
          { timeout: 30_000 },
        )
        server = await input.docker.createContainer({
          name: serverName,
          Image: derivedImage,
          User: port < 1024 ? "0:0" : "1000:1000",
          Entrypoint: ["node"],
          Cmd: ["/tmp/ctxpipe-git-fixture/server.mjs"],
          Env: [
            `GIT_FIXTURE_BIND=${gateway}`,
            `GIT_FIXTURE_PORT=${port}`,
            `GIT_FIXTURE_REPOSITORY_PATH=${repositoryPath}`,
            `GIT_FIXTURE_REQUEST_LOG=${requestLog}`,
            ...(basicAuth
              ? [
                  `GIT_FIXTURE_BOOTSTRAP_TOKEN=${basicAuth.bootstrapToken}`,
                  `GIT_FIXTURE_READ_TOKEN=${basicAuth.readToken}`,
                ]
              : []),
          ],
          HostConfig: { NetworkMode: "host" },
          Labels: { "ai.ctxpipe.purpose": "native-https-git-fixture" },
        })
        await server.putArchive(await readFile(serverArchive), { path: "/" })
        await server.start()
        await waitForListener(server, gateway, port)

        const sync = async () => {
          const bundle = join(root, `update-${randomUUID()}.bundle`)
          const archive = `${bundle}.tar`
          try {
            await exec(
              "git",
              ["-C", directory, "bundle", "create", bundle, "--all"],
              { timeout: 30_000 },
            )
            await exec(
              "tar",
              ["--no-xattrs", "-C", root, "-cf", archive, basename(bundle)],
              { timeout: 10_000 },
            )
            await server?.putArchive(await readFile(archive), { path: "/tmp" })
            await runExec(
              server,
              [
                "sh",
                "-c",
                `git -c safe.directory=/srv/repo.git --git-dir=/srv/repo.git fetch --force /tmp/${basename(bundle)} '+refs/heads/*:refs/heads/*' && rm -f /tmp/${basename(bundle)}`,
              ],
              "0:0",
            )
          } finally {
            await rm(bundle, { force: true })
            await rm(archive, { force: true })
          }
        }

        const observedRequests = async (): Promise<
          Array<NativeHttpsGitRequest>
        > => {
          const text = await runExecOutput(server, ["cat", requestLog])
          return text
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as NativeHttpsGitRequest)
        }

        try {
          const remoteUrl = new URL(`https://${hostname}`)
          if (port !== 443) remoteUrl.port = String(port)
          remoteUrl.pathname = repositoryPath
          return await remoteFn({
            url: remoteUrl.href,
            sync,
            observedRequests,
          })
        } catch (error) {
          const logs = (await server.logs({ stdout: true, stderr: true }))
            .toString()
            .replaceAll(/[^\x20-\x7e\n]/g, "")
            .trim()
          throw new Error(
            `Native HTTPS Git remote callback failed: ${String(error)}; server logs: ${logs || "<empty>"}`,
            { cause: error },
          )
        } finally {
          await server.remove({ force: true, v: true })
          server = undefined
        }
      },
    })
  } catch (error) {
    primaryError = error
  } finally {
    for (const container of [server, customizer]) {
      if (!container) continue
      try {
        await container.remove({ force: true, v: true })
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode !== 404)
          cleanupErrors.push(error)
      }
    }
    try {
      await input.docker.getImage(derivedImage).remove()
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode !== 404)
        cleanupErrors.push(error)
    }
    try {
      await rm(root, { recursive: true, force: true })
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  if (primaryError || cleanupErrors.length) {
    const errors = [primaryError, ...cleanupErrors].filter(
      (error) => error !== undefined,
    )
    throw new AggregateError(
      errors,
      `Native HTTPS Git fixture failed: ${errors.map(String).join("; ")}`,
    )
  }
  return result as T
}

async function runExec(
  container: Docker.Container | undefined,
  command: string[],
  user?: string,
): Promise<void> {
  await runExecOutput(container, command, user)
}

async function runExecOutput(
  container: Docker.Container | undefined,
  command: string[],
  user?: string,
): Promise<string> {
  if (!container) throw new Error("Native HTTPS Git fixture container missing")
  const execution = await container.exec({
    Cmd: command,
    AttachStdout: true,
    AttachStderr: true,
    ...(user ? { User: user } : {}),
  })
  const stream = await execution.start({ hijack: true })
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const output: Buffer[] = []
  stdout.on("data", (chunk: Buffer) => output.push(chunk))
  stderr.on("data", (chunk: Buffer) => output.push(chunk))
  container.modem.demuxStream(stream, stdout, stderr)
  await finished(stream)
  const info = await execution.inspect()
  if (info.ExitCode !== 0)
    throw new Error(
      `Native HTTPS Git fixture command exited ${info.ExitCode}: ${Buffer.concat(output).toString().trim()}`,
    )
  return Buffer.concat(output).toString()
}

async function waitForListener(
  container: Docker.Container,
  host: string,
  port: number,
): Promise<void> {
  const deadline = Date.now() + 10_000
  while (true) {
    try {
      await runExec(container, [
        "node",
        "-e",
        `const socket=require("node:net").connect({host:${JSON.stringify(host)},port:${port}});socket.setTimeout(250);socket.once("connect",()=>{socket.destroy();process.exit(0)});socket.once("error",()=>process.exit(1));socket.once("timeout",()=>process.exit(1))`,
      ])
      return
    } catch {
      // Inspect below distinguishes startup delay from a failed server.
    }
    const info = await container.inspect()
    if (!info.State.Running)
      throw new Error(
        `Native HTTPS Git fixture exited before readiness: ${(await container.logs({ stdout: true, stderr: true })).toString().trim()}`,
      )
    if (Date.now() >= deadline)
      throw new Error("Native HTTPS Git fixture did not become ready")
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

const smartGitServerSource = String.raw`
import { spawn } from "node:child_process"
import { appendFileSync, readFileSync } from "node:fs"
import { createServer } from "node:https"

const publicRepositoryPath = process.env.GIT_FIXTURE_REPOSITORY_PATH ?? "/repo.git"
const requestLog = process.env.GIT_FIXTURE_REQUEST_LOG ?? "/tmp/ctxpipe-git-fixture/requests.log"
const bootstrapToken = process.env.GIT_FIXTURE_BOOTSTRAP_TOKEN
const readToken = process.env.GIT_FIXTURE_READ_TOKEN

function authCategory(request) {
  const value = request.headers.authorization
  if (!value) return "none"
  if (!value.startsWith("Basic ")) return "invalid"
  let decoded
  try {
    decoded = Buffer.from(value.slice(6), "base64").toString("utf8")
  } catch {
    return "invalid"
  }
  const separator = decoded.indexOf(":")
  const token = separator < 0 ? "" : decoded.slice(separator + 1)
  if (token === bootstrapToken) return "bootstrap"
  if (token === readToken) return "read"
  return "invalid"
}

function pathInfo(pathname) {
  if (pathname === publicRepositoryPath) return "/repo.git"
  if (pathname.startsWith(publicRepositoryPath + "/"))
    return "/repo.git" + pathname.slice(publicRepositoryPath.length)
  return pathname
}

const server = createServer(
  {
    key: readFileSync("/tmp/ctxpipe-git-fixture/server.key"),
    cert: readFileSync("/tmp/ctxpipe-git-fixture/server.crt"),
  },
  (request, response) => {
    const url = new URL(request.url ?? "/", "https://host.docker.internal")
    const auth = authCategory(request)
    appendFileSync(
      requestLog,
      JSON.stringify({ method: request.method ?? "", path: url.pathname, auth }) + "\\n",
    )
    if ((bootstrapToken || readToken) && auth !== "bootstrap" && auth !== "read") {
      response.writeHead(401, {
        "WWW-Authenticate": 'Basic realm="ctxpipe-native-git-fixture"',
        connection: "close",
      })
      response.end("Authentication required\\n")
      return
    }
    const child = spawn(
      "git",
      [
        "-c",
        "safe.directory=.",
        "-c",
        "safe.directory=/srv/repo.git",
        "http-backend",
      ],
      {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: "/srv",
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: pathInfo(url.pathname),
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: request.method ?? "GET",
        CONTENT_TYPE: request.headers["content-type"] ?? "",
        CONTENT_LENGTH: request.headers["content-length"] ?? "",
        HTTP_GIT_PROTOCOL: request.headers["git-protocol"] ?? "",
        REMOTE_ADDR: request.socket.remoteAddress ?? "",
      },
        stdio: ["pipe", "pipe", "pipe"],
      },
    )
    request.pipe(child.stdin)
    let headersSent = false
    let pending = Buffer.alloc(0)
    child.stdout.on("data", (chunk) => {
      if (headersSent) {
        response.write(chunk)
        return
      }
      pending = Buffer.concat([pending, chunk])
      const text = pending.toString("latin1")
      const match = /\r?\n\r?\n/.exec(text)
      if (!match || match.index === undefined) return
      const headerEnd = match.index + match[0].length
      const headers = {}
      let status = 200
      for (const line of text.slice(0, match.index).split(/\r?\n/)) {
        const separator = line.indexOf(":")
        if (separator < 0) continue
        const name = line.slice(0, separator).trim()
        const value = line.slice(separator + 1).trim()
        if (name.toLowerCase() === "status") status = Number(value.slice(0, 3))
        else headers[name] = value
      }
      response.writeHead(status, headers)
      headersSent = true
      response.write(pending.subarray(Buffer.byteLength(text.slice(0, headerEnd), "latin1")))
      pending = Buffer.alloc(0)
    })
    child.stdout.on("end", () => {
      if (!headersSent) response.writeHead(502)
      response.end()
    })
    child.stderr.pipe(process.stderr)
    request.once("aborted", () => child.kill("SIGTERM"))
  },
)
server.listen(Number(process.env.GIT_FIXTURE_PORT), process.env.GIT_FIXTURE_BIND, () => {
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("port missing")
  process.stdout.write(JSON.stringify({ port: address.port }) + "\\n")
})
`
