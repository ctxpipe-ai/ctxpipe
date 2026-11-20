import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { z } from "zod"

import {
  imageTextModel,
  readImage,
} from "../../src/knowledge-plane/image-text.js"
import {
  type EmbeddingInput,
  embedTexts,
  textEmbeddingConfig,
} from "../../src/retrieval/embeddings/textEmbeddings.js"
import { decideNoul, JEV_MODEL } from "../../src/retrieval/jev/client.js"
import type { ModelCalls } from "./model-calls.js"

/*
 * The live provider probe (ADR-068 decision 7, ADR-063 decision 6). Before
 * the first org leaves `off`, real calls confirm that the model provider
 * applies the request settings of the knowledge plane. Each check sends its
 * request through the real client (`decideNoul`, `embedTexts`), so the
 * probe tests the request that production sends, not a copy. The recorder of
 * the eval run (`ModelCalls`) keeps the status and the raw answer of each
 * call as evidence, and it applies the spend cap.
 *
 * The probe sends only fixed text that this repository holds. It never
 * sends customer data.
 */

/** The result of one check. The evidence comes from the real answer. */
type ProbeCheck = {
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

/**
 * The ZDR control of the Decisions endpoint: a Decisions model whose only
 * endpoint is not on the OpenRouter ZDR list (`GET /api/v1/endpoints/zdr`,
 * on 2026-11-20). If the catalog changes, the control check fails and says
 * so; then pick another such model.
 */
const NON_ZDR_DECISIONS_MODEL = "openai/gpt-6-luna-decisions"

/**
 * The ZDR control of the embeddings endpoint: an embedding model that is not
 * on the OpenRouter ZDR list (2026-11-20). If the catalog changes, the
 * control check fails and says so; then pick another such model.
 */
const NON_ZDR_EMBEDDING_MODEL = "openai/text-embedding-ada-002"

/**
 * The ZDR control of the vision request (CTX-1433): a vision model that
 * takes an image and a JSON schema and is not on the OpenRouter ZDR list
 * (2026-11-20). If the catalog changes, the control check fails and says
 * so; then pick another such model.
 */
const NON_ZDR_VISION_MODEL = "google/gemini-2.5-flash-lite"

/** The provider names of the ZDR endpoints of a model (`zdrProviders`). */
type ZdrProvidersOf = (
  model: string,
  quantizations?: readonly string[],
) => Set<string>

/**
 * The provider names of the ZDR endpoints of each model, from the OpenRouter
 * ZDR list (`GET /api/v1/endpoints/zdr`), at an allowed quantization when
 * `quantizations` is given. The model calls pin no provider, so a check
 * passes when the answer names one of these providers (ADR-068 decision 7).
 * The answer names only the provider, not its endpoint: when a provider has
 * more than one endpoint of a model, the name does not show which one served
 * the call. The `zdr` and `quantizations` fields of the request decide the
 * endpoint, and the refusal pairs show that OpenRouter applies `zdr`. The
 * list holds no input of ours, so the call goes around the recorder.
 */
async function zdrProviders(base: string): Promise<ZdrProvidersOf> {
  const data = await readZdrList(base)
  return (model: string, quantizations?: readonly string[]) =>
    new Set(
      data
        .filter(
          (endpoint) =>
            endpoint.model_id === model &&
            (!quantizations || quantizations.includes(endpoint.quantization)),
        )
        .map((endpoint) => endpoint.provider_name),
    )
}

/**
 * The OpenRouter ZDR list (`GET /api/v1/endpoints/zdr`): each ZDR endpoint
 * with its model, provider, tag and quantization (`unknown` when the list
 * gives none).
 */
export async function readZdrList(base: string) {
  const response = await fetch(`${base.replace(/\/+$/, "")}/endpoints/zdr`)
  if (!response.ok)
    throw new Error(`The ZDR list answered HTTP ${response.status}`)
  return z
    .object({
      data: z.array(
        z.object({
          model_id: z.string(),
          provider_name: z.string(),
          tag: z.string(),
          quantization: z
            .string()
            .nullish()
            .transform((value) => value ?? "unknown"),
        }),
      ),
    })
    .parse(await response.json()).data
}

const answerSchema = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  error: z.object({ message: z.string().optional() }).optional(),
  data: z.array(z.unknown()).optional(),
})

