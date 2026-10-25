import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import {
  createServer as createHttpsServer,
  type Server as HttpsServer,
} from "node:https"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import { plainGitUrlPolicy } from "../../domain/workspace-sources/providers/git.js"
import {
  isMetadataAddress,
  isPublicAddress,
  PlainGitUrlError,
  plainGitRemote,
  plainGitRemoteEnvironment,
  resolvePlainGitRemote,
  resolvePlainGitTip,
  usePlainGitNetwork,
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
      port: 443,
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
      // IPv4-compatible (`::/96`), IPv4-mapped in its long form, and
      // IPv4-translated forms of a private or metadata address.
      "::169.254.169.254",
      "::a9fe:a9fe",
      "::7f00:1",
      "0:0:0:0:0:ffff:7f00:1",
      "::ffff:0:a9fe:a9fe",
      "not-an-address",
    ])
      expect(isPublicAddress(address), address).toBe(false)
  })

  it("tells the cloud metadata addresses, also in each IPv6 form", () => {
    for (const address of [
      "169.254.169.254",
      "169.254.170.2",
      "169.254.0.1",
      "::ffff:169.254.169.254",
      "::ffff:a9fe:aa02",
      "::169.254.169.254",
      "::ffff:0:169.254.169.254",
      "64:ff9b::a9fe:a9fe",
      "fd00:ec2::254",
      "fe80::1",
      "febf::1",
    ])
      expect(isMetadataAddress(address), address).toBe(true)
    for (const address of ["10.0.0.5", "127.0.0.1", "fd00::5", "93.184.215.14"])
      expect(isMetadataAddress(address), address).toBe(false)
  })
})

