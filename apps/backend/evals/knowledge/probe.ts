import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { chat } from "@tanstack/ai"
import { z } from "zod"

import { COMMIT_SUBJECT_MODEL } from "../../src/domain/workspaces/commit-subject.js"
import {
  imageTextModel,
  readImage,
} from "../../src/knowledge-plane/image-text.js"
import {
  embedQuery,
  embedTexts,
  textEmbeddingConfig,
} from "../../src/retrieval/embeddings/textEmbeddings.js"
import { decideNoul, JEV_MODEL } from "../../src/retrieval/jev/client.js"
import {
  generateEmbeddings,
  getModel,
  modelCallSettings,
} from "../../src/retrieval/services/modelProvider.js"
import { modelNameShape } from "../../src/retrieval/services/modelTierSpecs.js"
import { providerAllowlist } from "../../src/retrieval/services/openRouterProvider.js"
import type { ModelCalls } from "./model-calls.js"

/*
 * The live provider probe (ADR-068 decision 7, ADR-063 decision 6, ADR-070).
 * Real calls confirm that the model provider applies the request settings
 * of the knowledge plane, and that each model in use answers from a
 * provider of the allowlist (`MODEL_PROVIDER_ALLOWLIST`). Each check sends its
 * request through the real client (`decideNoul`, `embedQuery`,
 * `embedTexts`), so the probe tests the request that production sends, not
 * a copy. The recorder of
 * the eval run (`ModelCalls`) keeps the status and the raw answer of each
 * call as evidence, and it applies the spend cap.
 *
 * The probe sends only fixed text that this repository holds. It never
 * sends customer data.
 */

/**
 * Put the `--setting NAME=VALUE` arguments of the probe into the
 * environment. The factory passes no setting but the key, so the allowlist
 * and the model names of the hosted stack come as arguments; the clients
 * read them from the environment, as in production (ADR-070). The URL and
 * the key are not settings: the key goes only to the provider that the code
 * names.
 */
export function applyProbeSettings(settings: readonly string[]): void {
  const names = ["MODEL_PROVIDER_ALLOWLIST", ...Object.keys(modelNameShape)]
  for (const setting of settings) {
    const [name = "", value = ""] = setting.split(/=(.*)/s)
    if (!names.includes(name) || !value)
      throw new Error(
        `--setting takes NAME=VALUE, with NAME one of ${names.join(", ")}. Got "${name}".`,
      )
    process.env[name] = value
  }
}

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

/**
 * The allowlist control (ADR-070): an embedding model that takes the
 * request of the plane client and whose only ZDR endpoint is at a provider
 * outside the hosted allowlist (on 2026-11-21: DeepInfra). If the catalog or
 * the allowlist changes, the control check fails and says so; then pick
 * another such model.
 */
const NOT_ALLOWED_EMBEDDING_MODEL = "qwen/qwen3-embedding-4b"

/** The provider names of the ZDR endpoints of a model (`zdrProviders`). */
type ZdrProvidersOf = (model: string) => Set<string>

/**
 * The provider names of the ZDR endpoints of each model, from the OpenRouter
 * ZDR list (`GET /api/v1/endpoints/zdr`). The model calls pin no provider, so a check
 * passes when the answer names one of these providers (ADR-068 decision 7).
 * The answer names only the provider, not its endpoint: when a provider has
 * more than one endpoint of a model, the name does not show which one served
 * the call. The `zdr` field of the request decides the endpoint, and the refusal pairs show that OpenRouter applies `zdr`. The
 * list holds no input of ours, so the call goes around the recorder.
 */
async function zdrProviders(base: string): Promise<ZdrProvidersOf> {
  const data = await readZdrList(base)
  return (model: string) =>
    new Set(
      data
        .filter((endpoint) => endpoint.model_id === model)
        .map((endpoint) => endpoint.provider_name),
    )
}

/**
 * The OpenRouter ZDR list (`GET /api/v1/endpoints/zdr`): each ZDR endpoint
 * with its model, provider and tag.
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
 * The model and `zdr` change. The dimension goes out too, so that the
 * control model can serve the request; both requests of the pair are the
 * same apart from `zdr`.
 */
