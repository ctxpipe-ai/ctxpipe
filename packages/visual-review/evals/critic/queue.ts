// The labeling queue of the owner in Langfuse (CTX-1201). `push` puts the
// items into the annotation queue: one label item for each real change (an
// `intended` case), and, from the results of a bake-off run, blind pairwise
// picks of two critic outputs. `export` writes the labels and the picks of
// the owner into cases.json. See README.md beside this file.
//
// Usage: pnpm visual:bakeoff:queue push|export [--results <path>]
//          [--cases <path>] [--pairs 60] [--langfuse <url>]

import { createHash, randomUUID } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"

import type { Verdict } from "../../src/verdict.ts"
import { caseManifestSchema, type Case, type CaseManifest } from "./cases.ts"
import { imageFile, releaseUrl } from "./images.ts"
import type { Result } from "./report.ts"

const queueName = "visual-bakeoff"

const usage = `Usage: pnpm visual:bakeoff:queue push|export [--results <path>] [--cases <path>] [--pairs 60] [--langfuse <url>]

  push      Put the items into the annotation queue "${queueName}": a label
            item for each real change, and with --results, the pairwise picks.
            An item that is in the queue already does not go in again.
  export    Write the labels and the picks of the owner into the manifest.
            With --results, also the picks.
  --results The results.json of a bake-off run. The pairs come from it.
  --cases   The case manifest. Default: cases.json beside this file.
  --pairs   The number of pairwise picks. Default: 60
  --langfuse
            The Langfuse host. Default: https://langfuse.ctxpipe.ai

LANGFUSE_AUTH_STRING is base64("<public key>:<secret key>") of the project.`

/** The names of the score configs of the queue. */
const scores = { label: "bakeoff-label", pick: "bakeoff-pick" }

const labelTrace = (id: string) => `visual-bakeoff-label-${id}`

/** One blind pick: output A is the verdict of `arms[0]`. */
type Pair = { trace: string; case: Case; arms: [Result, Result] }

/**
 * The pairs of the picks: for each case with two or more verdicts of run 1
 * that came from a judge, the pair of arms first in the order of a hash.
 * The cases come in the order of a hash too, and the hash also puts the arms
 * in the order A, B. The same results give the same pairs.
 */
function pairsOf(
  manifest: CaseManifest,
  results: readonly Result[],
  count: number,
): Pair[] {
  const hash = (text: string) => createHash("sha256").update(text).digest("hex")
  const pairs: Pair[] = []
  for (const entry of manifest.cases) {
    const judged = results.filter(
      (result) =>
        result.case === entry.id &&
        result.run === 1 &&
        !result.verdict.error &&
        // No judge was called: each arm gives the same verdict.
        result.verdict.model !== "none",
    )
    const options = judged.flatMap((a, i) =>
      judged.slice(i + 1).map((b) => {
        const key = hash(`${entry.id}|${a.arm}|${b.arm}`)
        return {
          key,
          arms: (key < hash(key) ? [a, b] : [b, a]) as Pair["arms"],
        }
      }),
    )
    const first = options.sort((x, y) => (x.key < y.key ? -1 : 1))[0]
    if (first)
      pairs.push({
        trace: `visual-bakeoff-pick-${first.key.slice(0, 24)}`,
        case: entry,
        arms: first.arms,
      })
  }
  return pairs.sort((x, y) => (x.trace < y.trace ? -1 : 1)).slice(0, count)
}

/** The brief and the images of a case, as Markdown. */
function shown(entry: Case) {
  const image = (name: string, sha256: string) => {
    const url = `${releaseUrl}/${imageFile(sha256)}`
    return `**${name}:** [open](${url})\n\n![${name}](${url})`
  }
  return [
    `**Story:** \`${entry.storyId}\``,
    `**Brief:**\n\n${entry.brief ?? "(none)"}`,
    ...("before" in entry.images ? [image("Before", entry.images.before)] : []),
    image("After", entry.images.after),
  ].join("\n\n")
}

