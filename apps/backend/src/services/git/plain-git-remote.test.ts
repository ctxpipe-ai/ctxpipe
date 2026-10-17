import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import {
  isPublicAddress,
  PlainGitUrlError,
  plainGitRemote,
  resolvePlainGitRemote,
} from "./plain-git-remote.js"

const exec = promisify(execFile)

/** A DNS answer for each test host name. */
const answers: Record<string, string[]> = {
  "git.example.org": [
    "93.184.215.14",
    "2606:2800:21f:cb07:6820:80da:af6b:8b2c",
  ],
  "loopback.example.org": ["127.0.0.1"],
  "private.example.org": ["93.184.215.14", "10.1.2.3"],
  "metadata.example.org": ["169.254.169.254"],
  "shared.example.org": ["100.64.0.1"],
  "ula.example.org": ["fd00:ec2::254"],
  "mapped.example.org": ["::ffff:127.0.0.1"],
  "linklocal6.example.org": ["fe80::1"],
}
const lookup = async (host: string) =>
  (answers[host] ?? []).map((address) => ({ address }))

describe("resolvePlainGitRemote", () => {
  it("gives the checked URL and the public addresses of the host", async () => {
    await expect(
      resolvePlainGitRemote("https://Git.Example.org/team/app.git", lookup),
    ).resolves.toEqual({
      url: "https://git.example.org/team/app.git",
      host: "git.example.org",
      path: "/team/app.git",
      addresses: answers["git.example.org"],
    })
  })

  it.each([
    "loopback.example.org",
    "private.example.org",
    "metadata.example.org",
    "shared.example.org",
    "ula.example.org",
    "mapped.example.org",
    "linklocal6.example.org",
  ])("refuses a host that resolves to a private address: %s", async (host) => {
    await expect(
      resolvePlainGitRemote(`https://${host}/team/app.git`, lookup),
    ).rejects.toMatchObject({ rule: "private_address" })
  })

  it("refuses a host with no address, and each URL rule before any lookup", async () => {
    await expect(
      resolvePlainGitRemote("https://none.example.org/team/app.git", lookup),
    ).rejects.toMatchObject({ rule: "no_address" })
    const looked: string[] = []
    const recorded = async (host: string) => {
      looked.push(host)
      return lookup(host)
    }
    for (const url of [
      "http://git.example.org/team/app.git",
      "https://user:secret@git.example.org/team/app.git",
      "https://git.example.org:8443/team/app.git",
      "https://169.254.169.254/latest/meta-data",
    ])
      await expect(resolvePlainGitRemote(url, recorded)).rejects.toBeInstanceOf(
        PlainGitUrlError,
      )
    expect(looked).toEqual([])
  })

  it("tells public addresses from the blocked ranges", () => {
    expect(isPublicAddress("93.184.215.14")).toBe(true)
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true)
    for (const address of [
      "0.0.0.0",
      "10.0.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "192.168.1.1",
      "198.18.0.1",
      "224.0.0.1",
      "::1",
      "fd12:3456:789a::1",
      "fe80::1",
      "::ffff:10.0.0.1",
      "not-an-address",
    ])
      expect(isPublicAddress(address), address).toBe(false)
  })
})

describe("a plain git read with real git", () => {
  let server: Server
  let folder: string
  const requests: Array<{ url: string; authorization: string | null }> = []

  beforeAll(async () => {
    // The repository path redirects to another repository, as a hostile or
    // a moved server can answer. Git that follows it asks this server again.
    server = createServer((request, response) => {
      requests.push({
        url: request.url ?? "",
        authorization: request.headers.authorization ?? null,
      })
      response.writeHead(302, {
        location: `http://${request.headers.host}/elsewhere.git/info/refs?service=git-upload-pack`,
      })
      response.end()
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const { port } = server.address() as AddressInfo
    folder = await mkdtemp(join(tmpdir(), "plain-git-remote-"))
    // The environment of the test: `git.example.org` is this local server.
    const config = join(folder, "gitconfig")
    await writeFile(
      config,
      `[url "http://127.0.0.1:${port}/"]\n\tinsteadOf = https://git.example.org/\n[protocol "http"]\n\tallow = always\n`,
    )
    vi.stubEnv("GIT_CONFIG_GLOBAL", config)
  })

  afterAll(async () => {
    vi.unstubAllEnvs()
    await new Promise((resolve) => server.close(resolve))
    await rm(folder, { recursive: true, force: true })
  })

  it("follows no redirect and sends no credential", async () => {
    const remote = await plainGitRemote(
      "https://git.example.org/team/app.git",
      lookup,
    )
    expect(remote.env).toMatchObject({
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "",
    })
    const result = await exec("git", ["ls-remote", "--", remote.url], {
      env: { ...process.env, ...remote.env },
      timeout: 30_000,
    }).then(
      () => ({ ok: true, stderr: "" }),
      (error: { stderr?: string }) => ({ ok: false, stderr: error.stderr }),
    )
    expect(result.ok).toBe(false)
    expect(result.stderr).toMatch(/returned error: 302/)
    // Git asked only the repository path, once, with no credential, and not
    // the redirect target.
    expect(requests).toEqual([
      {
        url: "/team/app.git/info/refs?service=git-upload-pack",
        authorization: null,
      },
    ])
  })
})