const nonZdrEmbedding = (zdr: boolean) =>
  withChangedBody(
    ({ dimensions: _dimensions, ...body }) => ({
      ...body,
      model: NON_ZDR_EMBEDDING_MODEL,
      provider: { ...jsonObject.parse(body.provider), zdr },
    }),
    () => embedQuery("Is the sky blue?"),
  )

/** The checks of the probe, one after the other. */
async function probeChecks(
  calls: ModelCalls,
  zdrProvidersOf: ZdrProvidersOf,
  onList: OnList,
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
      jevProviders.has(served.provider ?? "") &&
      onList.has(served.provider),
    `HTTP 200, a yes/no answer, and a ZDR provider of ${JEV_MODEL} (${[...jevProviders].join(", ") || "none listed"})${onList.text}`,
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

  const { model, dimensions, maxBatchInputs } = textEmbeddingConfig
  const embeddingProviders = zdrProvidersOf(model)
  const embedded = async (
    name: string,
    count: number,
    embed: () => Promise<number[][]>,
  ) => {
    const evidence = await observe(calls, embed)
    check(
      name,
      evidence,
      evidence.status === 200 &&
        embeddingProviders.has(evidence.provider ?? "") &&
        onList.has(evidence.provider) &&
        evidence.vectors === count &&
        evidence.result?.length === count &&
        evidence.result.every((vector) => vector.length === dimensions),
      `HTTP 200, a ZDR provider of ${model} (${[...embeddingProviders].join(", ") || "none listed"})${onList.text}, and ${count} vector(s) of ${dimensions} dimensions in one answer`,
    )
  }
  await embedded("embedding-query", 1, async () => [
    await embedQuery("Which squares of the checkerboard are red?"),
  ])
  // One full batch of short document chunks in one request, as the
  // projection sends them: this proves that a ZDR endpoint takes a batch of
  // `maxBatchInputs` and the configured dimension.
  await embedded("embedding-text-batch", maxBatchInputs, () =>
    embedTexts(
      Array.from({ length: maxBatchInputs }, (_, index) => ({
        text: checkerboardSentence(index),
        documentTitle: "Checkerboard",
        chunkIndex: index,
        chunkCount: maxBatchInputs,
      })),
    ),
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
    vision.status === 200 &&
      visionProviders.has(vision.provider ?? "") &&
      onList.has(vision.provider),
    `HTTP 200 from ${visionModel} at a ZDR provider (${[...visionProviders].join(", ") || "none listed"})${onList.text}`,
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

  // The other models in use (ADR-070): each chat model of the tiers, the
  // fixed model of the commit subjects, and the embedding model of the
  // current stack, through the real clients. Each chat model goes out alone,
  // with no fallback model, so that a fallback cannot hide a model with no
  // endpoint at an allowed provider. The answer must name a provider of the
  // allowlist.
  const chatModels = new Map<string, string[]>()
  const use = (model: string, by: string) =>
    chatModels.set(model, [...(chatModels.get(model) ?? []), by])
  for (const tier of ["fast", "medium", "high"] as const)
    use(modelCallSettings(tier).callOpts.models[0] ?? "", `the ${tier} tier`)
  use(COMMIT_SUBJECT_MODEL, "the commit subjects")
  for (const [model, uses] of chatModels) {
    const answer = await observe(calls, () =>
      chat({
        adapter: getModel("fast", { model }),
        messages: [{ role: "user", content: "Answer with the word yes." }],
        stream: false,
      }),
    )
    check(
      `chat ${model}`,
      answer,
      answer.status === 200 && onList.has(answer.provider),
      `HTTP 200 from ${model} with no fallback model (${uses.join(", ")})${onList.text}`,
    )
  }
  const legacy = await observe(calls, () =>
    generateEmbeddings(["Which squares of the checkerboard are red?"]),
  )
  check(
    "embedding-current-stack",
    legacy,
    legacy.status === 200 &&
      legacy.result?.length === 1 &&
      onList.has(legacy.provider),
    `HTTP 200 and one vector from the embedding model of the current stack${onList.text}`,
  )

  // The allowlist proof: the query request of the plane client, sent to a
  // model with ZDR endpoints only outside the allowlist. With no `only`
  // field it must be served; with the allowlist it must be refused. The
  // two requests differ only in `only`, so the refusal proves that OpenRouter
  // applies the allowlist with fallback.
  const outside = (only: boolean) =>
    withChangedBody(
      (body) => {
        const { only: list, ...provider } = jsonObject.parse(body.provider)
        return {
          ...body,
          model: NOT_ALLOWED_EMBEDDING_MODEL,
          provider: only ? { ...provider, only: list } : provider,
        }
      },
      () => embedQuery("Is the sky blue?"),
    )
  const control = await observe(calls, () => outside(false))
  check(
    "allowlist-control-without-only",
    control,
    control.status === 200 && !onList.has(control.provider),
    `HTTP 200 from ${NOT_ALLOWED_EMBEDDING_MODEL} at a provider outside the allowlist when the request has no only list`,
  )
  const refused = await observe(calls, () => outside(true))
  check(
    "allowlist-refused-outside-list",
    refused,
    control.status === 200 &&
      onList.set &&
      refused.status === 404 &&
      /no (endpoints|allowed providers)/i.test(refused.error ?? ""),
    "the control passes, then HTTP 404 with a no-endpoint error when the request has the allowlist",
  )
  return checks
}

/**
 * The providers of the allowlist, by the name that an answer gives (the
 * `provider` field). `set` is false with no allowlist: then each provider
 * is on the list, and the check `provider-allowlist` fails.
 */
type OnList = {
  set: boolean
  has: (provider: string | null) => boolean
  text: string
}

/**
 * The allowlist of `MODEL_PROVIDER_ALLOWLIST` and the names of its
 * providers, from the OpenRouter provider list (`GET /api/v1/providers`).
 * An answer names its provider by name, not by slug.
 */
async function allowlistCheck(
  base: string,
): Promise<{ onList: OnList; check: ProbeCheck }> {
  const check = (pass: boolean, error: string | null): ProbeCheck => ({
    name: "provider-allowlist",
    pass,
    status: null,
    provider: null,
    error,
    expects:
      "MODEL_PROVIDER_ALLOWLIST is set (or given with --setting), and each slug is on the OpenRouter provider list (GET /providers)",
  })
  const any: OnList = { set: false, has: () => true, text: "" }
  let slugs: string[] | undefined
  try {
    slugs = providerAllowlist()
  } catch (error) {
    return { onList: any, check: check(false, (error as Error).message) }
  }
  if (!slugs)
    return {
      onList: any,
      check: check(false, "No allowlist is set: no provider was checked."),
    }
  const listed = await fetch(`${base.replace(/\/+$/, "")}/providers`)
    .then((response) => (response.ok ? response.json() : null))
    .then(
      (data) =>
        z
          .object({
            data: z.array(z.object({ name: z.string(), slug: z.string() })),
          })
          .safeParse(data).data?.data,
    )
    .catch(() => undefined)
  const names = new Set(
    (listed ?? [])
      .filter((provider) => slugs.includes(provider.slug))
      .map((provider) => provider.name),
  )
  const unknown = slugs.filter(
    (slug) => !listed?.some((provider) => provider.slug === slug),
  )
  const onList: OnList = {
    set: true,
    has: (provider) => provider !== null && names.has(provider),
    text: ` on the allowlist (${[...names].join(", ") || "none listed"})`,
  }
  return {
    onList,
    check: !listed
      ? check(false, "The OpenRouter provider list did not answer.")
      : check(
          unknown.length === 0,
          unknown.length
            ? `Not on the provider list: ${unknown.join(", ")}.`
            : null,
        ),
  }
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
  const allowlist = await allowlistCheck(input.base)
  const restore = calls.install()
  let checks: ProbeCheck[]
  try {
    checks = [
      ...listChecks,
      ...(await probeChecks(calls, zdrProvidersOf, allowlist.onList)),
      allowlist.check,
    ]
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
