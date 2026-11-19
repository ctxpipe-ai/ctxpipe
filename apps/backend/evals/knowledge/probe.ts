import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { z } from "zod"

import {
  embedMultimodal,
  multimodalEmbeddingConfig,
} from "../../src/retrieval/embeddings/multimodalEmbeddings.js"
import { decideNoul, JEV_PROVIDER } from "../../src/retrieval/jev/client.js"
import { DEFAULT_OPENROUTER_BASE } from "../../src/retrieval/services/modelProvider.js"
import { ModelCalls } from "./model-calls.js"

/*
 * The live provider probe (ADR-068 decision 7, ADR-063 decision 6). Before
 * the first org leaves `off`, real calls confirm that the model provider
 * applies the request settings of the knowledge plane. Each check sends its
 * request through the real client (`decideNoul`, `embedMultimodal`), so the
 * probe tests the request that production sends, not a copy. The recorder of
 * the eval run (`ModelCalls`) keeps the status and the raw answer of each
 * call as evidence, and it applies the spend cap.
 *
 * The probe sends only fixed text and a checkerboard image that this
 * repository holds. It never sends customer data.
 */

/** The result of one check. The evidence comes from the real answer. */
export type ProbeCheck = {
  name: string
  pass: boolean
  /** The HTTP status of the last call of the check, or null with no call. */
  status: number | null
  /** The `provider` field of the answer. */
  provider: string | null
  /** The error of the client and the error text of the provider. */
  error: string | null
  /** What a pass needs. */
  expects: string
}

const answerSchema = z
  .object({
    provider: z.string().optional(),
    error: z.object({ message: z.string() }).partial().optional(),
  })
  .partial()

const jevQuestion = {
  sky: {
    type: "noul" as const,
    instructions: "Does the text say that the sky is blue?",
  },
}
const jevOptions = { timeoutMs: 60_000, attributes: {} }

/** Lowercase letters and digits only: `TypeSafe` is the slug `typesafe`. */
const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "")

/**
 * Run `call` and return the evidence of its last model call. A failure of
 * `call` is evidence too: it does not stop the probe.
 */
async function observe(
  calls: ModelCalls,
  call: () => Promise<unknown>,
): Promise<{
  result: unknown
  status: number | null
  provider: string | null
  error: string | null
}> {
  // A stopped call can retry (the embedding client retries a 503), so a
  // check after the stop sends nothing.
  if (calls.stopped)
    return {
      result: undefined,
      status: null,
      provider: null,
      error: "The spend cap stopped the probe before this check.",
    }
  const before = calls.records.length
  let result: unknown
  let thrown: string | null = null
  try {
    result = await call()
  } catch (error) {
    thrown = error instanceof Error ? error.message : String(error)
  }
  const last = calls.records.slice(before).at(-1)
  let answer: z.infer<typeof answerSchema> = {}
  try {
    answer = answerSchema.safeParse(JSON.parse(last?.response ?? "")).data ?? {}
  } catch {
    answer = {}
  }
  const errors = [thrown, answer.error?.message?.slice(0, 500)].filter(
    (part): part is string => Boolean(part),
  )
  return {
    result,
    status: last?.status ?? null,
    provider: answer.provider ?? null,
    error: errors.length > 0 ? errors.join(" Provider: ") : null,
  }
}

/**
 * Run `call` with one change to the JSON body of each request that it sends.
 * The real client still makes the request and reads the answer.
 */
async function withChangedBody<T>(
  change: (body: Record<string, unknown>) => Record<string, unknown>,
  call: () => Promise<T>,
): Promise<T> {
  const next = globalThis.fetch
  const changed = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const body = change(
      z.record(z.string(), z.unknown()).parse(await request.json()),
    )
    return next(
      new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: JSON.stringify(body),
        signal: request.signal,
      }),
    )
  }
  globalThis.fetch = Object.assign(changed, next)
  try {
    return await call()
  } finally {
    globalThis.fetch = next
  }
}

