import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { parseEnv } from "../../config/env.js"
import { closeDb, getSystemDb, initDb } from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import { generateObjectId } from "../../lib/id.js"
import { sandboxGitTokenStore } from "../../models/sandbox-git-tokens.js"
import { withAgentVault } from "../../test/agent-vault-fixture.js"
import { setRunVaultRules } from "./agent-vault.js"
import { ingestSandboxThreadId } from "./chat-lifecycle.js"
import { workspaceChatDockerImage } from "./chat-runtime.js"
import {
  dockerIngestSandboxProvider,
  type IngestEgress,
  ingestCredentialRules,
  refreshIngestSandboxEgress,
} from "./ingest-sandbox-egress.js"

const exec = promisify(execFile)
const image = workspaceChatDockerImage()
const orgId = generateObjectId("org")

beforeAll(async () => {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error("DATABASE_URL is required for ingest tokens")
  initDb(url)
  await getSystemDb().insert(organizations).values({
    id: orgId,
    slug: orgId,
    name: "Ingest egress proof",
    createdAt: new Date(),
  })
})

afterAll(async () => {
  const store = sandboxGitTokenStore(orgId, parseEnv(process.env))
  for (const row of await store.list("ingest:")) await store.take(row.key)
  await getSystemDb().delete(organizations).where(eq(organizations.id, orgId))
  await closeDb()
})