describe("the plain git policy of the deployment mode (SANDBOX_PROVIDER)", () => {
  const internal = async (host: string) =>
    host === "git.internal" ? [{ address: "10.1.2.3" }] : lookup(host)
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("docker: reads a private host, an IP host, http, and another port", async () => {
    vi.stubEnv("SANDBOX_PROVIDER", "docker")
    await expect(
      resolvePlainGitRemote("http://git.internal:3000/team/app.git", internal),
    ).resolves.toEqual({
      url: "http://git.internal:3000/team/app.git",
      host: "git.internal",
      port: 3000,
      path: "/team/app.git",
      addresses: ["10.1.2.3"],
    })
    // An IP host is its own address: no DNS lookup.
    const looked: string[] = []
    await expect(
      resolvePlainGitRemote("http://[fd00::5]:8080/team/app.git", async (h) => {
        looked.push(h)
        return []
      }),
    ).resolves.toMatchObject({ port: 8080, addresses: ["fd00::5"] })
    expect(looked).toEqual([])
    // Still no ssh.
    await expect(
      resolvePlainGitRemote("ssh://git@git.internal/team/app.git", internal),
    ).rejects.toMatchObject({ rule: "not_https" })
    const config = (env: NodeJS.ProcessEnv) =>
      Object.fromEntries(
        Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [
          env[`GIT_CONFIG_KEY_${i}`],
          env[`GIT_CONFIG_VALUE_${i}`],
        ]),
      )
    const http = config(
      plainGitRemoteEnvironment("http://git.internal:3000/team/app.git"),
    )
    expect(http).toMatchObject({
      "credential.helper": "",
      "http.followRedirects": "false",
      "protocol.allow": "never",
      "protocol.http.allow": "always",
    })
    // An https source gets no http.
    expect(
      config(plainGitRemoteEnvironment("https://git.internal/team/app.git")),
    ).not.toHaveProperty("protocol.http.allow")
  })

  it.each([
    "169.254.169.254",
    "169.254.170.2",
    "::ffff:169.254.169.254",
    "::169.254.169.254",
    "64:ff9b::a9fe:a9fe",
    "fd00:ec2::254",
    "fe80::1",
  ])(
    "docker: refuses a host that resolves to the cloud metadata address %s",
    async (address) => {
      vi.stubEnv("SANDBOX_PROVIDER", "docker")
      await expect(
        resolvePlainGitRemote(
          "http://metadata.internal/team/app.git",
          async () => [{ address }],
        ),
      ).rejects.toMatchObject({ rule: "metadata_address" })
      // The same address as the host of the URL: no DNS lookup.
      const host = address.includes(":") ? `[${address}]` : address
      await expect(
        resolvePlainGitRemote(
          `http://${host}/latest/meta-data.git`,
          async () => [],
        ),
      ).rejects.toMatchObject({ rule: "metadata_address" })
    },
  )

  it("keeps only a short list of the backend variables in the git environment, with the proxy, and adds a low-speed limit", () => {
    vi.stubEnv("CTXPIPE_TEST_SECRET", "not-for-git")
    vi.stubEnv("HTTPS_PROXY", "http://proxy.internal:3128")
    vi.stubEnv("NO_PROXY", "git.internal")
    vi.stubEnv("GIT_SSL_NO_VERIFY", "1")
    vi.stubEnv("GIT_CONFIG_PARAMETERS", "'http.extraHeader'='X: leaked'")
    vi.stubEnv("GIT_DIR", "/tmp/elsewhere")
    const env = plainGitRemoteEnvironment(
      "https://git.example.org/team/app.git",
    )
    expect(env).toMatchObject({
      PATH: process.env.PATH,
      HTTPS_PROXY: "http://proxy.internal:3128",
      NO_PROXY: "git.internal",
    })
    for (const name of [
      "CTXPIPE_TEST_SECRET",
      "GIT_SSL_NO_VERIFY",
      "GIT_CONFIG_PARAMETERS",
      "GIT_DIR",
      "AUTH_SECRET",
      "DATABASE_URL",
    ])
      expect(env, name).not.toHaveProperty(name)
    expect(
      Object.fromEntries(
        Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [
          env[`GIT_CONFIG_KEY_${i}`],
          env[`GIT_CONFIG_VALUE_${i}`],
        ]),
      ),
    ).toMatchObject({
      "http.lowSpeedLimit": "1024",
      "http.lowSpeedTime": "60",
      "http.followRedirects": "false",
      "protocol.allow": "never",
    })
  })

  it.each([
    ["vercel", "vercel"],
    ["unset", undefined],
  ])(
    "%s: refuses a private host and http, and never allows http in git",
    async (_mode, value) => {
      vi.stubEnv("SANDBOX_PROVIDER", value)
      await expect(
        resolvePlainGitRemote("https://git.internal/team/app.git", internal),
      ).rejects.toMatchObject({ rule: "private_host" })
      await expect(
        resolvePlainGitRemote("http://git.example.org/team/app.git", lookup),
      ).rejects.toMatchObject({ rule: "not_https" })
      await expect(
        resolvePlainGitRemote(
          "https://private.example.org/team/app.git",
          lookup,
        ),
      ).rejects.toMatchObject({ rule: "private_address" })
      const env = plainGitRemoteEnvironment(
        "http://git.example.org/team/app.git",
      )
      expect(
        Array.from(
          { length: Number(env.GIT_CONFIG_COUNT) },
          (_, i) => env[`GIT_CONFIG_KEY_${i}`],
        ),
      ).not.toContain("protocol.http.allow")
    },
  )

  it("docker: the hosted policy, as the hosted egress proxy gives it, stays strict", async () => {
    vi.stubEnv("SANDBOX_PROVIDER", "docker")
    await expect(
      resolvePlainGitRemote(
        "https://private.example.org/team/app.git",
        lookup,
        plainGitUrlPolicy("hosted"),
      ),
    ).rejects.toMatchObject({ rule: "private_address" })
  })
})

