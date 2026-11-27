import { execFileSync } from "node:child_process"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { eq, sql } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { executeRun, hydrateCommand } from "../../evals/knowledge/cli.js"
import { type Dataset, datasetSchema } from "../../evals/knowledge/dataset.js"
import { hydrateCorpora } from "../../evals/knowledge/hydrate.js"
import { ModelCalls } from "../../evals/knowledge/model-calls.js"
import {
  type ArmAnswer,
  readRun,
  type Targets,
  writeRun,
} from "../../evals/knowledge/runner.js"
import { getSystemDb, initDb, withOrgDbContext } from "../db/client.js"
import { organizations } from "../db/schema/auth.js"
import { workspaces } from "../db/schema/workspaces.js"
import { migrateKnowledgeStore } from "../knowledge-store/migrate.js"
import { textEmbeddingConfig } from "../retrieval/embeddings/textEmbeddings.js"
import { startClickHouse, userUrl } from "../test/clickhouse.js"
import { startGitHttpServer } from "../test/git-http-server.js"
import { embedText } from "../test/knowledge-search-fixture.js"

/*
 * The hydrate of the knowledge eval harness (ADR-069 decision 3): a small
 * frozen context repo goes into the knowledge plane through the real
 * workflows (real Git over HTTP, Postgres and ClickHouse; msw answers for
 * the model). Then `run` answers its question on the plane, with a stored
 * answer of the old stack as its baseline.
 */

/** The eval org of this run. */
const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const org = {
  id: `org_knowledge_eval_${suffix}`,
  slug: `knowledge-eval-${suffix}`,
  name: "Knowledge eval test",
}
const workspaceId = `ws_knowledge_eval_${suffix}_tiny`

// The worker of the hydrate takes the runs of its OpenWorkflow namespace,
// so the test has its own namespace, set before the client module loads.
vi.hoisted(() => {
  vi.stubEnv(
    "OPENWORKFLOW_NAMESPACE_ID",
    `knowledge-eval-hydrate-${process.pid}`,
  )
})

const MODEL_URL = "https://hydrate-model.test/v1"
/** The body of each embedding request. */
const embeddingBodies: {
  model: string
  input: string[]
  dimensions?: number
  provider?: unknown
}[] = []

const models = setupServer(
  http.post(`${MODEL_URL}/embeddings`, async ({ request }) => {
    const body = (await request.json()) as {
      model: string
      input: string[]
      dimensions?: number
      provider?: unknown
    }
    embeddingBodies.push(body)
    return HttpResponse.json({
      data: body.input.map((input, index) => ({
        index,
        embedding: embedText(input),
      })),
      usage: { cost: 0.0001 },
    })
  }),
  // Jev keeps each candidate.
  http.post(
    "https://hydrate-model.test/alpha/decisions",
    async ({ request }) => {
      const body = (await request.json()) as {
        questions: Record<string, unknown>
      }
      return HttpResponse.json({
        answers: Object.fromEntries(
          Object.keys(body.questions).map((key) => [
            key,
            { type: "noul", noul: 0.9 },
          ]),
        ),
        usage: { cost: 0.0001 },
      })
    },
  ),
)

let directory: string
let git: Awaited<ReturnType<typeof startGitHttpServer>>
let clickHouse: Awaited<ReturnType<typeof startClickHouse>>
let readerUrl: string
let writerUrl: string
let dataset: Dataset
let imagesSha: string

const hydrate = async (calls: ModelCalls, of: Dataset = dataset) => {
  const restore = calls.install()
  try {
    return await hydrateCorpora({
      dataset: of,
      org,
      databaseUrl: process.env.DATABASE_URL ?? "",
      calls,
      log: () => {},
    })
  } finally {
    restore()
  }
}