/** The four checks of the probe, one after the other. */
export async function probeChecks(
  calls: ModelCalls,
  image: Uint8Array,
): Promise<ProbeCheck[]> {
  const checks: ProbeCheck[] = []
  const dimensions = multimodalEmbeddingConfig.dimensions

  const served = await observe(calls, () =>
    decideNoul(["The sky is blue on a clear day."], jevQuestion, jevOptions),
  )
  checks.push({
    name: "decisions-pinned",
    pass:
      served.result instanceof Map &&
      served.status === 200 &&
      served.provider !== null &&
      slug(served.provider) === JEV_PROVIDER,
    status: served.status,
    provider: served.provider,
    error: served.error,
    expects: `HTTP 200, a yes/no answer, and the provider ${JEV_PROVIDER}`,
  })

  // The refusal check. The request is the request of the client with one
  // more provider setting: `ignore: [JEV_PROVIDER]`. TypeSafe is the only
  // provider of the Jev model, and its endpoint is the only ZDR endpoint of
  // it, so no ZDR endpoint can serve this request. If the Decisions endpoint
  // ignored the provider block (and with it `zdr` and `data_collection`), it
  // would send the request to TypeSafe and answer 200. A refusal thus shows
  // that the endpoint filters its endpoints by the provider block, in the
  // same routing step that applies `zdr`.
  //
  // A direct proof of `zdr` alone needs a Decisions model with an endpoint
  // that is not on the ZDR list: then `zdr: true` alone would refuse it. On
  // 2026-11-20 the OpenRouter model list had no such model.
  const refused = await observe(calls, () =>
    withChangedBody(
      (body) => ({
        ...body,
        provider: {
          ...z.record(z.string(), z.unknown()).parse(body.provider),
          ignore: [JEV_PROVIDER],
        },
      }),
      () => decideNoul(["The sky is green."], jevQuestion, jevOptions),
    ),
  )
  checks.push({
    name: "decisions-refused-without-zdr-endpoint",
    // A 4xx refusal. An auth (401), credit (402), timeout (408) or rate
    // (429) status says nothing about the routing.
    pass:
      refused.status !== null &&
      refused.status >= 400 &&
      refused.status < 500 &&
      ![401, 402, 408, 429].includes(refused.status),
    status: refused.status,
    provider: refused.provider,
    error: refused.error,
    expects: "a 4xx refusal (not 401, 402, 408 or 429) and no answer",
  })

  const embedded = async (
    name: string,
    input: Parameters<typeof embedMultimodal>[0][number],
  ) => {
    const evidence = await observe(calls, () => embedMultimodal([input]))
    const vectors = z.array(z.array(z.number())).safeParse(evidence.result)
    checks.push({
      name,
      pass:
        evidence.status === 200 &&
        vectors.data?.length === 1 &&
        vectors.data[0]?.length === dimensions,
      status: evidence.status,
      provider: evidence.provider,
      error: evidence.error,
      expects: `HTTP 200 from the pinned provider ${multimodalEmbeddingConfig.upstreamProvider}, and one vector of ${dimensions} dimensions`,
    })
  }
  await embedded("embedding-image", {
    kind: "image",
    bytes: image,
    mimeType: "image/png",
  })
  await embedded("embedding-text", {
    kind: "query",
    text: "A red and blue checkerboard.",
  })
  return checks
}

const cell = (value: string | number | boolean | null) =>
  String(value ?? "—").replace(/\|/g, "\\|")

/**
 * The `probe` command. It writes `probe.json` and `probe.md` to `out`.
 * Returns the exit code: 0 all checks pass, 3 the spend cap stopped a call,
 * 4 a check failed.
 */
export async function probe(input: {
  out: string
  capUsd: number
}): Promise<number> {
  const calls = new ModelCalls(
    process.env.MODEL_PROVIDER_URL || DEFAULT_OPENROUTER_BASE,
    input.capUsd,
  )
  const image = await readFile(
    new URL("fixtures/probe-checkerboard.png", import.meta.url),
  )
  const restore = calls.install()
  let checks: ProbeCheck[]
  try {
    checks = await probeChecks(calls, image)
  } finally {
    restore()
  }
  const result = {
    at: new Date().toISOString(),
    capUsd: input.capUsd,
    spentUsd: calls.spentUsd,
    stopped: calls.stopped,
    checks,
  }
  const markdown = [
    `# Provider probe, ${result.at}`,
    "",
    "| Check | Result | Status | Provider | Error | Pass needs |",
    "| --- | --- | --- | --- | --- | --- |",
    ...checks.map((check) =>
      [
        check.name,
        check.pass ? "pass" : "FAIL",
        check.status,
        check.provider,
        check.error,
        check.expects,
      ]
        .map(cell)
        .join(" | ")
        .replace(/^/, "| ")
        .concat(" |"),
    ),
    "",
    `Spent $${result.spentUsd.toFixed(4)} of the cap $${result.capUsd}.${result.stopped ? " The spend cap stopped a call." : ""}`,
    "",
  ].join("\n")
  await mkdir(input.out, { recursive: true })
  await writeFile(
    join(input.out, "probe.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  )
  await writeFile(join(input.out, "probe.md"), markdown)
  process.stdout.write(markdown)
  if (calls.stopped) return 3
  return checks.every((check) => check.pass) ? 0 : 4
}