/** A verdict as Markdown, with no sign of the arm or the model. */
function output(name: string, verdict: Verdict) {
  return [
    `### Output ${name}`,
    `**Verdict:** ${verdict.verdict}, **severity:** ${verdict.severity}`,
    verdict.summary,
    ...verdict.findings.map(
      (finding) =>
        `- **${finding.kind}:** ${finding.evidence}${finding.suggestion ? ` Suggestion: ${finding.suggestion}` : ""}`,
    ),
  ].join("\n\n")
}

/** The Langfuse public API with the key of LANGFUSE_AUTH_STRING. */
function langfuse(host: string, auth: string) {
  const call = async (
    path: string,
    init?: { method: string; body: unknown },
  ) => {
    const response = await fetch(`${host}/api/public${path}`, {
      method: init?.method ?? "GET",
      headers: {
        authorization: `Basic ${auth}`,
        "content-type": "application/json",
      },
      ...(init ? { body: JSON.stringify(init.body) } : {}),
    })
    if (!response.ok)
      throw new Error(
        `Langfuse ${init?.method ?? "GET"} ${path} gave ${response.status}: ${await response.text()}`,
      )
    return (await response.json()) as Record<string, unknown>
  }
  // All pages of a list.
  const all = async <T>(path: string) => {
    const rows: T[] = []
    for (let page = 1; ; page++) {
      const separator = path.includes("?") ? "&" : "?"
      const body = (await call(
        `${path}${separator}page=${page}&limit=100`,
      )) as {
        data: T[]
        meta: { totalPages: number }
      }
      rows.push(...body.data)
      if (page >= body.meta.totalPages) return rows
    }
  }
  return { call, all }
}

/**
 * Run `pnpm visual:bakeoff:queue` with the command-line arguments `args`.
 * `print` gets the output. Returns the exit code: 2 for a usage error.
 */