describe("a self-host plain git read over http with real git", () => {
  let server: Server
  const requests: Array<{ url: string; authorization: string | null }> = []
  let port: number

  beforeAll(async () => {
    server = createServer((request, response) => {
      requests.push({
        url: request.url ?? "",
        authorization: request.headers.authorization ?? null,
      })
      response.writeHead(302, { location: "http://elsewhere.internal/x.git" })
      response.end()
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    port = (server.address() as AddressInfo).port
  })

  beforeEach(() => {
    vi.stubEnv("SANDBOX_PROVIDER", "docker")
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve))
  })

  it("connects over http to the private host on its port, with no credential and no redirect", async () => {
    await expect(
      resolvePlainGitTip(`http://127.0.0.1:${port}/team/app.git`),
    ).rejects.toThrow(/returned error: 302/)
    expect(requests).toEqual([
      {
        url: "/team/app.git/info/refs?service=git-upload-pack",
        authorization: null,
      },
    ])
  })

  it("does not connect in hosted mode", async () => {
    vi.stubEnv("SANDBOX_PROVIDER", "vercel")
    const before = requests.length
    await expect(
      resolvePlainGitTip(`http://127.0.0.1:${port}/team/app.git`),
    ).rejects.toMatchObject({ rule: "not_https" })
    expect(requests.length).toBe(before)
  })
})

describe("a plain git read and the .netrc file of the backend user", () => {
  let server: Server
  let home: string
  const authorizations: Array<string | null> = []

  beforeAll(async () => {
    // The host asks for Basic auth. Git (curl) sends a .netrc credential
    // only after this challenge.
    server = createServer((request, response) => {
      authorizations.push(request.headers.authorization ?? null)
      response.writeHead(401, { "www-authenticate": 'Basic realm="git"' })
      response.end()
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    // The home folder of the backend user has a .netrc entry for the host.
    home = await mkdtemp(join(tmpdir(), "plain-git-home-"))
    await writeFile(
      join(home, ".netrc"),
      "machine 127.0.0.1 login backend password netrc-secret\n",
    )
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve))
    await rm(home, { recursive: true, force: true })
  })

  it("sends no .netrc credential: git gets an empty home folder", async () => {
    vi.stubEnv("SANDBOX_PROVIDER", "docker")
    vi.stubEnv("HOME", home)
    const { port } = server.address() as AddressInfo
    await expect(
      resolvePlainGitTip(`http://127.0.0.1:${port}/team/app.git`),
    ).rejects.toThrow()
    expect(authorizations.length).toBeGreaterThan(0)
    expect(authorizations).toEqual(authorizations.map(() => null))
  })
})