describe("the hydrate of the knowledge eval harness", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    vi.stubEnv("MODEL_PROVIDER", "openrouter")
    vi.stubEnv("MODEL_PROVIDER_API_KEY", "fixture-only")
    vi.stubEnv("MODEL_PROVIDER_URL", MODEL_URL)
    models.listen({ onUnhandledRequest: "bypass" })
    initDb(process.env.DATABASE_URL)

    directory = mkdtempSync(join(tmpdir(), "knowledge-eval-hydrate-"))
    const repo = join(directory, "context")
    const run = (...args: string[]) =>
      execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim()
    mkdirSync(join(repo, "docs"), { recursive: true })
    writeFileSync(
      join(repo, "docs", "invoices.md"),
      "# Invoices\n\nThe billing service stores each invoice in Postgres.\n",
    )
    writeFileSync(
      join(repo, "docs", "deploys.md"),
      "# Deploys\n\nA release ships one image to each environment.\n",
    )
    // Out of the root of the corpus: no stack reads it.
    writeFileSync(join(repo, "README.md"), "# Outside\n\nNot in the corpus.\n")
    run("init", "-b", "main")
    run("add", ".")
    run(
      "-c",
      "user.name=Eval",
      "-c",
      "user.email=eval@example.test",
      "commit",
      "-m",
      "Frozen context repo",
    )
    const sha = run("rev-parse", "HEAD")
    execFileSync("git", ["clone", "--quiet", repo, join(directory, "copy")])
    // A copy with an image: the plane reads it with the vision model.
    const images = join(directory, "images")
    execFileSync("git", ["clone", "--quiet", repo, images])
    writeFileSync(
      join(images, "docs", "diagram.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      ),
    )
    execFileSync("git", ["-C", images, "add", "."])
    execFileSync("git", [
      "-C",
      images,
      "-c",
      "user.name=Eval",
      "-c",
      "user.email=eval@example.test",
      "commit",
      "--quiet",
      "-m",
      "An image",
    ])
    imagesSha = execFileSync("git", ["-C", images, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim()
    git = await startGitHttpServer(directory)

    clickHouse = await startClickHouse()
    const url = await clickHouse.freshDatabase()
    await migrateKnowledgeStore(url, {
      reader: "reader-test",
      writer: "writer-test",
    })
    readerUrl = userUrl(url, "ctxpipe_reader", "reader-test")
    writerUrl = userUrl(url, "ctxpipe_writer", "writer-test")

    dataset = datasetSchema.parse({
      version: "test",
      corpora: [
        {
          id: "tiny",
          source: "made up",
          contextRepo: {
            url: `http://127.0.0.1:${git.port}/context`,
            sha,
            root: "docs",
          },
          workspace: "tiny-v0",
        },
      ],
      questions: [
        {
          id: "invoice-store",
          corpus: "tiny",
          category: "lookup",
          split: "dev",
          text: "Where does the billing service store invoices?",
          gold: ["invoices.md"],
          keyFacts: ["Invoices are in Postgres."],
        },
      ],
    })
  }, 240_000)

  afterAll(async () => {
    const orgId = org.id
    await getSystemDb().execute(
      sql`delete from openworkflow.workflow_runs where input->>'orgId' = ${orgId}`,
    )
    await withOrgDbContext(orgId, (db) =>
      db.delete(workspaces).where(eq(workspaces.orgId, orgId)),
    )
    await getSystemDb().delete(organizations).where(eq(organizations.id, orgId))
    await clickHouse?.stop()
    await git?.stop()
    if (directory) rmSync(directory, { recursive: true, force: true })
    models.close()
    vi.unstubAllEnvs()
  })

  let targets: Targets

  it("refuses a context repo that is not on http or https", async () => {
    const [corpus] = dataset.corpora
    if (!corpus) throw new Error("The dataset has no corpus.")
    await expect(
      hydrate(new ModelCalls(MODEL_URL, 1), {
        ...dataset,
        corpora: [
          {
            ...corpus,
            contextRepo: { ...corpus.contextRepo, url: `file://${directory}` },
          },
        ],
      }),
    ).rejects.toThrow(
      "The context repo of tiny must have an http or https URL.",
    )
  })

  it("stops with exit code 3 when the spend cap stops a call, and writes the spend", async () => {
    vi.stubEnv("CLICKHOUSE_URL", writerUrl)
    const out = join(directory, "capped")
    expect(
      await hydrateCommand({
        dataset,
        org,
        databaseUrl: process.env.DATABASE_URL ?? "",
        out,
        capUsd: 0,
      }),
    ).toBe(3)
    expect(JSON.parse(readFileSync(join(out, "hydrate.json"), "utf8"))).toEqual(
      {
        capUsd: 0,
        spentUsd: 0,
        stopped: true,
        failedDocuments: null,
      },
    )
    expect(embeddingBodies).toEqual([])
  })

  it("stops with exit code 3 when the spend cap stops a vision call", async () => {
    vi.stubEnv("CLICKHOUSE_URL", writerUrl)
    const [corpus] = dataset.corpora
    if (!corpus) throw new Error("The dataset has no corpus.")
    const out = join(directory, "images-capped")
    // The embedding calls fit in the cap, and the vision call of the image
    // (reserved at $0.05) does not.
    expect(
      await hydrateCommand({
        dataset: {
          ...dataset,
          corpora: [
            {
              ...corpus,
              id: "images",
              workspace: "images-v0",
              contextRepo: {
                ...corpus.contextRepo,
                url: corpus.contextRepo.url.replace(/context$/, "images"),
                sha: imagesSha,
              },
            },
          ],
        },
        org,
        databaseUrl: process.env.DATABASE_URL ?? "",
        out,
        capUsd: 0.01,
      }),
    ).toBe(3)
    // The refused call fails the step of the projection, as an outage does.
    expect(
      JSON.parse(readFileSync(join(out, "hydrate.json"), "utf8")),
    ).toMatchObject({ stopped: true, failedDocuments: null })
    expect(() => readFileSync(join(out, "targets.json"))).toThrow()
  })

  it("stops at the first failed step, with its error", async () => {
    // A setup error: the projection cannot sign in to ClickHouse.
    vi.stubEnv("CLICKHOUSE_URL", userUrl(writerUrl, "ctxpipe_writer", "wrong"))
    await expect(hydrate(new ModelCalls(MODEL_URL, 1))).rejects.toThrow(
      new RegExp(
        `^The step project-knowledge-plane of the hydrate of ${workspaceId} failed: .*Authentication failed`,
      ),
    )
    // The projection writes as the writer user, as the worker does.
    vi.stubEnv("CLICKHOUSE_URL", writerUrl)
  })

  it("writes the frozen corpus to the knowledge plane, with ZDR on each model call", async () => {
    const calls = new ModelCalls(MODEL_URL, 1, undefined, {
      keepRecords: false,
    })
    const hydrated = await hydrate(calls)
    targets = hydrated.targets
    expect(hydrated.failedDocuments).toEqual({ tiny: 0 })
    expect(targets).toEqual({
      "tiny-v0": { orgId: org.id, orgSlug: org.slug, workspace: "tiny-v0" },
    })
    // The plane embedded the files of the root, and each client sent the
    // provider block (ADR-070).
    expect(new Set(embeddingBodies.map((body) => body.dimensions))).toEqual(
      new Set([textEmbeddingConfig.dimensions]),
    )
    for (const body of embeddingBodies)
      expect(body.provider).toMatchObject({
        data_collection: "deny",
        zdr: true,
      })
    expect(calls.records).toEqual([])
    expect(calls.spentUsd).toBeGreaterThan(0)
  })

  it("finds the plane current on a second hydrate", async () => {
    const before = embeddingBodies.length
    await hydrate(new ModelCalls(MODEL_URL, 1))
    expect(embeddingBodies.length).toBe(before)
  })

  it("lets run answer the question on the plane, with the stored answer of the old stack", async () => {
    vi.stubEnv("CLICKHOUSE_URL", readerUrl)
    // A stored run of the old stack: it found the gold document.
    const stored = join(directory, "old-stack")
    await writeRun(stored, {
      manifest: {
        datasetVersion: dataset.version,
        splits: ["dev"],
        now: new Date().toISOString(),
        settings: {},
        loop: { keepAt: 0.5 },
        mode: "live",
        capUsd: 1,
        spentUsd: 0,
        stopped: false,
      },
      dataset,
      targets,
      answers: dataset.questions.map((question) => ({
        arm: "legacy",
        question: question.id,
        search: { refs: question.gold, scores: [1], latencyMs: 50 },
        calls: {
          jev: 0,
          jevQuestions: 0,
          embedding: 1,
          costUsd: 0,
          missing: 0,
          failed: 0,
          unrecorded: 0,
        },
      })) as ArmAnswer[],
      calls: [],
    })
    const report = await executeRun({
      dataset,
      targets,
      splits: ["dev"],
      settings: {},
      capUsd: 1,
      now: new Date(),
      out: join(directory, "run"),
      kept: null,
      quietMs: 0,
      baseline: { folder: stored, run: await readRun(stored) },
    })
    expect(report.status).toBe("complete")
    expect(
      report.questions.map(({ arm, metrics }) => ({
        arm,
        recall5: metrics.recall5,
      })),
    ).toEqual([
      { arm: "legacy", recall5: 1 },
      { arm: "plane", recall5: 1 },
    ])
  })

  it("projects the plane again when the root changes at the same SHA", async () => {
    vi.stubEnv("CLICKHOUSE_URL", writerUrl)
    const before = embeddingBodies.length
    const [corpus] = dataset.corpora
    if (!corpus) throw new Error("The dataset has no corpus.")
    dataset = {
      ...dataset,
      corpora: [
        { ...corpus, contextRepo: { ...corpus.contextRepo, root: "" } },
      ],
    }
    await hydrate(new ModelCalls(MODEL_URL, 1))
    // The file at the new root went to the plane: the hydrate waited for
    // the projection of the new root.
    const outside = embeddingBodies
      .slice(before)
      .filter((body) => body.input.some((text) => text.includes("Outside")))
      .map((body) => body.dimensions)
    expect(new Set(outside)).toEqual(new Set([textEmbeddingConfig.dimensions]))
  })
})
