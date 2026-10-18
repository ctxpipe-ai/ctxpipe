import { randomBytes } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import type { PinnedPlainGitRemote } from "../../../../../shared/plain-git.js"
import type { Db } from "../../db/client.js"
import {
  bareRepository,
  type GitHttpRequest,
  git,
  startGitHttpServer,
} from "../../test/gitHttpServer.js"
import { usePlainGitLimits } from "../../utils/git.js"
import { phaseCloneCheckout } from "./phases.js"

/*
 * Codesearch reads a repository with no GitHub token only through the plain
 * git remote that the backend checked (CTX-815), with real git against a
 * real local Git HTTP server. The host name `plain-git.invalid` has no DNS
 * record: git reaches the server only through the checked address that the
 * remote pins (`http.curloptResolve`).
 */

let root: string
let headSha: string
let server: Awaited<ReturnType<typeof startGitHttpServer>>
let elsewhere: Server
const elsewhereRequests: string[] = []

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "codesearch-plain-git-"))
  const repos = join(root, "repos")
  headSha = await bareRepository(repos, "team/app.git", { "a.txt": "one\n" })
  await bareRepository(repos, "team/large.git", {
    "large.bin": randomBytes(1024 * 1024),
  })
  // The target of a redirect: an internal service that git must not reach.
  elsewhere = createServer((request, response) => {
    elsewhereRequests.push(request.url ?? "")
    response.writeHead(404)
    response.end()
  })
  await new Promise<void>((resolve) =>
    elsewhere.listen(0, "127.0.0.1", resolve),
  )
  const elsewherePort = (elsewhere.address() as AddressInfo).port
  server = await startGitHttpServer(repos, (request, response) => {
    if (request.url?.startsWith("/team/moved.git/")) {
      response.writeHead(302, {
        location: `http://127.0.0.1:${elsewherePort}${request.url.replace("/team/moved.git/", "/team/app.git/")}`,
      })
      response.end()
      return true
    }
    // The refs come at once; the pack never comes.
    if (
      request.url?.startsWith("/team/slow.git/") &&
      request.method === "POST"
    ) {
      response.writeHead(200, {
        "content-type": "application/x-git-upload-pack-result",
      })
      response.flushHeaders()
      return true
    }
    if (request.url?.startsWith("/team/slow.git/")) {
      request.url = request.url.replace("/team/slow.git/", "/team/app.git/")
      return false
    }
    return false
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

afterAll(async () => {
  await server?.stop()
  await new Promise((resolve) => elsewhere?.close(resolve))
  await rm(root, { recursive: true, force: true })
})

function pinned(path: string, overrides: Partial<PinnedPlainGitRemote> = {}) {
  return {
    url: `http://plain-git.invalid:${server.port}${path}`,
    host: "plain-git.invalid",
    port: server.port,
    addresses: ["127.0.0.1"],
    policy: { http: true, privateHosts: true },
    ...overrides,
  }
}

function context(
  name: string,
  input: { repoGitUrl: string; plainGit?: PinnedPlainGitRemote },
) {
  return {
    // Step writes are best-effort; an unusable database only drops them.
    db: {} as Db,
    orgId: "org_test",
    repoId: "repo_test",
    checkoutKey: "main",
    clonePath: join(root, "clones", name),
    scipIndexPath: join(root, "scip"),
    zoektRepoId: 1,
    zoektName: "plain-git.invalid/team/app",
    repoName: "team/app",
    repoUrl: "http://plain-git.invalid/team/app",
    ...input,
  }
}

function since(before: number): GitHttpRequest[] {
  return server.requests.slice(before)
}

describe("phaseCloneCheckout of a plain git repository", () => {
  it("clones the checked URL through the pinned address, not the stored URL, with no proxy and no global config", async () => {
    // A proxy and a global git config of the codesearch process: a plain
    // git read uses neither.
    vi.stubEnv("http_proxy", "http://127.0.0.1:1")
    vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:1")
    const config = join(root, "gitconfig")
    await writeFile(config, "[http]\n\tproxy = http://127.0.0.1:1\n")
    vi.stubEnv("GIT_CONFIG_GLOBAL", config)
    const before = server.requests.length
    const result = await phaseCloneCheckout(
      context("pinned", {
        // The stored row: another scheme and host than the checked URL.
        repoGitUrl: "ssh://git@plain-git.invalid/team/app.git",
        plainGit: pinned("/team/app.git"),
      }),
      {},
    )
    expect(result.targetHash).toBe(headSha)
    expect(
      await git(
        ["remote", "get-url", "origin"],
        join(root, "clones", "pinned"),
      ),
    ).toBe(`http://plain-git.invalid:${server.port}/team/app.git`)
    expect(since(before).every((r) => r.url.startsWith("/team/app.git/"))).toBe(
      true,
    )
  })

  it("follows no redirect to another address", async () => {
    const before = elsewhereRequests.length
    await expect(
      phaseCloneCheckout(
        context("moved", {
          repoGitUrl: `http://127.0.0.1:${server.port}/team/moved.git`,
          plainGit: pinned("/team/moved.git"),
        }),
        {},
      ),
    ).rejects.toThrow(/302/)
    expect(elsewhereRequests.slice(before)).toEqual([])
  })

  it.each([
    ["file://", (dir: string) => `file://${dir}/repos/team/app.git`],
    ["a local path", (dir: string) => `${dir}/repos/team/app.git`],
    ["ssh", () => "ssh://git@127.0.0.1:1/team/app.git"],
    ["git://", () => "git://127.0.0.1:1/team/app.git"],
    ["an http URL with no checked remote", () => "http://127.0.0.1:1/x.git"],
  ])("does not read a stored %s URL that has no token and no checked remote", async (_name, url) => {
    const clonePath = join(root, "clones", `stored-${_name.replace(/\W/g, "")}`)
    await expect(
      phaseCloneCheckout(
        { ...context("unused", { repoGitUrl: url(root) }), clonePath },
        {},
      ),
    ).rejects.toThrow(/only with a GitHub token or with a plain git remote/)
  })

  it.each([
    ["file://", (dir: string) => `file://${dir}/repos/team/app.git`],
    ["ssh", () => "ssh://git@127.0.0.1/team/app.git"],
    ["git://", () => "git://127.0.0.1/team/app.git"],
  ])("refuses a checked remote with a %s URL", async (_name, url) => {
    await expect(
      phaseCloneCheckout(
        context("scheme", {
          repoGitUrl: url(root),
          plainGit: pinned("/x", { url: url(root) }),
        }),
        {},
      ),
    ).rejects.toThrow(/ssh, git:\/\/ and file:\/\/ are not supported/)
  })

  it("refuses http when the policy of the check does not allow it", async () => {
    await expect(
      phaseCloneCheckout(
        context("hosted-http", {
          repoGitUrl: "http://plain-git.invalid/team/app.git",
          plainGit: pinned("/team/app.git", {
            policy: { http: false, privateHosts: false },
            addresses: ["93.184.215.14"],
          }),
        }),
        {},
      ),
    ).rejects.toThrow(/https:\/\/ URL/)
  })

  it.each([
    "169.254.169.254",
    "169.254.170.2",
    "::ffff:169.254.169.254",
    "::169.254.169.254",
    "64:ff9b::a9fe:a9fe",
    "fd00:ec2::254",
    "fe80::1",
  ])("refuses a self-host remote that resolves to the metadata address %s", async (address) => {
    const before = server.requests.length
    await expect(
      phaseCloneCheckout(
        context("metadata", {
          repoGitUrl: "http://plain-git.invalid/team/app.git",
          plainGit: pinned("/team/app.git", { addresses: [address] }),
        }),
        {},
      ),
    ).rejects.toThrow(/cloud metadata or link-local/)
    expect(since(before)).toEqual([])
  })

  it("refuses a hosted remote with a private address", async () => {
    await expect(
      phaseCloneCheckout(
        context("hosted-private", {
          repoGitUrl: "https://plain-git.invalid/team/app.git",
          plainGit: pinned("/team/app.git", {
            url: "https://plain-git.invalid/team/app.git",
            port: 443,
            addresses: ["10.0.0.5"],
            policy: { http: false, privateHosts: false },
          }),
        }),
        {},
      ),
    ).rejects.toThrow(/private, loopback, or link-local/)
  })

  it("stops a host that does not send the pack in time", async () => {
    const restore = usePlainGitLimits({ timeoutMs: 3_000 })
    const started = Date.now()
    try {
      await expect(
        phaseCloneCheckout(
          context("slow", {
            repoGitUrl: "http://plain-git.invalid/team/slow.git",
            plainGit: pinned("/team/slow.git"),
          }),
          {},
        ),
      ).rejects.toThrow(/did not finish in 3000 ms/)
    } finally {
      restore()
    }
    expect(Date.now() - started).toBeLessThan(20_000)
  }, 30_000)

  it("stops a pack that is larger than the size limit", async () => {
    const restore = usePlainGitLimits({ maxFileBytes: 64 * 1024 })
    try {
      await expect(
        phaseCloneCheckout(
          context("large", {
            repoGitUrl: "http://plain-git.invalid/team/large.git",
            plainGit: pinned("/team/large.git"),
          }),
          {},
        ),
      ).rejects.toThrow()
    } finally {
      restore()
    }
    // The same repository clones with the default limit.
    const result = await phaseCloneCheckout(
      context("large-ok", {
        repoGitUrl: "http://plain-git.invalid/team/large.git",
        plainGit: pinned("/team/large.git"),
      }),
      {},
    )
    expect(result.targetHash).toMatch(/^[0-9a-f]{40}$/)
  }, 30_000)
})
