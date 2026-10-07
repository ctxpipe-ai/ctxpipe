import { execFile } from "node:child_process"
import { randomBytes, randomUUID } from "node:crypto"
import { promisify } from "node:util"
import type { AgentVaultAccess } from "../domain/workspaces/agent-vault.js"

const exec = promisify(execFile)

const docker = async (...args: string[]) =>
  (await exec("docker", args, { timeout: 180_000 })).stdout.trim()

/**
 * An upstream on the test network: it echoes the request headers at
 * `/echo/*`, and serves the bare repository `/srv/repo.git` with
 * `git http-backend` at `/git/*` when Basic auth is `x-access-token:<GIT_TOKEN>`.
 */
const UPSTREAM = `
const http = require("node:http")
const { spawn } = require("node:child_process")
http.createServer((req, res) => {
  if (req.url.startsWith("/echo/")) {
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ url: req.url, headers: req.headers }))
    return
  }
  const expected = "Basic " + Buffer.from("x-access-token:" + process.env.GIT_TOKEN).toString("base64")
  if (req.headers.authorization !== expected) {
    res.writeHead(401, { "www-authenticate": 'Basic realm="git"' })
    res.end()
    return
  }
  const url = new URL(req.url, "http://upstream")
  const cgi = spawn("git", ["http-backend"], { env: {
    ...process.env,
    GIT_PROJECT_ROOT: "/srv",
    GIT_HTTP_EXPORT_ALL: "1",
    REMOTE_USER: "x-access-token",
    REQUEST_METHOD: req.method,
    PATH_INFO: url.pathname.replace(/^\\/git/, ""),
    QUERY_STRING: url.search.slice(1),
    CONTENT_TYPE: req.headers["content-type"] || "",
    HTTP_CONTENT_ENCODING: req.headers["content-encoding"] || "",
  } })
  req.pipe(cgi.stdin)
  let head = Buffer.alloc(0), sent = false
  cgi.stdout.on("data", (chunk) => {
    if (sent) return void res.write(chunk)
    head = Buffer.concat([head, chunk])
    const end = head.indexOf("\\r\\n\\r\\n")
    if (end < 0) return
    sent = true
    let status = 200
    for (const line of head.subarray(0, end).toString().split("\\r\\n")) {
      const i = line.indexOf(":")
      const key = line.slice(0, i), value = line.slice(i + 1).trim()
      if (key.toLowerCase() === "status") status = Number.parseInt(value)
      else res.setHeader(key, value)
    }
    res.writeHead(status)
    res.write(head.subarray(end + 4))
  })
  cgi.on("close", () => res.end())
}).listen(8080, "0.0.0.0")
`

export type AgentVaultFixture = {
  access: AgentVaultAccess
  network: string
  /** The upstream's name on the test network (rules take names, not IPs). */
  upstream: string
  gitToken: string
  /** Run `script` in a fresh chat-image container on the test network. */
  sandbox: (
    env: Record<string, string>,
    script: string,
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>
  stopAgentVault: () => Promise<void>
}

async function ipOn(container: string, network: string): Promise<string> {
  return docker(
    "inspect",
    "--format",
    `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`,
    container,
  )
}

/**
 * A real Agent Vault (`infisical/agent-vault:latest`) on its own network, as
 * Compose runs it: the proxy may dial only the upstream (the backend's place).
 */
export async function withAgentVault<T>(
  input: { image: string },
  fn: (fixture: AgentVaultFixture) => Promise<T>,
): Promise<T> {
  const id = randomUUID().slice(0, 8)
  const network = `ctxpipe-av-test-${id}`
  const vaultName = `ctxpipe-av-test-${id}`
  const upstreamName = `ctxpipe-av-upstream-${id}`
  const gitToken = `ghs_${randomBytes(12).toString("hex")}`
  const ownerPassword = randomBytes(16).toString("hex")
  await docker("network", "create", network)
  try {
    await docker(
      "run",
      "-d",
      "--name",
      upstreamName,
      "--network",
      network,
      "--network-alias",
      "upstream.ctxpipe.test",
      "--user",
      "0:0",
      "-e",
      `GIT_TOKEN=${gitToken}`,
      "--entrypoint",
      "sh",
      input.image,
      "-c",
      `git init -q --bare /srv/repo.git &&
git -C /srv/repo.git config http.receivepack true &&
git init -q /tmp/seed && cd /tmp/seed &&
git -c user.name=t -c user.email=t@t commit -q --allow-empty -m seed &&
git push -q /srv/repo.git HEAD:refs/heads/main &&
git -C /srv/repo.git symbolic-ref HEAD refs/heads/main &&
cat > /tmp/upstream.cjs <<'EOF'
${UPSTREAM}
EOF
exec node /tmp/upstream.cjs`,
    )
    const upstreamIp = await ipOn(upstreamName, network)
    await docker(
      "run",
      "-d",
      "--name",
      vaultName,
      "--network",
      network,
      "-p",
      "127.0.0.1::14321",
      "-e",
      `AGENT_VAULT_MASTER_PASSWORD=${randomBytes(16).toString("hex")}`,
      "-e",
      "AGENT_VAULT_RATELIMIT_PROFILE=off",
      "-e",
      "AGENT_VAULT_TELEMETRY=false",
      "-e",
      `AGENT_VAULT_NETWORK_ALLOWLIST=${upstreamIp}`,
      "infisical/agent-vault:latest",
    )
    const port = (await docker("port", vaultName, "14321/tcp"))
      .split("\n")[0]
      ?.split(":")
      .pop()
    const address = `http://127.0.0.1:${port}`
    const deadline = Date.now() + 60_000
    for (;;) {
      const healthy = await fetch(`${address}/health`)
        .then((response) => response.ok)
        .catch(() => false)
      if (healthy) break
      if (Date.now() > deadline)
        throw new Error("Agent Vault did not become healthy")
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    const proxyHost = await ipOn(vaultName, network)
    return await fn({
      access: {
        address,
        proxyHost,
        ownerPassword: async () => ownerPassword,
      },
      network,
      upstream: "upstream.ctxpipe.test",
      gitToken,
      sandbox: async (env, script) => {
        const args = ["run", "--rm", "--network", network]
        for (const [key, value] of Object.entries(env))
          args.push("-e", `${key}=${value}`)
        args.push(input.image, "sh", "-c", script)
        try {
          const { stdout, stderr } = await exec("docker", args, {
            timeout: 120_000,
          })
          return { exitCode: 0, stdout, stderr }
        } catch (error) {
          const failed = error as {
            code?: number
            stdout?: string
            stderr?: string
          }
          return {
            exitCode: typeof failed.code === "number" ? failed.code : 1,
            stdout: failed.stdout ?? "",
            stderr: failed.stderr ?? "",
          }
        }
      },
      stopAgentVault: async () => {
        await docker("stop", "-t", "1", vaultName)
      },
    })
  } finally {
    await docker("rm", "-f", "-v", vaultName, upstreamName).catch(() => "")
    await docker("network", "rm", network).catch(() => "")
  }
}
