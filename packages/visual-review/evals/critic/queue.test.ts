// The labeling queue of the owner, with msw in place of Langfuse. The cases
// are a copy of the committed manifest; the results are of a fake run.
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { http, HttpResponse } from "msw"
import { setupServer } from "msw/node"
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest"

import type { Verdict } from "../../src/verdict.ts"
import { caseManifestSchema } from "./cases.ts"
import { labelQueue } from "./queue.ts"

const host = "https://langfuse.test"
const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: "error" }))
afterEach(() => {
  server.resetHandlers()
  vi.unstubAllEnvs()
})
afterAll(() => server.close())

const folder = mkdtempSync(join(tmpdir(), "bakeoff-queue-"))
afterAll(() => rmSync(folder, { recursive: true, force: true }))

const committed = caseManifestSchema.parse(
  JSON.parse(readFileSync(join(import.meta.dirname, "cases.json"), "utf8")),
)
const real = committed.cases.filter(({ kind }) => kind === "intended")
const broken = committed.cases.find(({ kind }) => kind === "regression")
if (!broken || real.length < 2) throw new Error("The manifest changed.")

const verdict = (summary: string, model: string): Verdict => ({
  storyId: broken.id,
  observations: [],
  verdict: "regression",
  severity: "major",
  confidence: 0.9,
  summary,
  qualities: [],
  findings: [
    {
      kind: "spacing",
      region: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 },
      evidence: `${summary} The gap is wider.`,
      rubricRef: "apps/ui/DESIGN.md › Space",
      explainedByBrief: false,
      suggestion: null,
    },
  ],
  model,
  costUsd: 0.01,
  latencyMs: 10,
})
// Two arms judged the broken case. The noise step judged another case with
// no call, so it gives no pair.
const results = join(folder, "results.json")
writeFileSync(
  results,
  JSON.stringify({
    results: [
      {
        arm: "jev",
        case: broken.id,
        run: 1,
        verdict: verdict("Jev saw it.", "typesafe/jev-1.14"),
      },
      {
        arm: "llm:anthropic/claude-test",
        case: broken.id,
        run: 1,
        verdict: verdict("The LLM saw it.", "anthropic/claude-test"),
      },
      {
        arm: "jev",
        case: real[0]?.id,
        run: 1,
        verdict: { ...verdict("No call.", "none"), storyId: real[0]?.id },
      },
      {
        arm: "llm:anthropic/claude-test",
        case: real[0]?.id,
        run: 1,
        verdict: { ...verdict("No call.", "none"), storyId: real[0]?.id },
      },
    ],
  }),
)

const queueId = "queue-1"
type Trace = { id: string; name: string; input: string; output?: string }
let traces: Trace[] = []
let added: string[] = []
const queue = (present: string[]) => [
  http.get(`${host}/api/public/annotation-queues`, ({ request }) => {
    expect(request.headers.get("authorization")).toBe("Basic test-auth")
    return HttpResponse.json({
      data: [{ id: queueId, name: "visual-bakeoff" }],
      meta: { page: 1, limit: 100, totalItems: 1, totalPages: 1 },
    })
  }),
  http.post(`${host}/api/public/ingestion`, async ({ request }) => {
    const { batch } = (await request.json()) as {
      batch: { type: string; body: Trace }[]
    }
    expect(batch.every(({ type }) => type === "trace-create")).toBe(true)
    traces.push(...batch.map(({ body }) => body))
    return HttpResponse.json(
      { successes: batch.map(() => ({ status: 201 })), errors: [] },
      { status: 207 },
    )
  }),
  http.get(
    `${host}/api/public/annotation-queues/${queueId}/items`,
    ({ request }) => {
      // Two pages: one item on each.
      const page = Number(new URL(request.url).searchParams.get("page"))
      const objectId = present[page - 1]
      return HttpResponse.json({
        data: objectId ? [{ objectId, objectType: "TRACE" }] : [],
        meta: { page, limit: 100, totalItems: 2, totalPages: 2 },
      })
    },
  ),
  http.post(
    `${host}/api/public/annotation-queues/${queueId}/items`,
    async ({ request }) => {
      const { objectId, objectType } = (await request.json()) as {
        objectId: string
        objectType: string
      }
      expect(objectType).toBe("TRACE")
      added.push(objectId)
      return HttpResponse.json({ id: `item-${objectId}` })
    },
  ),
]

const run = async (args: string[]) => {
  vi.stubEnv("LANGFUSE_AUTH_STRING", "test-auth")
  const cases = join(mkdtempSync(join(folder, "cases-")), "cases.json")
  copyFileSync(join(import.meta.dirname, "cases.json"), cases)
  const printed: string[] = []
  const code = await labelQueue(
    [...args, "--cases", cases, "--langfuse", host],
    (text) => printed.push(text),
  )
  return { code, cases, text: printed.join("\n") }
}

