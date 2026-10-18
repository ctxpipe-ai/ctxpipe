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
  isPublicAddress,
  PlainGitUrlError,
  plainGitPinnedRequest,
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
      "not-an-address",
    ])
      expect(isPublicAddress(address), address).toBe(false)
  })
})

describe("the plain git policy of the deployment mode (SANDBOX_PROVIDER)", () => {
  const internal = async (host: string) =>
    host === "git.internal" ? [{ address: "10.1.2.3" }] : lookup(host)
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("docker: reads a private host, an IP host, http, and another port, and pins the checked address", async () => {
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
      plainGitRemoteEnvironment({
        url: "http://git.internal:3000/team/app.git",
        host: "git.internal",
        port: 3000,
        addresses: ["10.1.2.3"],
      }),
    )
    expect(http).toMatchObject({
      "credential.helper": "",
      "http.followRedirects": "false",
      "protocol.allow": "never",
      "protocol.http.allow": "always",
      "http.curloptResolve": "git.internal:3000:10.1.2.3",
    })
    // An https source gets no http.
    expect(
      config(
        plainGitRemoteEnvironment({
          url: "https://git.internal/team/app.git",
          host: "git.internal",
          port: 443,
          addresses: ["10.1.2.3"],
        }),
      ),
    ).not.toHaveProperty("protocol.http.allow")
  })

  it.each([
    ["vercel", "vercel"],
    ["unset", undefined],
  ])("%s: refuses a private host and http, and never allows http in git", async (_mode, value) => {
    vi.stubEnv("SANDBOX_PROVIDER", value)
    await expect(
      resolvePlainGitRemote("https://git.internal/team/app.git", internal),
    ).rejects.toMatchObject({ rule: "private_host" })
    await expect(
      resolvePlainGitRemote("http://git.example.org/team/app.git", lookup),
    ).rejects.toMatchObject({ rule: "not_https" })
    await expect(
      resolvePlainGitRemote("https://private.example.org/team/app.git", lookup),
    ).rejects.toMatchObject({ rule: "private_address" })
    const env = plainGitRemoteEnvironment({
      url: "http://git.example.org/team/app.git",
      host: "git.example.org",
      port: 80,
      addresses: ["93.184.215.14"],
    })
    expect(
      Array.from(
        { length: Number(env.GIT_CONFIG_COUNT) },
        (_, i) => env[`GIT_CONFIG_KEY_${i}`],
      ),
    ).not.toContain("protocol.http.allow")
  })

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
  let restore: () => void
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
    // `git.internal` resolves to the loopback address only in the DNS of
    // the test: git reaches the server only through the pinned address.
    restore = usePlainGitNetwork({
      lookup: async (host) =>
        host === "git.internal" ? [{ address: "127.0.0.1" }] : [],
    })
  })

  beforeEach(() => {
    vi.stubEnv("SANDBOX_PROVIDER", "docker")
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  afterAll(async () => {
    restore()
    await new Promise((resolve) => server.close(resolve))
  })

  it("connects over http to the internal host on its port, at the checked address, with no credential and no redirect", async () => {
    await expect(
      resolvePlainGitTip(`http://git.internal:${port}/team/app.git`),
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
      resolvePlainGitTip(`http://git.internal:${port}/team/app.git`),
    ).rejects.toMatchObject({ rule: "not_https" })
    expect(requests.length).toBe(before)
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

  it("connects to the host, not to a proxy of the backend environment", async () => {
    const proxied: string[] = []
    const proxy = createServer((request, response) => {
      proxied.push(request.url ?? "")
      response.writeHead(502)
      response.end()
    })
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve))
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`
    for (const name of ["http_proxy", "https_proxy", "all_proxy"]) {
      vi.stubEnv(name, proxyUrl)
      vi.stubEnv(name.toUpperCase(), proxyUrl)
    }
    vi.stubEnv("no_proxy", "")
    vi.stubEnv("NO_PROXY", "")
    const before = requests.length
    try {
      // The host answers 302, which git does not follow.
      await expect(
        resolvePlainGitTip("https://git.example.org/team/app.git"),
      ).rejects.toThrow(/returned error: 302/)
    } finally {
      for (const name of ["http_proxy", "https_proxy", "all_proxy", "no_proxy"])
        for (const each of [name, name.toUpperCase()]) vi.stubEnv(each, "")
      await new Promise((resolve) => proxy.close(resolve))
    }
    expect(proxied).toEqual([])
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

describe("plainGitPinnedRequest", () => {
  let server: HttpsServer
  let folder: string
  let ca: string
  let port: number
  const requests: Array<{ url: string; host: string | undefined }> = []

  beforeAll(async () => {
    folder = await mkdtemp(join(tmpdir(), "plain-git-pin-"))
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
      "/CN=pinned.example.test",
      "-addext",
      "subjectAltName=DNS:pinned.example.test",
      "-keyout",
      file("key"),
      "-out",
      file("crt"),
    )
    ca = await readFile(file("crt"), "utf8")
    // The repository path redirects to a private address.
    server = createHttpsServer(
      { key: await readFile(file("key")), cert: ca },
      (request, response) => {
        requests.push({ url: request.url ?? "", host: request.headers.host })
        response.writeHead(302, {
          location: "https://169.254.169.254/latest/meta-data",
        })
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

  it("connects only to the checked address, with no DNS lookup, and passes a redirect back without following it", async () => {
    // `.test` names have no DNS answer: only the pin reaches the server.
    const response = await plainGitPinnedRequest({
      url: new URL(
        "https://pinned.example.test/team/app.git/info/refs?service=git-upload-pack",
      ),
      method: "GET",
      headers: new Headers({ "git-protocol": "version=2" }),
      body: null,
      addresses: ["127.0.0.1"],
      ca,
      port,
    })
    expect(response.status).toBe(302)
    expect(response.headers.get("location")).toBe(
      "https://169.254.169.254/latest/meta-data",
    )
    expect(requests).toEqual([
      {
        url: "/team/app.git/info/refs?service=git-upload-pack",
        host: `pinned.example.test:${port}`,
      },
    ])
  })

  it("refuses a server whose certificate is not for the host name", async () => {
    await expect(
      plainGitPinnedRequest({
        url: new URL("https://other.example.test/team/app.git/info/refs"),
        method: "GET",
        headers: new Headers(),
        body: null,
        addresses: ["127.0.0.1"],
        ca,
        port,
      }),
    ).rejects.toThrow(
      "Hostname/IP does not match certificate's altnames: Host: other.example.test. is not in the cert's altnames: DNS:pinned.example.test",
    )
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
