import { describe, expect, it } from "vitest"
import { withAgentVault } from "../../test/agent-vault-fixture.js"
import {
  AgentVaultUnavailableError,
  openRunVault,
  SANDBOX_CREDENTIAL_PLACEHOLDER,
  sweepRunVaults,
  writeProxyCaCommand,
} from "./agent-vault.js"
import { workspaceChatDockerImage } from "./chat-runtime.js"

const image = workspaceChatDockerImage()

describe("Agent Vault adds sandbox credentials in flight", () => {
  it(
    "keeps every credential out of the sandbox while Git and HTTP calls get them",
    { timeout: 240_000 },
    async () => {
      await withAgentVault({ image }, async (fixture) => {
        const modelToken = "model-capability-secret"
        const vault = await openRunVault({
          access: fixture.access,
          runKey: `test:${crypto.randomUUID()}`,
          ttlSeconds: 600,
          rules: [
            {
              name: "model-proxy",
              host: `${fixture.upstream}:8080/echo/model/*`,
              bearer: modelToken,
            },
            {
              name: "git",
              host: `${fixture.upstream}:8080/git/*`,
              basic: { username: "x-access-token", password: fixture.gitToken },
            },
          ],
        })
        try {
          const base = `http://${fixture.upstream}:8080`
          const result = await fixture.sandbox(
            vault.env,
            `set -e
${writeProxyCaCommand(vault.caPem)}
echo "== curl"
curl -sS -H "Authorization: Bearer ${SANDBOX_CREDENTIAL_PLACEHOLDER}" ${base}/echo/model/v1/chat
echo
echo "== node"
node --no-warnings -e 'fetch("https://example.com/").then(r => console.log(r.status))'
echo "== other path"
curl -sS -H "Authorization: Bearer ${SANDBOX_CREDENTIAL_PLACEHOLDER}" ${base}/echo/other
echo
echo "== git"
git clone -q ${base}/git/repo.git /tmp/clone
cd /tmp/clone
git -c user.name=t -c user.email=t@t commit -q --allow-empty -m change
git push -q origin HEAD:refs/heads/ctxpipe/chat/test
git fetch -q origin
git ls-remote origin
echo "== https"
curl -sS -o /dev/null -w "%{http_code}\\n" https://example.com/
echo "== leak"
cat /proc/*/environ 2>/dev/null | tr '\\0' '\\n' > /tmp/environ
env >> /tmp/environ
cat /tmp/clone/.git/config >> /tmp/environ
git config --list --show-origin >> /tmp/environ 2>/dev/null || true
grep -c -e "${modelToken}" -e "${fixture.gitToken}" /tmp/environ || true
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
          // Node trusts the proxy CA (TLS through the proxy).
          expect(sections.node).toBe("200")
          // A path no rule covers keeps the sandbox's own header.
          const other = JSON.parse(sections["other path"] ?? "{}")
          expect(other.headers.authorization).toBe(
            `Bearer ${SANDBOX_CREDENTIAL_PLACEHOLDER}`,
          )
          expect(sections.git).toContain("refs/heads/ctxpipe/chat/test")
          expect(sections.https).toBe("200")
          expect(sections.leak).toBe("0")
        } finally {
          await vault.close()
        }
        // The session ends with the run's vault.
        const after = await fixture.sandbox(
          vault.env,
          `${writeProxyCaCommand(vault.caPem)}
curl -sS -o /dev/null -w "%{http_code}" http://${fixture.upstream}:8080/echo/model/x`,
        )
        expect(after.stdout).not.toBe("200")
      })
    },
  )

  it(
    "sweeps run vaults a turn end left, and fails closed when Agent Vault is down",
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