/** Sentence `index` of the fixed public text of the probe. */
const checkerboardSentence = (index: number) =>
  `Square ${index + 1} of the checkerboard is ${index % 2 === 0 ? "red" : "blue"}.`

const jevQuestion = {
  sky: {
    type: "noul" as const,
    instructions: "Does the text say that the sky is blue?",
  },
}
const jevOptions = { timeoutMs: 60_000, attributes: {} }

type Evidence<T> = {
  result: T | undefined
  status: number | null
  provider: string | null
  /** The count of vectors in the answer (`data`). */
  vectors: number | null
  error: string | null
}

/**
 * Run `call` and return the evidence of its last model call. A failure of
 * `call` is evidence too: it does not stop the probe.
 */
async function observe<T>(
  calls: ModelCalls,
  call: () => Promise<T>,
): Promise<Evidence<T>> {
  // A stopped call can retry (the embedding client retries a 503), so a
  // check after the stop sends nothing.
  const stopped = "The spend cap stopped the probe before this check."
  if (calls.stopped)
    return {
      result: undefined,
      status: null,
      provider: null,
      vectors: null,
      error: stopped,
    }
  const before = calls.records.length
  let result: T | undefined
  let thrown: string | null = null
  try {
    result = await call()
  } catch (error) {
    thrown = error instanceof Error ? error.message : String(error)
  }
  const last = calls.records.slice(before).at(-1)
  let answer: z.infer<typeof answerSchema> = {}
  try {
    answer = answerSchema.parse(JSON.parse(last?.response ?? ""))
  } catch {
    // No JSON answer: the evidence is the status and the client error.
  }
  const providerText = answer.error?.message?.slice(0, 500)
  // The client error can already hold the routing message of the gateway.
  const errors = [
    thrown,
    providerText && !thrown?.includes(providerText) ? providerText : null,
    // The spend cap stopped this call: the recorder kept no record of it.
    !last && calls.stopped ? stopped : null,
  ].filter((part): part is string => Boolean(part))
  return {
    result,
    status: last?.status ?? null,
    provider: answer.provider ?? null,
    vectors: answer.data?.length ?? null,
    error: errors.length > 0 ? errors.join(" Provider: ") : null,
  }
}

const jsonObject = z.record(z.string(), z.unknown())

/**
 * Run `call` with one change to the JSON body of each request that it sends.
 * The real client still makes the request and reads the answer.
 */
