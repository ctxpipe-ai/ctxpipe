import { setTimeout as delay } from "node:timers/promises"

import { expect, it } from "vitest"

import { withAgentVault } from "../../test/agent-vault-fixture.js"
import { openRunVault, writeProxyCaCommand } from "./agent-vault.js"
import { workspaceChatDockerImage } from "./chat-runtime.js"
import { ingestCredentialRules } from "./ingest-sandbox-egress.js"

/*
 * A shard sandbox gets one proxy session when it is made, and nothing
 * renews the session. A step on the sandbox after the session ends cannot
 * fetch: each CONNECT gets 407, and Git exits with code 128 before the proxy
 * forwards a request. This is the root command failure of CTX-1515. So no
 * step may start on a sandbox at the shard limit
 * (`ingestSandbox().ensureExisting()`). Agent Vault refuses a session TTL
 * below 300 seconds, so this file runs for more than 5 minutes.
 */

it(
  "refuses each Git fetch of a sandbox after its proxy session ends, and Git exits with code 128 (CTX-1515)",
  { timeout: 480_000 },
  async () => {
    await withAgentVault(
      { image: workspaceChatDockerImage(), closed: true },
      async (fixture) => {
        const { upstream } = fixture
        const ttlSeconds = 300
        const vault = await openRunVault({
          access: fixture.access,
          runKey: `test:${crypto.randomUUID()}`,
          ttlSeconds,
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
          const fetch = `git ls-remote https://${upstream}/public/repo.git refs/heads/main`
          // One container for the whole test, as a shard keeps its sandbox.
          const box = await fixture.startSandbox(vault.env)
          try {
            const live = await box.process.exec(
              `${writeProxyCaCommand(vault.caPem)}\n${fetch}`,
            )
            expect(live.exitCode, live.stderr).toBe(0)

            await delay((ttlSeconds + 3) * 1000)

            const ended = await box.process.exec(fetch)
            expect(ended.exitCode, ended.stderr).toBe(128)
            expect(ended.stderr).toContain("407")
          } finally {
            await box.remove()
          }
        } finally {
          await vault.close()
        }
      },
    )
  },
)
