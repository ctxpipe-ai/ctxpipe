import { describe, expect, it } from "vitest"

import { withAgentVault } from "../../test/agent-vault-fixture.js"
import { openRunVault, writeProxyCaCommand } from "./agent-vault.js"
import { workspaceChatDockerImage } from "./chat-runtime.js"
import { ingestCredentialRules } from "./ingest-sandbox-egress.js"

const image = workspaceChatDockerImage()

/**
 * Agent Vault with the limits that ctxpipe deploys
 * (`AGENT_VAULT_RATE_LIMIT_ENV`, packages/aws-cdk). With `closed`, each
 * sandbox reaches the proxy through one TCP forwarder, so Agent Vault sees one
 * peer address for all sandboxes, as behind the hosted load balancer.
 */
describe("Agent Vault's pre-auth gate, as ctxpipe deploys it", () => {
  it(
    "lets one sandbox fail proxy auth 60 times without a lockout of a neighbor at the same address (CTX-1472)",
    { timeout: 240_000 },
    async () => {
      await withAgentVault({ image, closed: true }, async (fixture) => {
        const { upstream } = fixture
        const vault = await openRunVault({
          access: fixture.access,
          runKey: `test:${crypto.randomUUID()}`,
          ttlSeconds: 600,
          rules: ingestCredentialRules(
            {
              repositories: [
                { kind: "git", host: upstream, path: "/public/repo.git" },
              ],
              modelProxyUrl: `http://${upstream}:8080/echo/model/v1`,
              capability: "model-capability",
              bridge: {
                url: `http://${upstream}:8080/echo/bridge`,
                token: "t",
              },
            },
            [],
            { fetchSource: true },
          ),
          unmatchedHosts: "deny",
        })
        try {
          // The proxy's address without credentials: `HTTPS_PROXY` is
          // http://<session>:<vault>@<host>:<port>.
          const proxy = '"${HTTPS_PROXY##*@}"'
          // The stock gate refuses each CONNECT from the address after 50
          // failures in 5 minutes (429).
          const hostile = await fixture.sandbox(
            vault.env,
            `for i in $(seq 1 60); do curl -s -o /dev/null --max-time 5 -p -x "http://wrong-session:${vault.name}@"${proxy} -w '%{http_connect}\\n' https://${upstream}/ || true; done`,
          )

          const neighbor = await fixture.sandbox(
            vault.env,
            `${writeProxyCaCommand(vault.caPem)}
echo "== unauthenticated"
curl -s -o /dev/null --max-time 5 -p -x "http://"${proxy} -w '%{http_connect}' https://${upstream}/ || true
echo
echo "== fetch"
git ls-remote https://${upstream}/public/repo.git refs/heads/main 2>&1
`,
          )
          const output = `${neighbor.stdout}\n${neighbor.stderr}`
          expect(neighbor.exitCode, output).toBe(0)
          // 407 asks the neighbor for proxy auth: the gate does not refuse it.
          expect(neighbor.stdout, output).toContain("== unauthenticated\n407\n")
          // The neighbor's own session goes through (CONNECT 200).
          expect(neighbor.stdout, output).toMatch(
            /== fetch\n[0-9a-f]{40}\trefs\/heads\/main/,
          )
          expect(hostile.stdout.trim().split("\n")).toEqual(
            Array.from({ length: 60 }, () => "407"),
          )
        } finally {
          await vault.close()
        }
      })
    },
  )
})