export async function withChangedBody<T>(
  change: (body: Record<string, unknown>) => Record<string, unknown>,
  call: () => Promise<T>,
): Promise<T> {
  const next = globalThis.fetch
  const changed = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const body = change(jsonObject.parse(await request.json()))
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

/**
 * The Jev request of the client, sent to the non-ZDR Decisions model. Only
 * the model and `zdr` change.
 */
const nonZdrDecision = (zdr: boolean) =>
  withChangedBody(
    (body) => ({
      ...body,
      model: NON_ZDR_DECISIONS_MODEL,
      provider: { ...jsonObject.parse(body.provider), zdr },
    }),
    () => decideNoul(["The sky is green."], jevQuestion, jevOptions),
  )

/**
 * The embedding request of the client, sent to the non-ZDR embedding model.
 * The model and `zdr` change. The dimension and the quantizations go out
 * too, so that the control model can serve the request; both requests of
 * the pair are the same apart from `zdr`.
 */
const nonZdrEmbedding = (zdr: boolean) =>
  withChangedBody(
    ({ dimensions: _dimensions, ...body }) => {
      const { quantizations: _quantizations, ...provider } = jsonObject.parse(
        body.provider,
      )
      return {
        ...body,
        model: NON_ZDR_EMBEDDING_MODEL,
        provider: { ...provider, zdr },
      }
    },
    () => embedTexts([{ kind: "query", text: "Is the sky blue?" }]),
  )

/** The checks of the probe, one after the other. */
async function probeChecks(
  calls: ModelCalls,
  zdrProvidersOf: ZdrProvidersOf,
): Promise<ProbeCheck[]> {
  const checks: ProbeCheck[] = []
  const check = <T>(
    name: string,
    evidence: Evidence<T>,
    pass: boolean,
    expects: string,
  ) =>
    checks.push({
      name,
      pass,
      status: evidence.status,
      provider: evidence.provider,
      error: evidence.error,
      expects,
    })

  const served = await observe(calls, () =>
    decideNoul(["The sky is blue on a clear day."], jevQuestion, jevOptions),
  )
  const jevProviders = zdrProvidersOf(JEV_MODEL)
  check(
    "decisions-zdr-provider",
    served,
    served.result !== undefined &&
      served.status === 200 &&
      jevProviders.has(served.provider ?? ""),
    `HTTP 200, a yes/no answer, and a ZDR provider of ${JEV_MODEL} (${[...jevProviders].join(", ") || "none listed"})`,
  )

  // The ZDR proof of an endpoint is a pair of requests to a model of that
  // endpoint that has no ZDR endpoint. Both are the request of the client,
  // with fallback and with `data_collection: "deny"`, and they differ only in
  // `zdr`. The control (`zdr: false`) must be served: this shows that the
  // endpoint can serve the request. The same request with `zdr: true` must
  // then be refused with "no endpoint". Thus the refusal comes from `zdr`
  // alone: the endpoint enforces it. The requests of the clients have the
  // same provider block, so they can only go to a ZDR endpoint.
  const refusalPair = async (
    prefix: string,
    model: string,
    send: (zdr: boolean) => Promise<unknown>,
  ) => {
    const control = await observe(calls, () => send(false))
    check(
      `${prefix}-control-without-zdr`,
      control,
      control.status === 200,
      `HTTP 200 from ${model} (no ZDR endpoint) when zdr is false`,
    )
    const refused = await observe(calls, () => send(true))
    check(
      `${prefix}-refused-without-zdr-endpoint`,
      refused,
      control.status === 200 &&
        refused.status === 404 &&
        /no (endpoints|allowed providers)/i.test(refused.error ?? ""),
      "the control passes, then HTTP 404 with a no-endpoint error when zdr is true",
    )
  }
  await refusalPair("decisions", NON_ZDR_DECISIONS_MODEL, nonZdrDecision)

  const { model, dimensions, batchSize, quantizations } = textEmbeddingConfig
  const embeddingProviders = zdrProvidersOf(model, quantizations)
  const embedded = async (name: string, inputs: EmbeddingInput[]) => {
    const evidence = await observe(calls, () => embedTexts(inputs))
    check(
      name,
      evidence,
      evidence.status === 200 &&
        embeddingProviders.has(evidence.provider ?? "") &&
        evidence.vectors === inputs.length &&
        evidence.result?.length === inputs.length &&
        evidence.result.every((vector) => vector.length === dimensions),
      `HTTP 200, a ZDR provider of ${model} at ${quantizations.join(", ")} (${[...embeddingProviders].join(", ") || "none listed"}), and ${inputs.length} vector(s) of ${dimensions} dimensions in one answer`,
    )
  }
  await embedded("embedding-query", [
    { kind: "query", text: "Which squares of the checkerboard are red?" },
  ])
  // One full batch of document chunks in one request, as the projection
  // sends them: this proves that a ZDR endpoint at an allowed quantization
  // takes a batch and the configured dimension.
  await embedded(
    "embedding-text-batch",
    Array.from({ length: batchSize }, (_, index) => ({
      kind: "text" as const,
      text: checkerboardSentence(index),
      documentTitle: "Checkerboard",
      chunkIndex: index,
      chunkCount: batchSize,
    })),
  )
  await refusalPair("embedding", NON_ZDR_EMBEDDING_MODEL, nonZdrEmbedding)

  // The vision model (CTX-1433) reads a made-up diagram of the vision eval
  // at a ZDR provider. The request of the client, sent to a model with no
  // ZDR endpoint, is refused when `zdr` is true.
  const image = {
    bytes: await readFile(
      new URL("./fixtures/vision/order-states.png", import.meta.url),
    ),
    mimeType: "image/png",
  }
  const visionModel = imageTextModel()
  const vision = await observe(calls, () =>
    readImage(image, { model: visionModel }),
  )
  const visionProviders = zdrProvidersOf(visionModel)
  check(
    "vision-read",
    vision,
    vision.status === 200 && visionProviders.has(vision.provider ?? ""),
    `HTTP 200 from ${visionModel} at a ZDR provider (${[...visionProviders].join(", ") || "none listed"})`,
  )
  await refusalPair("vision", NON_ZDR_VISION_MODEL, (zdr) =>
    withChangedBody(
      (body) => ({
        ...body,
        model: NON_ZDR_VISION_MODEL,
        provider: { ...jsonObject.parse(body.provider), zdr },
      }),
      () => readImage(image, { model: visionModel, backoffMs: 1 }),
    ),
  )
  return checks
}

/**
 * The `probe` command. It sends the calls through `calls`, and it writes
 * `probe.json` and `probe.md` to `out`. Returns the exit code: 0 all checks
 * pass, 3 the spend cap stopped a call, 4 a check failed.
 */
export async function probe(input: {
  out: string
  calls: ModelCalls
  capUsd: number
  /** `MODEL_PROVIDER_URL`, the base of the recorder. */
  base: string
}): Promise<number> {
  const { calls } = input
  // A failed read of the ZDR list is a failed check: then no provider is a
  // ZDR provider, and the other checks fail too.
  let zdrProvidersOf: ZdrProvidersOf = () => new Set()
  const listChecks: ProbeCheck[] = []
  try {
    zdrProvidersOf = await zdrProviders(input.base)
  } catch (error) {
    listChecks.push({
      name: "zdr-list",
      pass: false,
      status: null,
      provider: null,
      error: error instanceof Error ? error.message : String(error),
      expects: "the OpenRouter ZDR list (GET /endpoints/zdr) answers",
    })
  }
  const restore = calls.install()
  let checks: ProbeCheck[]
  try {
    checks = [...listChecks, ...(await probeChecks(calls, zdrProvidersOf))]
  } finally {
    restore()
  }
  const at = new Date().toISOString()
  const row = (values: (string | number | boolean | null)[]) =>
    `| ${values.map((value) => String(value ?? "—").replace(/\|/g, "\\|")).join(" | ")} |`
  const header = [
    "Check",
    "Result",
    "Status",
    "Provider",
    "Error",
    "Pass needs",
  ]
  const markdown = [
    `# Provider probe, ${at}`,
    "",
    row(header),
    row(header.map(() => "---")),
    ...checks.map((check) =>
      row([
        check.name,
        check.pass ? "pass" : "FAIL",
        check.status,
        check.provider,
        check.error,
        check.expects,
      ]),
    ),
    "",
    `Spent $${calls.spentUsd.toFixed(4)} of the cap $${input.capUsd}.${calls.stopped ? " The spend cap stopped a call." : ""}`,
    "",
  ].join("\n")
  const result = {
    at,
    capUsd: input.capUsd,
    spentUsd: calls.spentUsd,
    stopped: calls.stopped,
    checks,
  }
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
