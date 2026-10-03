import { generateKeyPairSync } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import { HttpResponse, http, passthrough } from "msw"
import { setupServer } from "msw/node"
import { OpenWorkflow } from "openworkflow"
import { BackendPostgres } from "openworkflow/postgres"
import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { withOrgDbContext } from "../../db/client.js"
import { connections } from "../../db/schema/connections.js"
import { repositories } from "../../db/schema/repositories.js"
import { workspaces } from "../../db/schema/workspaces.js"
import { getRepositoryForOrg } from "../../models/repositories.js"
import { withNativeIndexFixture } from "../../test/native-index-fixture.js"
import { enqueueRepositoryIngestionWorkflow } from "../enqueue-repository-ingestion.js"
import { repositoryIndex } from "./repository-index.js"
import { repositoryIngestion } from "./repository-ingestion.js"
import { repositoryIngestionOrchestrator } from "./repository-ingestion-orchestrator.js"
import { workspaceExtractIngest } from "./workspace-extract-ingest.js"

it(
  "publishes actual producer extraction through one typed Git write",
  { timeout: 90_000 },
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "ctxpipe-producer-contract-"),
    )
    const gitConfig = join(directory, "gitconfig")
    await writeFile(gitConfig, "")
    const env = {
      GIT_CONFIG_GLOBAL: gitConfig,
      GITHUB_APP_ID: "12345",
      GITHUB_PRIVATE_KEY: generateKeyPairSync("rsa", {
        modulusLength: 2048,
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
      }).privateKey,
      MODEL_PROVIDER: "openai-like",
      MODEL_PROVIDER_URL: "https://producer-model.test/v1",
      MODEL_PROVIDER_API_KEY: "fixture-only",
    }
    const saved = Object.fromEntries(
      Object.keys(env).map((key) => [key, process.env[key]]),
    )
    Object.assign(process.env, env)
    let instructionRequests = 0
    const server = setupServer(
      http.all(/^http:\/\/127\.0\.0\.1:/, () => passthrough()),
      http.post(
        "https://api.github.com/app/installations/123456789/access_tokens",
        async ({ request }) => {
          const body = (await request.json()) as {
            permissions?: { contents?: string }
          }
          return HttpResponse.json(
            {
              token: "fixture-only",
              expires_at: new Date(Date.now() + 3600_000).toISOString(),
              permissions: {
                contents: body.permissions?.contents ?? "read",
                metadata: "read",
              },
            },
            { status: 201 },
          )
        },
      ),
      http.get("https://api.github.com/repos/fixture/producer", () =>
        HttpResponse.json({
          default_branch: "trunk",
          permissions: { push: true },
        }),
      ),
      http.post(
        "https://producer-model.test/v1/chat/completions",
        async ({ request }) => {
          const body = (await request.json()) as {
            tools?: Array<{ function: { name: string } }>
            response_format?: { json_schema?: { name: string } }
          }
          const instruction = body.tools?.find(
            (t) => t.function.name === "instruction_units",
          )
          const structured = Boolean(
            instruction ||
              body.response_format?.json_schema?.name === "instruction_units",
          )
          const units = {
            units: [
              {
                name: "Use amberquartz instructions",
                summary: "Use amberquartz instructions.",
                source_excerpt: "Use amberquartz instructions.",
                modality: "required",
                intent: "Keep repository instructions consistent",
                applicability: {
                  tags: [],
                  scope: "repository",
                  environment: null,
                },
                durable: true,
              },
            ],
          }
          if (structured) instructionRequests++
          return HttpResponse.json({
            id: "fixture-producer",
            object: "chat.completion",
            created: 1,
            model: "fixture",
            choices: [
              {
                index: 0,
                message: instruction
                  ? {
                      role: "assistant",
                      content: null,
                      tool_calls: [
                        {
                          id: "instruction",
                          type: "function",
                          function: {
                            name: instruction.function.name,
                            arguments: JSON.stringify(units),
                          },
                        },
                      ],
                    }
                  : {
                      role: "assistant",
                      content: structured
                        ? JSON.stringify(units)
                        : "ctxpipe - Capture repository knowledge",
                    },
                finish_reason: instruction ? "tool_calls" : "stop",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })
        },
      ),
    )
    server.listen({ onUnhandledRequest: "error" })
    try {
      await withNativeIndexFixture(
        async (f) => {
          const url = "https://github.com/fixture/producer"
          const connectionId = `con_${f.namespace}`
          f.git("config", "--global", `url.${f.remote}.insteadOf`, url)
          f.git(
            "config",
            "--global",
            "--add",
            `url.${f.remote}.insteadOf`,
            "https://x-access-token:fixture-only@github.com/fixture/producer",
          )
          f.git("config", "receive.denyCurrentBranch", "updateInstead")
          await withOrgDbContext(f.org.id, async (db) => {
            await db.insert(connections).values({
              id: connectionId,
              orgId: f.org.id,
              type: "github",
              config: {
                installationId: 123456789,
                ingestAllRepositories: false,
                includeFutureRepos: false,
              },
            })
            await db
              .update(workspaces)
              .set({
                workspaceRepositoryUrl: url,
                githubConnectionId: connectionId,
                writeStatus: "writable",
                activeRevision: null,
                activeProjectionSha: null,
                activeProjectionUrl: null,
              })
              .where(eq(workspaces.id, f.workspaceId))
            await db
              .update(repositories)
              .set({ gitUrl: url, githubConnectionId: connectionId })
              .where(eq(repositories.id, f.repositoryId))
          })
          const backend = await BackendPostgres.connect(f.databaseUrl, {
            runMigrations: false,
          })
          const runner = new OpenWorkflow({ backend })
          runner.implementWorkflow(
            repositoryIngestionOrchestrator.spec,
            repositoryIngestionOrchestrator.fn,
          )
          runner.implementWorkflow(
            repositoryIngestion.spec,
            repositoryIngestion.fn,
          )
          runner.implementWorkflow(repositoryIndex.spec, repositoryIndex.fn)
          runner.implementWorkflow(
            workspaceExtractIngest.spec,
            workspaceExtractIngest.fn,
          )
          const worker = runner.newWorker({ concurrency: 4 })
          try {
            const owner = await withOrgIdContext(f.org, () =>
              enqueueRepositoryIngestionWorkflow(
                { orgId: f.org.id, repositoryId: f.repositoryId },
                {
                  error: (error) => {
                    throw error
                  },
                },
              ),
            )
            await worker.start()
            await expect
              .poll(
                async () =>
                  (
                    await backend.getWorkflowRun({
                      workflowRunId: owner.workflowRunId,
                    })
                  )?.status,
                { timeout: 65_000 },
              )
              .toMatch(/^(completed|failed|cancelled)$/)
            expect(
              (
                await backend.getWorkflowRun({
                  workflowRunId: owner.workflowRunId,
                })
              )?.status,
            ).toBe("completed")
            await worker.stop()
            expect(instructionRequests).toBeGreaterThan(0)
            expect(f.git("rev-list", "--count", `${f.sha}..trunk`)).toBe("1")
            const files = f
              .git("ls-tree", "-r", "--name-only", "trunk")
              .split("\n")
            const knowledge = files
              .filter((path) => path.endsWith(".md"))
              .map((path) => f.git("show", `trunk:${path}`))
              .join("\n")
            expect(knowledge).toContain("HAS_INSTRUCTION")
            expect(knowledge).toContain("Use amberquartz instructions")
            expect(
              await getRepositoryForOrg(f.org.id, f.repositoryId),
            ).toMatchObject({ lastIngestedHash: f.sha, indexReady: true })
          } catch (error) {
            const runs = (
              await backend.listWorkflowRuns({ limit: 100 })
            ).data.filter(
              (run) => (run.input as { orgId?: string })?.orgId === f.org.id,
            )
            throw new Error(
              `${String(error)}\nNative runs: ${JSON.stringify(runs.map((run) => ({ name: run.workflowName, status: run.status, error: run.error })))}`,
              { cause: error },
            )
          } finally {
            await worker.stop()
            await backend.stop()
            await withOrgDbContext(f.org.id, async (db) => {
              await db
                .update(workspaces)
                .set({ githubConnectionId: null })
                .where(eq(workspaces.id, f.workspaceId))
              await db
                .update(repositories)
                .set({ githubConnectionId: null })
                .where(eq(repositories.id, f.repositoryId))
              await db
                .delete(connections)
                .where(eq(connections.id, connectionId))
            })
          }
        },
        false,
        {
          "package.json": JSON.stringify({
            name: "producer-proof",
            private: true,
            scripts: { start: "node sample.js" },
          }),
        },
      )
    } finally {
      server.close()
      for (const [key, value] of Object.entries(saved))
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      await rm(directory, { recursive: true, force: true })
    }
  },
)