/** The sections of a script's output, split at `== <name>` lines. */
function sections(stdout: string): Record<string, string> {
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

async function run(container: string, script: string): Promise<string> {
  const { stdout } = await exec(
    "docker",
    ["exec", container, "sh", "-c", script],
    {
      timeout: 120_000,
    },
  )
  return stdout
}

const code = (args: string) =>
  `curl -sS -m 20 -o /dev/null -w "%{http_code}" ${args} 2>/dev/null || true`

describe("the Docker ingest sandbox has closed egress", () => {
  it(
    "reaches only the model proxy, the tool bridge and Git fetch; destroy deletes the vault and revokes the token",
    { timeout: 300_000 },
    async () => {
      // The sandbox network is internal and reaches only the proxy port, as
      // the DinD and AWS hosts force with iptables.
      await withAgentVault({ image, closed: true }, async (fixture) => {
        const base = `http://${fixture.upstream}:8080`
        const runId = `run_${crypto.randomUUID()}`
        const revoked: string[] = []
        let minted = 0
        const egress = (step: number): IngestEgress => ({
          repositories: ["git/repo"],
          gitHost: `${fixture.upstream}:8080`,
          modelProxyUrl: `${base}/echo/model/v1`,
          capability: `ingest-capability-${step}`,
          bridge: { url: `${base}/echo/bridge`, token: `bridge-${step}` },
        })
        const shard = {
          orgId,
          runId,
          shard: 0,
          githubConnectionId: null,
          access: fixture.access,
          mintGitToken: async (repositories: string[]) => {
            expect(repositories).toEqual(["git/repo"])
            minted += 1
            return fixture.gitToken
          },
          revokeGitToken: async (token: string) => {
            revoked.push(token)
          },
        }
        const provider = dockerIngestSandboxProvider({
          ...shard,
          image,
          egress: async () => egress(1),
        })
        const handle = await provider.create({})
        let destroyed = false
        try {
          // The host network policy of DinD and AWS: only the internal network.
          await exec("docker", ["network", "disconnect", "bridge", handle.id])
          await exec("docker", [
            "network",
            "connect",
            fixture.sandboxNetwork,
            handle.id,
          ])
          const output = await run(
            handle.id,
            `echo "== model"
curl -sS -m 20 -X POST ${base}/echo/model/v1/chat/completions
echo
echo "== models"
curl -sS -m 20 ${base}/echo/model/v1/models
echo
echo "== bridge"
curl -sS -m 20 ${base}/echo/bridge
echo
echo "== fetch"
git clone -q ${base}/git/repo.git /tmp/clone 2>&1 && git -C /tmp/clone fetch -q origin 2>&1 && git -C /tmp/clone log --format=%s
echo "== push"
cd /tmp/clone && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m change
git push origin HEAD:refs/ctxpipe/ingest/${runId}/ws 2>&1 && echo PUSHED || echo REFUSED
echo "== github-push"
git push https://github.com/octocat/hello-world.git HEAD:refs/heads/x 2>&1 && echo PUSHED || echo REFUSED
cd /
echo "== github-receive-pack"
${code("-X POST https://github.com/octocat/hello-world.git/git-receive-pack")}
echo
echo "== github-api"
${code("https://api.github.com/user")}
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
echo "== direct"
${code("--noproxy '*' https://example.com/")}
echo
`,
          )
          const result = sections(output)
          expect(
            JSON.parse(result.model ?? "{}").headers?.authorization,
            output,
          ).toBe("Bearer ingest-capability-1")
          expect(
            JSON.parse(result.models ?? "{}").headers?.authorization,
            output,
          ).toBe("Bearer ingest-capability-1")
          expect(
            JSON.parse(result.bridge ?? "{}").headers?.authorization,
            output,
          ).toBe("Bearer bridge-1")
          expect(result.fetch, output).toBe("seed")
          // The vault refuses the push; the Git server would take it.
          expect(result.push, output).toContain("403")
          expect(result.push, output).toContain("REFUSED")
          expect(result["github-push"], output).toContain("REFUSED")
          for (const name of [
            "github-receive-pack",
            "github-api",
            "example",
            "example-http",
            "other-path",
          ])
            expect(result[name], `${name}\n${output}`).toBe("403")
          expect(result.direct, output).toBe("000")
          // No credential is in the sandbox's environment.
          const environ = await run(handle.id, "env")
          expect(environ).not.toContain(fixture.gitToken)
          expect(environ).not.toContain("ingest-capability-1")
          expect(environ).not.toContain("bridge-1")

          // The next step gets its own capability; the first one is gone.
          await refreshIngestSandboxEgress({ ...shard, egress: egress(2) })
          const next = await run(
            handle.id,
            `curl -sS -m 20 -X POST ${base}/echo/model/v1/chat/completions`,
          )
          expect(JSON.parse(next).headers?.authorization).toBe(
            "Bearer ingest-capability-2",
          )
          // One token per 50-minute window: the refresh reused it.
          expect(minted).toBe(1)

          await provider.destroy({ id: handle.id })
          destroyed = true
          await expect(
            exec("docker", ["inspect", handle.id]),
          ).rejects.toBeTruthy()
          expect(revoked).toEqual([fixture.gitToken])
          const store = sandboxGitTokenStore(orgId, parseEnv(process.env))
          expect(
            await store.list(`${ingestSandboxThreadId(runId, 0)}:`),
          ).toEqual([])
          // The vault is gone: a later step cannot set rules on it.
          await expect(
            setRunVaultRules(
              fixture.access,
              ingestSandboxThreadId(runId, 0),
              ingestCredentialRules(egress(3), undefined),
            ),
          ).rejects.toBeTruthy()
        } finally {
          if (!destroyed)
            await provider.destroy({ id: handle.id }).catch(() => undefined)
        }
      })
    },
  )

  it(
    "fails closed: no Agent Vault means no sandbox, and a failed create revokes the token",
    { timeout: 120_000 },
    async () => {
      const provider = dockerIngestSandboxProvider({
        orgId,
        runId: `run_${crypto.randomUUID()}`,
        shard: 0,
        githubConnectionId: null,
        image,
        egress: async () => {
          throw new Error("not reached")
        },
        access: undefined,
      })
      vi.stubEnv("AGENT_VAULT_ADDR", "")
      try {
        await expect(provider.create({})).rejects.toThrow("Agent Vault")
      } finally {
        vi.unstubAllEnvs()
      }

      await withAgentVault({ image }, async (fixture) => {
        const runId = `run_${crypto.randomUUID()}`
        const revoked: string[] = []
        const failing = dockerIngestSandboxProvider({
          orgId,
          runId,
          shard: 1,
          githubConnectionId: null,
          // An image that does not exist: the container start fails.
          image: "ctxpipe-test/no-such-image:missing",
          access: fixture.access,
          egress: async () => ({
            repositories: ["git/repo"],
            gitHost: `${fixture.upstream}:8080`,
            modelProxyUrl: `http://${fixture.upstream}:8080/echo/model/v1`,
            capability: "ingest-capability",
            bridge: {
              url: `http://${fixture.upstream}:8080/echo/bridge`,
              token: "bridge",
            },
          }),
          mintGitToken: async () => "ghs_minted_for_a_failed_create",
          revokeGitToken: async (token) => {
            revoked.push(token)
          },
        })
        await expect(failing.create({})).rejects.toBeTruthy()
        expect(revoked).toEqual(["ghs_minted_for_a_failed_create"])
        await expect(
          setRunVaultRules(
            fixture.access,
            ingestSandboxThreadId(runId, 1),
            ingestCredentialRules(
              {
                repositories: [],
                modelProxyUrl: "http://x.test/v1",
                capability: "c",
                bridge: { url: "http://x.test/b", token: "t" },
              },
              undefined,
            ),
          ),
        ).rejects.toBeTruthy()
      })
    },
  )
})