describe("a plain git read with real git", () => {
  let server: Server
  let folder: string
  let restore: () => void
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
    // The environment of the test: DNS answers, and `git.example.org` is
    // this local server (git config of the read, not a global config).
    restore = usePlainGitNetwork({
      lookup,
      gitConfig: [
        [`url.http://127.0.0.1:${port}/.insteadOf`, "https://git.example.org/"],
        ["protocol.http.allow", "always"],
      ],
    })
    // A global config with a credential for each host: a plain git read
    // must not use it.
    folder = await mkdtemp(join(tmpdir(), "plain-git-remote-"))
    const config = join(folder, "gitconfig")
    await writeFile(
      config,
      "[http]\n\textraHeader = Authorization: Bearer leaked-token\n",
    )
    vi.stubEnv("GIT_CONFIG_GLOBAL", config)
  })

  afterAll(async () => {
    restore()
    vi.unstubAllEnvs()
    await new Promise((resolve) => server.close(resolve))
    await rm(folder, { recursive: true, force: true })
  })

  it("follows no redirect, and sends no credential, also one of the global git config", async () => {
    const remote = await plainGitRemote("https://git.example.org/team/app.git")
    expect(remote.env).toMatchObject({
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "",
      GIT_CONFIG_NOSYSTEM: "1",
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

  it("uses the proxy of the backend environment, except for a NO_PROXY host", async () => {
    const proxied: string[] = []
    const proxy = createServer((request, response) => {
      proxied.push(request.url ?? "")
      response.writeHead(502)
      response.end()
    })
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve))
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`
    const { port } = server.address() as AddressInfo
    vi.stubEnv("http_proxy", proxyUrl)
    vi.stubEnv("NO_PROXY", "")
    const before = requests.length
    try {
      await expect(
        resolvePlainGitTip("https://git.example.org/team/app.git"),
      ).rejects.toThrow(/returned error: 502/)
      expect(proxied).toEqual([
        `http://127.0.0.1:${port}/team/app.git/info/refs?service=git-upload-pack`,
      ])
      expect(requests.length).toBe(before)
      // A NO_PROXY host: git connects to the host. It answers 302, which
      // git does not follow.
      vi.stubEnv("NO_PROXY", "127.0.0.1")
      await expect(
        resolvePlainGitTip("https://git.example.org/team/app.git"),
      ).rejects.toThrow(/returned error: 302/)
    } finally {
      vi.stubEnv("http_proxy", "")
      vi.stubEnv("NO_PROXY", "")
      await new Promise((resolve) => proxy.close(resolve))
    }
    expect(proxied.length).toBe(1)
    expect(requests.slice(before).map((request) => request.url)).toEqual([
      "/team/app.git/info/refs?service=git-upload-pack",
    ])
  })

  it("does not read a host that the git config of the read does not allow: no ssh, git:// or file://", async () => {
    const remote = await plainGitRemote("https://git.example.org/team/app.git")
    for (const url of [
      `file://${folder}`,
      "git://127.0.0.1:1/team/app.git",
      "ssh://git@127.0.0.1:1/team/app.git",
    ]) {
      const result = await exec("git", ["ls-remote", "--", url], {
        env: { ...process.env, ...remote.env },
        timeout: 30_000,
      }).then(
        () => "",
        (error: { stderr?: string }) => error.stderr ?? "",
      )
      expect(result, url).toMatch(/transport '(file|git|ssh)' not allowed/)
    }
  })
})

describe("a plain git read of an https host", () => {
  let server: HttpsServer
  let folder: string
  let port: number
  const requests: string[] = []

  beforeAll(async () => {
    folder = await mkdtemp(join(tmpdir(), "plain-git-tls-"))
    const file = (name: string) => join(folder, name)
    const openssl = (...args: string[]) =>
      exec("openssl", args, { timeout: 20_000 })
    await openssl(
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=git.example.test",
      "-addext",
      "subjectAltName=DNS:git.example.test",
      "-keyout",
      file("key"),
      "-out",
      file("crt"),
    )
    server = createHttpsServer(
      { key: await readFile(file("key")), cert: await readFile(file("crt")) },
      (request, response) => {
        requests.push(request.url ?? "")
        response.writeHead(404)
        response.end()
      },
    )
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    port = (server.address() as AddressInfo).port
  })

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve))
    await rm(folder, { recursive: true, force: true })
  })

  it("makes git check the certificate of the host, also when the backend environment sets GIT_SSL_NO_VERIFY", async () => {
    // `git.example.org` is this server, whose certificate git does not trust.
    const restore = usePlainGitNetwork({
      lookup: async () => [{ address: "93.184.215.14" }],
      gitConfig: [
        [
          `url.https://127.0.0.1:${port}/.insteadOf`,
          "https://git.example.org/",
        ],
      ],
    })
    vi.stubEnv("GIT_SSL_NO_VERIFY", "1")
    const before = requests.length
    try {
      await expect(
        resolvePlainGitTip("https://git.example.org/team/app.git"),
      ).rejects.toThrow(
        /SSL certificate problem|server certificate verification failed|certificate verify failed/,
      )
    } finally {
      vi.unstubAllEnvs()
      restore()
    }
    expect(requests.length).toBe(before)
  })
})