export async function labelQueue(
  args: readonly string[],
  print: (text: string) => void,
): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({
      args: [...args],
      strict: true,
      allowPositionals: true,
      options: {
        results: { type: "string" },
        cases: { type: "string" },
        pairs: { type: "string", default: "60" },
        langfuse: { type: "string", default: "https://langfuse.ctxpipe.ai" },
      },
    })
  } catch (error) {
    print(`${(error as Error).message}\n\n${usage}`)
    return 2
  }
  const { values: options, positionals } = parsed
  const [command] = positionals
  const count = Number(options.pairs)
  const auth = process.env.LANGFUSE_AUTH_STRING
  if (
    positionals.length !== 1 ||
    (command !== "push" && command !== "export") ||
    !Number.isInteger(count) ||
    count < 0 ||
    !auth
  ) {
    print(
      `Give push or export, --pairs as a whole number, and LANGFUSE_AUTH_STRING.\n\n${usage}`,
    )
    return 2
  }
  const casesPath = resolve(
    options.cases ?? join(import.meta.dirname, "cases.json"),
  )
  const manifest = caseManifestSchema.parse(
    JSON.parse(await readFile(casesPath, "utf8")),
  )
  const pairs = options.results
    ? pairsOf(
        manifest,
        (
          JSON.parse(await readFile(resolve(options.results), "utf8")) as {
            results: Result[]
          }
        ).results,
        count,
      )
    : []
  const api = langfuse(options.langfuse, auth)
  const real = manifest.cases.filter(({ kind }) => kind === "intended")

  if (command === "push") {
    const queue = (
      await api.all<{ id: string; name: string }>("/annotation-queues")
    ).find(({ name }) => name === queueName)
    if (!queue) {
      print(
        `Langfuse has no annotation queue "${queueName}". Make it with the score configs ${scores.label} and ${scores.pick} (README.md).`,
      )
      return 2
    }
    const traces = [
      ...real.map((entry) => ({
        id: labelTrace(entry.id),
        name: "visual-bakeoff-label",
        input: `${shown(entry)}\n\nScore ${scores.label}: intended when the brief explains the change, regression when the change breaks the UI, else unsure.`,
      })),
      ...pairs.map((pair) => ({
        id: pair.trace,
        name: "visual-bakeoff-pick",
        input: `${shown(pair.case)}\n\nScore ${scores.pick}: the output that you prefer (A or B), or tie.`,
        output: pair.arms
          .map((result, i) => output(i ? "B" : "A", result.verdict))
          .join("\n\n"),
      })),
    ]
    // Some traces for each call, so that one request stays small.
    for (let start = 0; start < traces.length; start += 50) {
      const body = (await api.call("/ingestion", {
        method: "POST",
        body: {
          batch: traces.slice(start, start + 50).map((trace) => ({
            id: randomUUID(),
            type: "trace-create",
            timestamp: new Date().toISOString(),
            body: { ...trace, tags: ["visual-bakeoff"] },
          })),
        },
      })) as { errors: unknown[] }
      if (body.errors.length)
        throw new Error(
          `Langfuse refused traces: ${JSON.stringify(body.errors)}`,
        )
    }
    const present = new Set(
      (
        await api.all<{ objectId: string }>(
          `/annotation-queues/${queue.id}/items`,
        )
      ).map(({ objectId }) => objectId),
    )
    const added = traces.filter(({ id }) => !present.has(id))
    for (const { id } of added)
      await api.call(`/annotation-queues/${queue.id}/items`, {
        method: "POST",
        body: { objectId: id, objectType: "TRACE" },
      })
    print(
      `${added.length} items added to the queue "${queueName}" (${real.length} labels, ${pairs.length} picks; ${traces.length - added.length} were in it).`,
    )
    return 0
  }

  // The newest score of each trace counts.
  const latest = async (name: string) => {
    const rows = await api.all<{
      traceId: string | null
      stringValue: string | null
      timestamp: string
    }>(`/v2/scores?name=${encodeURIComponent(name)}`)
    const values = new Map<string, { value: string; at: string }>()
    for (const row of rows) {
      const known = row.traceId ? values.get(row.traceId) : undefined
      if (
        row.traceId &&
        row.stringValue &&
        (!known || known.at < row.timestamp)
      )
        values.set(row.traceId, { value: row.stringValue, at: row.timestamp })
    }
    return values
  }
  const labels = await latest(scores.label)
  let labeled = 0
  const cases = manifest.cases.map((entry) => {
    const label = labels.get(labelTrace(entry.id))?.value
    if (entry.kind !== "intended" || !label) return entry
    labeled++
    return { ...entry, label }
  })
  const picks = pairs.length ? await latest(scores.pick) : new Map()
  const taste = pairs.flatMap((pair) => {
    const pick = picks.get(pair.trace)?.value
    if (!pick) return []
    const arms = pair.arms.map(({ arm }) => arm) as [string, string]
    return [
      {
        case: pair.case.id,
        arms,
        winner: pick === "A" ? arms[0] : pick === "B" ? arms[1] : "tie",
      },
    ]
  })
  // A new pick of a case and two arms replaces the old one.
  const key = (pick: { case: string; arms: readonly string[] }) =>
    `${pick.case}|${[...pick.arms].sort().join("|")}`
  const fresh = new Set(taste.map(key))
  const merged = [
    ...(manifest.taste ?? []).filter((pick) => !fresh.has(key(pick))),
    ...taste,
  ]
  const next = caseManifestSchema.parse({
    ...manifest,
    cases,
    ...(merged.length ? { taste: merged } : {}),
  })
  await writeFile(casesPath, `${JSON.stringify(next, null, 2)}\n`)
  print(`${labeled} labels and ${taste.length} picks written to ${casesPath}.`)
  return 0
}

if (import.meta.main)
  process.exitCode = await labelQueue(process.argv.slice(2), (text) =>
    process.stdout.write(`${text}\n`),
  )
