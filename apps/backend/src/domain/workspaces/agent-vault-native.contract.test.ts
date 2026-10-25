import { describe, expect, it } from "vitest"

import { withAgentVault } from "../../test/agent-vault-fixture.js"
import {
  AgentVaultUnavailableError,
  openRunVault,
  sweepRunVaults,
  writeProxyCaCommand,
} from "./agent-vault.js"
import { workspaceChatDockerImage } from "./chat-runtime.js"
import {
  bearerUrlRule,
  githubFetchCredentialRules,
  type SandboxCredentialRule,
} from "./sandbox-credential-rules.js"
import { WORKSPACE_CHAT_FIREWALL_PLACEHOLDER as PLACEHOLDER } from "./workspace-chat-opencode-contract.js"

const image = workspaceChatDockerImage()

function sectionsOf(stdout: string): Record<string, string> {
  return Object.fromEntries(
    stdout
      .split("== ")
      .filter(Boolean)
      .map((section) => {
        const [name, ...rest] = section.split("\n")
        return [name, rest.join("\n").trim()]
      }),
  )
}

describe("Agent Vault adds sandbox credentials in flight", () => {
  it(
    "keeps every credential out of the sandbox while Git, HTTP and gh calls get them",
    { timeout: 240_000 },
    async () => {
      await withAgentVault({ image }, async (fixture) => {
        const modelToken = "model-capability-secret"
        const ghToken = "ghs_cli_secret"
        const upstream = fixture.upstream
        const basic = `Basic ${Buffer.from(`x-access-token:${fixture.gitToken}`).toString("base64")}`
        const rules: SandboxCredentialRule[] = [
          bearerUrlRule(
            "model-proxy-chat",
            `http://${upstream}:8080/echo/model/v1/chat/completions`,
            modelToken,
          ),
          // A Git host and a GitHub API host, as `githubCredentialRules`
          // writes them for github.com and api.github.com.
          {
            name: "git",
            host: `${upstream}:8080`,
            path: "/git/repo.git/info/refs",
            authorization: basic,
          },
          {
            name: "git-upload",
            host: `${upstream}:8080`,
            path: "/git/repo.git/git-upload-pack",
            authorization: basic,
          },
          {
            name: "git-receive",
            host: `${upstream}:8080`,
            path: "/git/repo.git/git-receive-pack",
            authorization: basic,
          },
          {
            name: "github-api",
            host: `${upstream}:443`,
            authorization: `Bearer ${ghToken}`,
          },
        ]
        const vault = await openRunVault({
          access: fixture.access,
          runKey: `test:${crypto.randomUUID()}`,
          ttlSeconds: 600,
          rules,
        })
        try {
          const base = `http://${upstream}:8080`
          const result = await fixture.sandbox(
            { ...vault.env, GH_ENTERPRISE_TOKEN: PLACEHOLDER },
            `set -e
${writeProxyCaCommand(vault.caPem)}
echo "== curl"
curl -sS -H "Authorization: Bearer ${PLACEHOLDER}" ${base}/echo/model/v1/chat/completions
echo
echo "== dotdot"
curl -sS --path-as-is -H "Authorization: Bearer ${PLACEHOLDER}" ${base}/echo/model/v1/chat/completions/../../other
echo
echo "== git"
git clone -q ${base}/git/repo.git /tmp/clone
cd /tmp/clone
git -c user.name=t -c user.email=t@t commit -q --allow-empty -m change
git push -q origin HEAD:refs/heads/ctxpipe/chat/test
git fetch -q origin
git ls-remote origin
echo "== gh"
GH_HOST=${upstream} gh api /user
echo
echo "== node"
node --no-warnings -e 'fetch("https://${upstream}/node").then(r => console.log(r.status))'
echo "== manage"
curl -sS -o /dev/null -w "%{http_code}" http://${fixture.agentVaultName}:14321/health || true
echo
curl -sS -o /dev/null -w "%{http_code}" http://127.0.0.1:14321/health || true
echo
echo "== leak"
cat /proc/*/environ 2>/dev/null | tr '\\0' '\\n' > /tmp/environ
env >> /tmp/environ
cat /tmp/clone/.git/config >> /tmp/environ
git config --list --show-origin >> /tmp/environ 2>/dev/null || true
grep -c -e "${modelToken}" -e "${fixture.gitToken}" -e "${ghToken}" /tmp/environ || true
`,
          )
          expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0)
          const sections = sectionsOf(result.stdout)
          const curl = JSON.parse(sections.curl ?? "{}")
          expect(curl.headers.authorization).toBe(`Bearer ${modelToken}`)
          // An exact rule: a `..` path keeps the sandbox's own header.
          const dotdot = JSON.parse(sections.dotdot ?? "{}")
          expect(dotdot.headers.authorization).toBe(`Bearer ${PLACEHOLDER}`)
          expect(sections.git).toContain("refs/heads/ctxpipe/chat/test")
          // gh sends `Authorization: token <placeholder>`; the proxy replaces it.
          const gh = JSON.parse(sections.gh ?? "{}")
          expect(gh.url).toBe("/api/v3/user")
          expect(gh.headers.authorization).toBe(`Bearer ${ghToken}`)
          // TLS through the proxy: Node trusts the proxy CA.
          expect(sections.node).toBe("200")
          // The proxy never reaches Agent Vault's own management API.
          expect(sections.manage?.split("\n")).not.toContain("200")
          expect(sections.leak).toBe("0")
        } finally {
          await vault.close()
        }
        // The session ends with the run's vault.
        const after = await fixture.sandbox(
          vault.env,
          `${writeProxyCaCommand(vault.caPem)}
curl -sS -o /dev/null -w "%{http_code}" http://${upstream}:8080/echo/model/x`,
        )
        expect(after.stdout).not.toBe("200")
      })
    },
  )

  it(
    "reaches a public site through the proxy",
    { timeout: 120_000 },
    async () => {
      // The one public host in these tests: it proves that hosts with no rule
      // are forwarded, so agents keep open internet access.
      await withAgentVault({ image }, async (fixture) => {
        const vault = await openRunVault({
          access: fixture.access,
          runKey: `test:${crypto.randomUUID()}`,
          ttlSeconds: 600,
          rules: [],
        })
        try {
          const result = await fixture.sandbox(
            vault.env,
            `${writeProxyCaCommand(vault.caPem)}
curl -sS -o /dev/null -w "%{http_code}" https://example.com/`,
          )
          expect(result.stdout).toBe("200")
        } finally {
          await vault.close()
        }
      })
    },
  )

  it(
    "a closed vault forwards only its rules: the model proxy, the tool bridge and Git fetch; pushes, other hosts and paths, and its own API fail",
    { timeout: 240_000 },
    async () => {
      // The sandbox network is internal and reaches only the proxy port, as
      // the DinD and AWS hosts force with iptables.
      await withAgentVault({ image, closed: true }, async (fixture) => {
        const upstream = fixture.upstream
        const base = `http://${upstream}:8080`
        const rules: SandboxCredentialRule[] = [
          bearerUrlRule(
            "model-proxy-chat",
            `${base}/echo/model/v1/chat/completions`,
            "model-capability",
          ),
          bearerUrlRule("tool-bridge", `${base}/echo/bridge`, "bridge-token"),
          // The test Git server takes pushes with this token: only the vault
          // can refuse them.
          ...githubFetchCredentialRules(
            fixture.gitToken,
            ["git/repo"],
            `${upstream}:8080`,
          ),
          // The real github.com, with a token GitHub refuses: GitHub (not
          // Agent Vault) answers a fetch.
          ...githubFetchCredentialRules("ghs_not_a_real_token", [
            "octocat/hello-world",
          ]),
        ]
        const vault = await openRunVault({
          access: fixture.access,
          runKey: `test:${crypto.randomUUID()}`,
          ttlSeconds: 600,
          rules,
          unmatchedHosts: "deny",
        })
        try {
          const proxy = new URL(vault.env.HTTPS_PROXY ?? "")
          const sessionTokens = [proxy.username, proxy.password]
            .map(decodeURIComponent)
            .filter(Boolean)
          expect(sessionTokens.length).toBeGreaterThan(0)
          const settings = `/v1/vaults/${vault.name}/settings`
          const code = (args: string) =>
            `curl -sS -m 20 -o /dev/null -w "%{http_code}" ${args} 2>/dev/null || true`
          const result = await fixture.sandbox(
            vault.env,
            `${writeProxyCaCommand(vault.caPem)}
echo "== model"
curl -sS -m 20 ${base}/echo/model/v1/chat/completions
echo
echo "== bridge"
curl -sS -m 20 ${base}/echo/bridge
echo
echo "== git"
git clone -q ${base}/git/repo.git /tmp/clone 2>&1 && git -C /tmp/clone log --format=%s
echo "== push"
cd /tmp/clone && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m change
git push origin HEAD:refs/ctxpipe/ingest/test 2>&1 && echo PUSHED || echo REFUSED
cd /
echo "== github-fetch"
# 502 means the vault could not reach github.com: an outside outage. Retry.
for attempt in 1 2 3 4; do
  c=$(${code("https://github.com/octocat/hello-world.git/info/refs?service=git-upload-pack")})
  [ "$c" != 502 ] && break
  sleep 5
done
printf %s "$c"
echo
echo "== github-push"
${code("-X POST https://github.com/octocat/hello-world.git/git-receive-pack")}
echo
echo "== github-api"
${code("https://api.github.com/user")}
echo
echo "== github-api-write"
${code("-X POST https://api.github.com/repos/octocat/hello-world/git/refs")}
echo
echo "== example"
${code("https://example.com/")}
echo
echo "== example-http"
${code("http://example.com/")}
echo
echo "== other-path"
${code(`${base}/echo/other`)}
echo
echo "== api-via-proxy"
${code(`-X PATCH http://${fixture.agentVaultName}:14321${settings}`)}
echo
echo "== api-direct"
${code(`--noproxy '*' -X PATCH http://${proxy.hostname}:14321${settings}`)}
echo
echo "== api-on-proxy-port"
${code(`-k --noproxy '*' -X PATCH -H "Authorization: Bearer ${sessionTokens[0]}" -d '{"unmatched_host_policy":"passthrough"}' https://${proxy.hostname}:${proxy.port}${settings}`)}
echo
echo "== direct"
${code("--noproxy '*' https://example.com/")}
echo
echo "== direct-ip"
${code("--noproxy '*' http://1.1.1.1/")}
`,
          )
          expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0)
          const sections = sectionsOf(result.stdout)
          const output = `${result.stdout}\n${result.stderr}`
          expect(
            JSON.parse(sections.model ?? "{}").headers?.authorization,
            output,
          ).toBe("Bearer model-capability")
          expect(
            JSON.parse(sections.bridge ?? "{}").headers?.authorization,
            output,
          ).toBe("Bearer bridge-token")
          expect(sections.git, output).toBe("seed")
          // The vault refuses the push; the Git server would take it.
          expect(sections.push, output).toContain("403")
          expect(sections.push, output).toContain("REFUSED")
          // GitHub refuses the fake token: proof that the request got there.
          expect(sections["github-fetch"], output).toBe("401")
          // Hosts and paths with no rule: Agent Vault refuses them.
          for (const name of [
            "github-push",
            "github-api",
            "github-api-write",
            "example",
            "example-http",
            "other-path",
            "api-via-proxy",
          ])
            expect(sections[name], `${name}\n${output}`).toBe("403")
          // The API port is not open to the sandbox, and the proxy port does
          // not serve the API.
          expect(sections["api-direct"], output).toBe("000")
          expect(sections["api-on-proxy-port"], output).not.toMatch(/^2/)
          // No way around the proxy: no route and no DNS.
          for (const name of ["direct", "direct-ip"])
            expect(sections[name], `${name}\n${output}`).toBe("000")

          // The session token cannot change its own vault, even where the
          // API is open (here, from the test host).
          for (const token of sessionTokens) {
            for (const [method, path, body] of [
              ["PATCH", settings, { unmatched_host_policy: "passthrough" }],
              ["PUT", `/v1/vaults/${vault.name}/services`, { services: [] }],
            ] as const) {
              const response = await fetch(`${fixture.access.address}${path}`, {
                method,
                headers: {
                  authorization: `Bearer ${token}`,
                  "content-type": "application/json",
                },
                body: JSON.stringify(body),
              })
              expect([401, 403], `${method} ${path}`).toContain(response.status)
            }
          }
          const still = await fixture.sandbox(
            vault.env,
            `${writeProxyCaCommand(vault.caPem)}
${code("https://example.com/")}`,
          )
          expect(still.stdout).toBe("403")
        } finally {
          await vault.close()
        }
      })
    },
  )

  it(
    "Node fetch reaches a plain-HTTP host with a rule through a closed vault; other hosts and paths stay closed",
    { timeout: 180_000 },
    async () => {
      // Node's fetch tunnels each URL through the proxy, and Agent Vault
      // closes a tunnel that carries plain HTTP. The model proxy and the tool
      // bridge are plain HTTP on Docker hosts. OpenCode (Bun) sends them in
      // absolute form; the image makes Node do the same for skill scripts.
      await withAgentVault({ image, closed: true }, async (fixture) => {
        const base = `http://${fixture.upstream}:8080`
        const vault = await openRunVault({
          access: fixture.access,
          runKey: `test:${crypto.randomUUID()}`,
          ttlSeconds: 600,
          rules: [
            bearerUrlRule("tool-bridge", `${base}/echo/bridge`, "bridge-token"),
          ],
          unmatchedHosts: "deny",
        })
        try {
          const fetchStatus = (url: string, body = false) =>
            `node -e 'fetch("${url}").then(async r => console.log(r.status${body ? ", await r.text()" : ""}), e => console.log("ERR", e.cause?.message ?? e.message))'`
          const result = await fixture.sandbox(
            vault.env,
            `${writeProxyCaCommand(vault.caPem)}
echo "== allowed"
${fetchStatus(`${base}/echo/bridge`, true)}
echo "== other-path"
${fetchStatus(`${base}/echo/other`)}
echo "== other-host"
${fetchStatus("http://example.com/")}
`,
          )
          const output = `${result.stdout}\n${result.stderr}`
          expect(result.exitCode, output).toBe(0)
          const sections = sectionsOf(result.stdout)
          const [status, ...body] = (sections.allowed ?? "").split(" ")
          expect(status, output).toBe("200")
          expect(
            JSON.parse(body.join(" ") || "{}").headers?.authorization,
            output,
          ).toBe("Bearer bridge-token")
          expect(
            JSON.parse(body.join(" ") || "{}").headers?.["proxy-authorization"],
            output,
          ).toBeUndefined()
          expect(sections["other-path"], output).toBe("403")
          expect(sections["other-host"], output).toBe("403")
        } finally {
          await vault.close()
        }
      })
    },
  )

  it(
    "sweeps run vaults a turn end left, and fails closed when Agent Vault is down or has another owner",
    { timeout: 180_000 },
    async () => {
      await withAgentVault({ image }, async (fixture) => {
        const vault = await openRunVault({
          access: fixture.access,
          runKey: `test:${crypto.randomUUID()}`,
          ttlSeconds: 600,
          rules: [],
        })
        expect(await sweepRunVaults(fixture.access, 60_000)).toBe(0)
        expect(await sweepRunVaults(fixture.access, 0)).toBe(1)
        const swept = await fixture.sandbox(
          vault.env,
          `${writeProxyCaCommand(vault.caPem)}
curl -sS -o /dev/null -w "%{http_code}" http://${fixture.upstream}:8080/echo/x`,
        )
        expect(swept.stdout).not.toBe("200")

        // The instance has an owner: a wrong password never registers.
        await expect(
          openRunVault({
            access: {
              ...fixture.access,
              // Another name for the same instance, so no cached login applies.
              address: fixture.access.address.replace("127.0.0.1", "localhost"),
              ownerPassword: async () => "not-the-owner-password",
            },
            runKey: `test:${crypto.randomUUID()}`,
            ttlSeconds: 600,
            rules: [],
          }),
        ).rejects.toThrow(/refused the backend's owner password/)

        await fixture.stopAgentVault()
        await expect(
          openRunVault({
            access: fixture.access,
            runKey: `test:${crypto.randomUUID()}`,
            ttlSeconds: 600,
            rules: [],
          }),
        ).rejects.toBeInstanceOf(AgentVaultUnavailableError)
      })
    },
  )
})
