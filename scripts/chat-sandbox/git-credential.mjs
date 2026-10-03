#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { request } from "node:http"
import { basename } from "node:path"

const isGh = basename(process.argv[1]) === "gh"
if (isGh && ["--version", "--help", "help"].includes(process.argv[2])) {
  const result = spawnSync("/usr/bin/gh", process.argv.slice(2), {
    stdio: "inherit",
    env: { ...process.env, GH_TOKEN: "", GITHUB_TOKEN: "" },
  })
  process.exit(result.status ?? 1)
}
const capability = process.env.CTXPIPE_GIT_RUN_CAPABILITY
if (!isGh && process.argv[2] !== "get") process.exit(0)
if (!capability) {
  if (isGh)
    process.stderr.write("Workspace GitHub read capability is unavailable.\n")
  process.exit(isGh ? 1 : 0)
}

try {
  let repositoryUrl
  if (!isGh) {
    let input = ""
    for await (const chunk of process.stdin) {
      input += chunk
      if (input.length > 16_384)
        throw new Error("Credential input exceeds limit")
    }
    const fields = Object.fromEntries(
      input
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const separator = line.indexOf("=")
          return [line.slice(0, separator), line.slice(separator + 1)]
        }),
    )
    if (
      fields.protocol !== "https" ||
      fields.host !== "github.com" ||
      !fields.path
    )
      process.exit(0)
    repositoryUrl = `https://github.com/${fields.path}`
  }
  const target = new URL(
    `${process.env.CTXPIPE_MODEL_PROXY_URL?.replace(/\/$/, "")}/git-credentials`,
  )
  if (
    target.protocol !== "http:" ||
    target.username ||
    target.password ||
    target.search ||
    target.hash
  )
    throw new Error("Invalid credential broker URL")
  const proxy = process.env.HTTP_PROXY || process.env.http_proxy
  const endpoint = proxy ? new URL(proxy) : target
  if (endpoint.protocol !== "http:" || endpoint.username || endpoint.password)
    throw new Error("Invalid credential proxy")
  const credential = await new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: endpoint.hostname,
        port: endpoint.port || 80,
        method: "GET",
        path: proxy ? target.href : target.pathname,
        headers: {
          host: target.host,
          authorization: `Bearer ${capability}`,
          ...(repositoryUrl ? { "x-ctxpipe-repository": repositoryUrl } : {}),
        },
      },
      (res) => {
        let data = ""
        res.setEncoding("utf8")
        res.on("data", (chunk) => {
          data += chunk
          if (data.length > 16_384)
            res.destroy(new Error("Credential response exceeds limit"))
        })
        res.on("error", reject)
        res.on("end", () => {
          if (res.statusCode !== 200)
            return reject(new Error("Credential broker denied request"))
          try {
            resolve(JSON.parse(data))
          } catch {
            reject(new Error("Invalid credential response"))
          }
        })
      },
    )
    req.setTimeout(10_000, () =>
      req.destroy(new Error("Credential broker timeout")),
    )
    req.on("error", reject)
    req.end()
  })
  if (
    credential.username !== "x-access-token" ||
    typeof credential.password !== "string" ||
    !credential.password ||
    /[\r\n\0]/.test(credential.password)
  )
    throw new Error("Invalid credential response")
  if (isGh) {
    const result = spawnSync("/usr/bin/gh", process.argv.slice(2), {
      stdio: "inherit",
      env: {
        ...process.env,
        GH_HOST: "github.com",
        GH_TOKEN: credential.password,
        GITHUB_TOKEN: "",
        GH_ENTERPRISE_TOKEN: "",
        GITHUB_ENTERPRISE_TOKEN: "",
      },
    })
    if (result.error) throw new Error("GitHub CLI failed to start")
    process.exit(result.status ?? 1)
  }
  process.stdout.write(
    `username=x-access-token\npassword=${credential.password}\n\n`,
  )
} catch {
  // Do not print broker responses, authorization headers, or short-lived tokens.
  process.stderr.write("Workspace GitHub read credential unavailable.\n")
  process.exitCode = 1
}