test("push puts a label item for each real change and a blind pick into the queue, once", async () => {
  traces = []
  added = []
  const first = `visual-bakeoff-label-${real[0]?.id}`
  const second = `visual-bakeoff-label-${real[1]?.id}`
  server.use(...queue([first, second]))

  const { code, text } = await run(["push", "--results", results])

  expect(code).toBe(0)
  const labels = traces.filter(({ name }) => name === "visual-bakeoff-label")
  expect(labels.map(({ id }) => id)).toEqual(
    real.map(({ id }) => `visual-bakeoff-label-${id}`),
  )
  // The images are the release assets, by SHA-256.
  const [label] = labels
  const entry = real[0]
  if (!entry || entry.kind !== "intended" || !label) throw new Error("No case.")
  expect(label.input).toContain(
    `https://github.com/ctxpipe-ai/ctxpipe/releases/download/visual-bakeoff-images/${entry.images.before}.png`,
  )
  expect(label.input).toContain(`${entry.images.after}.png`)
  expect(label.input).toContain(entry.brief)

  // One pick: the broken case. The case with no judge call gives none.
  const picks = traces.filter(({ name }) => name === "visual-bakeoff-pick")
  expect(picks).toHaveLength(1)
  const output = picks[0]?.output ?? ""
  expect(output).toMatch(/### Output A[\s\S]*### Output B/)
  expect(output).toContain("Jev saw it.")
  expect(output).toContain("The LLM saw it.")
  // Blind: no arm and no model.
  for (const sign of ["jev", "Jev 1", "anthropic", "llm:", "claude"])
    expect(`${picks[0]?.input}${output}`).not.toContain(sign)

  // The two items that were in the queue do not go in again.
  expect(added).toEqual(
    traces.map(({ id }) => id).filter((id) => id !== first && id !== second),
  )
  expect(text).toContain(
    `${real.length - 1} items added to the queue "visual-bakeoff" (${real.length} labels, 1 picks; 2 were in it).`,
  )
})

test("export writes the newest label of each real change and the picks into cases.json", async () => {
  traces = []
  server.use(...queue([]))
  await run(["push", "--results", results])
  const pick = traces.find(({ name }) => name === "visual-bakeoff-pick")
  const pickedA = pick?.output?.indexOf("Jev saw it.") ?? -1
  const pickedB = pick?.output?.indexOf("### Output B") ?? -1
  const jevIsA = pickedA >= 0 && pickedA < pickedB
  const [first, second, third] = real
  if (!first || !second || !third || !pick) throw new Error("No case.")
  const score = (traceId: string, stringValue: string, timestamp: string) => ({
    traceId,
    name: "x",
    stringValue,
    timestamp,
  })
  server.use(
    http.get(`${host}/api/public/v2/scores`, ({ request }) => {
      const url = new URL(request.url)
      const rows =
        url.searchParams.get("name") === "bakeoff-label"
          ? [
              score(
                `visual-bakeoff-label-${first.id}`,
                "regression",
                "2026-11-10T10:00:00Z",
              ),
              // An older label of the same case does not count.
              score(
                `visual-bakeoff-label-${first.id}`,
                "intended",
                "2026-11-10T09:00:00Z",
              ),
              score(
                `visual-bakeoff-label-${second.id}`,
                "unsure",
                "2026-11-10T10:00:00Z",
              ),
              // A label of a case that is not a real change does not count.
              score(
                `visual-bakeoff-label-${broken.id}`,
                "intended",
                "2026-11-10T10:00:00Z",
              ),
            ]
          : [score(pick.id, "A", "2026-11-10T10:00:00Z")]
      return HttpResponse.json({
        data: rows,
        meta: { page: 1, limit: 100, totalItems: rows.length, totalPages: 1 },
      })
    }),
  )

  const { code, cases, text } = await run(["export", "--results", results])

  expect(code).toBe(0)
  expect(text).toContain("2 labels and 1 picks written")
  const written = caseManifestSchema.parse(
    JSON.parse(readFileSync(cases, "utf8")),
  )
  const label = (id: string) =>
    written.cases.find((entry) => entry.id === id)?.label
  expect(label(first.id)).toBe("regression")
  expect(label(second.id)).toBe("unsure")
  expect(label(third.id)).toBe("intended")
  expect(label(broken.id)).toBe("regression")
  const winner = jevIsA ? "jev" : "llm:anthropic/claude-test"
  expect(written.taste).toEqual([
    {
      case: broken.id,
      arms: jevIsA
        ? ["jev", "llm:anthropic/claude-test"]
        : ["llm:anthropic/claude-test", "jev"],
      winner,
    },
  ])
  // Only the labels and the picks change.
  expect({ ...written, cases: [], taste: undefined }).toEqual({
    ...committed,
    cases: [],
    taste: undefined,
  })
})

test("push stops when Langfuse has no queue", async () => {
  server.use(
    http.get(`${host}/api/public/annotation-queues`, () =>
      HttpResponse.json({
        data: [],
        meta: { page: 1, limit: 100, totalItems: 0, totalPages: 0 },
      }),
    ),
  )
  const { code, text } = await run(["push"])
  expect(code).toBe(2)
  expect(text).toContain('Langfuse has no annotation queue "visual-bakeoff"')
})
