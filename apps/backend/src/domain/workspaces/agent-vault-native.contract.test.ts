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
  type SandboxCredentialRule,
} from "./sandbox-credential-rules.js"
import { WORKSPACE_CHAT_FIREWALL_PLACEHOLDER as PLACEHOLDER } from "./workspace-chat-opencode-contract.js"

const image = workspaceChatDockerImage()

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
          const sections = Object.fromEntries(
            result.stdout
              .split("== ")
              .filter(Boolean)
              .map((section) => {
                const [name, ...rest] = section.split("\n")
                return [name, rest.join("\n").trim()]
              }),
          )
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
