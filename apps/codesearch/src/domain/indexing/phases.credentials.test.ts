import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import type { Db } from "../../db/client.js"
import { phaseCloneCheckout } from "./phases.js"

// A local HTTP proxy, set in a test-only global Git config, gets each request.
// For the host github.com it is a real Git remote (git http-backend) that
// requires the token. For each other host it records the Authorization header.
const TOKEN = "ghs_test_clone_token_4f2a9c"
const BASIC = Buffer.from(`x-access-token:${TOKEN}`).toString("base64")
let root: string
let server: ReturnType<typeof Bun.serve>
const otherHostAuthorizations: string[] = []
let headSha: string

// Async, because the test server runs in this process.
async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await promisify(execFile)("git", args, { cwd })
  return stdout.trim()
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "codesearch-creds-"))
  const work = join(root, "work")
  await git(["init", "-q", "-b", "main", work])
  await writeFile(join(work, "a.txt"), "one\n")
  await git(
    ["-c", "user.email=t@example.com", "-c", "user.name=t", "add", "."],
    work,
  )
  await git(
    [
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=t",
      "commit",
      "-qm",
      "one",
    ],
    work,
  )
  await git([
    "clone",
    "-q",
    "--bare",
    work,
    join(root, "repos", "acme", "demo.git"),
  ])
  headSha = await git(["rev-parse", "HEAD"], work)

  const unauthorized = () =>
    new Response("auth", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="git"' },
    })
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.host !== "github.com") {
        otherHostAuthorizations.push(request.headers.get("authorization") ?? "")
        return unauthorized()
      }
      // A repository that moved to another host.
      if (url.pathname.startsWith("/acme/moved.git/"))
        return Response.redirect(
          `http://other.example${url.pathname}${url.search}`,
          302,
        )
      // A renamed repository: a redirect on the same host.
      if (url.pathname.startsWith("/acme/renamed.git/"))
        return Response.redirect(
          `http://github.com${url.pathname.replace("/acme/renamed.git/", "/acme/demo.git/")}${url.search}`,
          301,
        )
      if (request.headers.get("authorization") !== `Basic ${BASIC}`)
        return unauthorized()
      const child = Bun.spawn(["git", "http-backend"], {
        env: {
          ...process.env,
          GIT_PROJECT_ROOT: join(root, "repos"),
          GIT_HTTP_EXPORT_ALL: "1",
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          REQUEST_METHOD: request.method,
          CONTENT_TYPE: request.headers.get("content-type") ?? "",
          HTTP_CONTENT_ENCODING: request.headers.get("content-encoding") ?? "",
          HTTP_GIT_PROTOCOL: request.headers.get("git-protocol") ?? "",
        },
        stdin: new Uint8Array(await request.arrayBuffer()),
        stdout: "pipe",
      })
      const out = new Uint8Array(await new Response(child.stdout).arrayBuffer())
      const split = Buffer.from(out).indexOf("\r\n\r\n")
      const headers = new Headers()
      let status = 200
      for (const line of Buffer.from(out.subarray(0, split))
        .toString()
        .split("\r\n")) {
        const [key, ...rest] = line.split(":")
        const value = rest.join(":").trim()
        if (key?.toLowerCase() === "status") status = Number.parseInt(value, 10)
        else if (key) headers.set(key, value)
      }
      return new Response(out.subarray(split + 4), { status, headers })
    },
  })
  const globalConfig = join(root, "gitconfig")
  await writeFile(
    globalConfig,
    `[http]\n\tproxy = http://127.0.0.1:${server.port}\n`,
  )
  vi.stubEnv("GIT_CONFIG_GLOBAL", globalConfig)
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1")
  vi.stubEnv("NO_PROXY", "")
  vi.stubEnv("no_proxy", "")
})

afterAll(async () => {
  vi.unstubAllEnvs()
  server?.stop(true)
  await rm(root, { recursive: true, force: true })
})

function context(clonePath: string) {
  return {
    // Step writes are best-effort; an unusable database only drops them.
    db: {} as Db,
    orgId: "org_test",
    repoId: "repo_test",
    repoGitUrl: "http://github.com/acme/demo.git",
    checkoutKey: "main",
    clonePath,
    sharedClonePath: `${clonePath}-shared.git`,
    scipIndexPath: join(root, "scip"),
    zoektRepoId: 1,
    zoektName: "github.com/acme/demo",
    repoName: "acme/demo",
    repoUrl: "https://github.com/acme/demo",
    githubToken: TOKEN,
  }
}

describe("phaseCloneCheckout credentials", () => {
  it("keeps the remote URL plain after a clone", async () => {
    const clonePath = join(root, "clone-fresh")
    const result = await phaseCloneCheckout(context(clonePath), {})
    expect(result.targetHash).toBe(headSha)
    const config = await readFile(`${clonePath}-shared.git/config`, "utf8")
    expect(config).not.toContain(TOKEN)
    expect(config).toContain("url = http://github.com/acme/demo.git")
  })

  it("sets the plain remote URL on each fetch", async () => {
    const clonePath = join(root, "clone-old")
    await git([
      "clone",
      "-q",
      "--bare",
      `http://x-access-token:${TOKEN}@github.com/acme/demo.git`,
      `${clonePath}-shared.git`,
    ])
    expect(await readFile(`${clonePath}-shared.git/config`, "utf8")).toContain(
      TOKEN,
    )
    const result = await phaseCloneCheckout(context(clonePath), {})
    expect(result.targetHash).toBe(headSha)
    const config = await readFile(`${clonePath}-shared.git/config`, "utf8")
    expect(config).not.toContain(TOKEN)
  })

  it("keeps the credential out of error messages", async () => {
    const clonePath = join(root, "clone-refused")
    const error = await phaseCloneCheckout(
      { ...context(clonePath), githubToken: `${TOKEN}_wrong` },
      {},
    ).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(Error)
    expect(String((error as Error).message)).not.toContain(TOKEN)
    expect(String((error as Error).stack)).not.toContain(TOKEN)
  })

  it("follows a redirect on the same host with the token", async () => {
    const clonePath = join(root, "clone-renamed")
    const result = await phaseCloneCheckout(
      {
        ...context(clonePath),
        repoGitUrl: "http://github.com/acme/renamed.git",
      },
      {},
    )
    expect(result.targetHash).toBe(headSha)
  })

  it("does not give the token to another host after a redirect", async () => {
    const clonePath = join(root, "clone-moved")
    const error = await phaseCloneCheckout(
      { ...context(clonePath), repoGitUrl: "http://github.com/acme/moved.git" },
      {},
    ).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(Error)
    expect(otherHostAuthorizations.length).toBeGreaterThan(0)
    expect(otherHostAuthorizations.join("\n")).not.toContain(BASIC)
  })
})
