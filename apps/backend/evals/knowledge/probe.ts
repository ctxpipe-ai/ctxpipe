import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { z } from "zod"

import {
  type EmbeddingInput,
  embedMultimodal,
  multimodalEmbeddingConfig,
} from "../../src/retrieval/embeddings/multimodalEmbeddings.js"
import { decideNoul, JEV_PROVIDER } from "../../src/retrieval/jev/client.js"
import type { ModelCalls } from "./model-calls.js"

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
const NON_ZDR_DECISIONS = {
  model: "openai/gpt-6-luna-decisions",
  provider: "openai",
}

/**
 * The name that the `provider` field of an answer gives to each pinned
 * provider slug (the `provider_name` of its endpoints in
 * `GET /api/v1/models/{model}/endpoints`). The `google-ai-studio` endpoint of
 * the embedding model, which is not on the ZDR list, has another name
 * ("Google AI Studio").
 */
const PROVIDER_NAMES: Record<string, string> = {
  [JEV_PROVIDER]: "TypeSafe",
  [multimodalEmbeddingConfig.upstreamProvider]: "Google",
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
  /** The `model` field of the answer. */
  model: string | null
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
      model: null,
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
    model: answer.model ?? null,
    vectors: answer.data?.length ?? null,
    error: errors.length > 0 ? errors.join(" Provider: ") : null,
  }
}

const jsonObject = z.record(z.string(), z.unknown())

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
 * the model, the pinned provider and `zdr` change.
 */
const nonZdrDecision = (zdr: boolean) =>
  withChangedBody(
    (body) => ({
      ...body,
      model: NON_ZDR_DECISIONS.model,
      provider: {
        ...jsonObject.parse(body.provider),
        order: [NON_ZDR_DECISIONS.provider],
        zdr,
      },
    }),
    () => decideNoul(["The sky is green."], jevQuestion, jevOptions),
  )

/** The checks of the probe, one after the other. */
async function probeChecks(
  calls: ModelCalls,
  image: Uint8Array,
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
  check(
    "decisions-pinned",
    served,
    served.result !== undefined &&
      served.status === 200 &&
      served.provider === PROVIDER_NAMES[JEV_PROVIDER],
    `HTTP 200, a yes/no answer, and the provider ${PROVIDER_NAMES[JEV_PROVIDER]}`,
  )

  // The ZDR proof is a pair of requests to a Decisions model that has no ZDR
  // endpoint. Both are the request of the client, pinned to that model's one
  // provider with no fallback, and with `data_collection: "deny"`. They differ
  // only in `zdr`. The control (`zdr: false`) must be served: this shows that
  // the endpoint can serve the request. The same request with `zdr: true`
  // must then be refused with "no endpoint". Thus the refusal comes from
  // `zdr` alone: the Decisions endpoint enforces it. The Jev request has the
  // same provider block, so it can only go to a ZDR endpoint.
  const control = await observe(calls, () => nonZdrDecision(false))
  check(
    "decisions-control-without-zdr",
    control,
    control.status === 200,
    `HTTP 200 from ${NON_ZDR_DECISIONS.model} (no ZDR endpoint) when zdr is false`,
  )
  const refused = await observe(calls, () => nonZdrDecision(true))
  check(
    "decisions-refused-without-zdr-endpoint",
    refused,
    control.status === 200 &&
      refused.status === 404 &&
      /no (endpoints|allowed providers)/i.test(refused.error ?? ""),
    "the control passes, then HTTP 404 with a no-endpoint error when zdr is true",
  )

  const dimensions = multimodalEmbeddingConfig.dimensions
  const pinned = PROVIDER_NAMES[multimodalEmbeddingConfig.upstreamProvider]
  const embedded = async (name: string, inputs: EmbeddingInput[]) => {
    const evidence = await observe(calls, () => embedMultimodal(inputs))
    check(
      name,
      evidence,
      evidence.status === 200 &&
        evidence.provider === pinned &&
        evidence.result?.length === inputs.length &&
        evidence.result.every((vector) => vector.length === dimensions),
      `HTTP 200, the provider ${pinned}, and ${inputs.length} vector(s) of ${dimensions} dimensions`,
    )
  }
  await embedded("embedding-image", [
    { kind: "image", bytes: image, mimeType: "image/png" },
  ])
  await embedded("embedding-text", [
    { kind: "query", text: "A red and blue checkerboard." },
  ])
  // 16 document chunks in one call, as the projection sends them. With more
  // than one input in a request, OpenRouter found no ZDR endpoint
  // (2026-11-20), so this check guards the shape of the requests.
  const chunkCount = 16
  await embedded(
    "embedding-text-batch",
    Array.from({ length: chunkCount }, (_, index) => ({
      kind: "text" as const,
      text: checkerboardSentence(index),
      documentTitle: "Checkerboard",
      chunkIndex: index,
      chunkCount,
    })),
  )
  return checks
}

/**
 * Write the report of a probe command: `NAME.json` and `NAME.md` in `out`,
 * and the Markdown to stdout. The Markdown has `title`, a table, and the
 * spend.
 */
async function writeReport(input: {
  out: string
  name: string
  title: string
  calls: ModelCalls
  capUsd: number
  items: Record<string, unknown>
  header: string[]
  rows: (string | number | boolean | null)[][]
}): Promise<void> {
  const { calls } = input
  const at = new Date().toISOString()
  const result = {
    at,
    capUsd: input.capUsd,
    spentUsd: calls.spentUsd,
    stopped: calls.stopped,
    ...input.items,
  }
  const row = (values: (string | number | boolean | null)[]) =>
    `| ${values.map((value) => String(value ?? "—").replace(/\|/g, "\\|")).join(" | ")} |`
  const markdown = [
    `# ${input.title}, ${at}`,
    "",
    row(input.header),
    row(input.header.map(() => "---")),
    ...input.rows.map(row),
    "",
    `Spent $${calls.spentUsd.toFixed(4)} of the cap $${input.capUsd}.${calls.stopped ? " The spend cap stopped a call." : ""}`,
    "",
  ].join("\n")
  await mkdir(input.out, { recursive: true })
  await writeFile(
    join(input.out, `${input.name}.json`),
    `${JSON.stringify(result, null, 2)}\n`,
  )
  await writeFile(join(input.out, `${input.name}.md`), markdown)
  process.stdout.write(markdown)
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
}): Promise<number> {
  const { calls } = input
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
  await writeReport({
    ...input,
    name: "probe",
    title: "Provider probe",
    items: { checks },
    header: ["Check", "Result", "Status", "Provider", "Error", "Pass needs"],
    rows: checks.map((check) => [
      check.name,
      check.pass ? "pass" : "FAIL",
      check.status,
      check.provider,
      check.error,
      check.expects,
    ]),
  })
  if (calls.stopped) return 3
  return checks.every((check) => check.pass) ? 0 : 4
}

/**
 * The `probe --controls` command: the control requests of the batch finding
 * (2026-11-20). A request with 16 inputs, `zdr: true` and the
 * `google-vertex` pin got "No endpoints found matching your data policy
 * (Zero data retention)", and one input passed. Each control changes one
 * thing of that request: `zdr`, the input shape, the input count, the pin
 * (also to each endpoint tag of the model), and the model (the `:batch`
 * variant and the other candidates). These are experiments, so they send
 * hand-written bodies to `{base}/embeddings`, not the request of the client.
 * The inputs are fixed public texts only. The controls have no pass or fail.
 * It writes `controls.json` and `controls.md` to `out`. Returns the exit
 * code: 0 done, 3 the spend cap stopped a call.
 */
export async function probeControls(input: {
  out: string
  calls: ModelCalls
  capUsd: number
  /** `MODEL_PROVIDER_URL`, the base of the recorder. */
  base: string
}): Promise<number> {
  const { calls } = input
  const { model, upstreamProvider, dimensions } = multimodalEmbeddingConfig
  const texts = (count: number) =>
    Array.from({ length: count }, (_, index) => checkerboardSentence(index))
  const multimodal = (count: number) =>
    texts(count).map((text) => ({ content: [{ type: "text", text }] }))
  /** Pinned to `provider` with no fallback. */
  const pinned = (zdr: boolean, provider = upstreamProvider) => ({
    data_collection: "deny",
    order: [provider],
    allow_fallbacks: false,
    zdr,
  })
  const unpinned = (zdr: boolean) => ({
    data_collection: "deny",
    allow_fallbacks: true,
    zdr,
  })
  const gemini = { model, dimensions, encoding_format: "float" }
  const geminiBatch = { ...gemini, model: `${model}:batch` }
  const requests: [name: string, question: string, body: object][] = [
    [
      "gemini-16-multimodal-zdr",
      "The finding again: 16 multimodal items, pin google-vertex, zdr true.",
      { ...gemini, input: multimodal(16), provider: pinned(true) },
    ],
    [
      "gemini-1-multimodal-zdr",
      "1 multimodal item, pin google-vertex, zdr true.",
      { ...gemini, input: multimodal(1), provider: pinned(true) },
    ],
    [
      "gemini-16-multimodal-no-zdr",
      "Is ZDR the cause? 16 multimodal items, pin google-vertex, zdr false.",
      { ...gemini, input: multimodal(16), provider: pinned(false) },
    ],
    [
      "gemini-16-multimodal-no-zdr-no-pin",
      "Which endpoint takes a batch? 16 multimodal items, no pin, zdr false.",
      { ...gemini, input: multimodal(16), provider: unpinned(false) },
    ],
    [
      "gemini-16-strings-zdr",
      "Is it our shape? 16 plain strings, pin google-vertex, zdr true.",
      { ...gemini, input: texts(16), provider: pinned(true) },
    ],
    [
      "gemini-2-multimodal-zdr",
      "Is it the size? 2 multimodal items, pin google-vertex, zdr true.",
      { ...gemini, input: multimodal(2), provider: pinned(true) },
    ],
    [
      "gemini-4-multimodal-zdr",
      "Is it the size? 4 multimodal items, pin google-vertex, zdr true.",
      { ...gemini, input: multimodal(4), provider: pinned(true) },
    ],
    [
      "gemini-16-multimodal-zdr-no-pin",
      "Is it the pin? 16 multimodal items, no pin, zdr true.",
      { ...gemini, input: multimodal(16), provider: unpinned(true) },
    ],
    ...(["google-vertex/us", "google-vertex/global"] as const).flatMap(
      (tag): [string, string, object][] =>
        [true, false].map((zdr) => [
          `gemini-16-multimodal-${zdr ? "zdr" : "no-zdr"}-${tag.replace("/", "-")}`,
          `Does the endpoint ${tag} take a batch? 16 multimodal items, pin ${tag}, zdr ${zdr}.`,
          { ...gemini, input: multimodal(16), provider: pinned(zdr, tag) },
        ]),
    ),
    [
      "gemini-16-multimodal-no-zdr-google-ai-studio",
      "Does the endpoint google-ai-studio (not ZDR) take a batch? 16 multimodal items, pin google-ai-studio, zdr false.",
      {
        ...gemini,
        input: multimodal(16),
        provider: pinned(false, "google-ai-studio"),
      },
    ],
    [
      "gemini-batch-16-multimodal-zdr",
      `The batch model: ${geminiBatch.model}, 16 multimodal items, zdr true.`,
      { ...geminiBatch, input: multimodal(16), provider: unpinned(true) },
    ],
    [
      "gemini-batch-16-multimodal-no-zdr",
      `The batch model: ${geminiBatch.model}, 16 multimodal items, zdr false.`,
      { ...geminiBatch, input: multimodal(16), provider: unpinned(false) },
    ],
    [
      "titan-16-strings-zdr",
      "Another ZDR candidate: Titan Multimodal G1, 16 plain strings, pin amazon-bedrock, zdr true.",
      {
        model: "amazon/titan-embed-image-v1",
        input: texts(16),
        provider: pinned(true, "amazon-bedrock"),
      },
    ],
    [
      "openai-3-large-16-strings-zdr",
      "A text model: openai/text-embedding-3-large, 16 plain strings, no pin, zdr true.",
      {
        model: "openai/text-embedding-3-large",
        input: texts(16),
        provider: unpinned(true),
      },
    ],
    // The text space (CTX-1431): does a text-only model take a batch on a
    // ZDR endpoint? Each endpoint tag is pinned with no fallback.
    ...(
      [
        ["qwen/qwen3-embedding-8b", "deepinfra/us"],
        ["qwen/qwen3-embedding-8b", "nebius/bf16"],
        ["openai/text-embedding-3-small", "azure"],
      ] as const
    ).flatMap(([textModel, tag]): [string, string, object][] =>
      [16, 64].map((count) => [
        `${textModel.split("/")[1]}-${count}-strings-zdr-${tag.replace("/", "-")}`,
        `Does ${textModel} on ${tag} take a batch? ${count} plain strings, pin ${tag}, zdr true.`,
        {
          model: textModel,
          input: texts(count),
          encoding_format: "float",
          provider: pinned(true, tag),
        },
      ]),
    ),
  ]
  const url = `${input.base.replace(/\/+$/, "")}/embeddings`
  const restore = calls.install()
  const controls: (Evidence<Response> & { name: string; question: string })[] =
    []
  try {
    for (const [name, question, body] of requests)
      controls.push({
        name,
        question,
        ...(await observe(calls, () =>
          fetch(url, {
            method: "POST",
            headers: {
              authorization: `Bearer ${process.env.MODEL_PROVIDER_API_KEY}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
          }),
        )),
      })
  } finally {
    restore()
  }
  await writeReport({
    ...input,
    name: "controls",
    title: "Provider probe controls",
    items: {
      controls: controls.map(({ result: _response, ...control }) => control),
    },
    header: [
      "Control",
      "Question",
      "Status",
      "Provider",
      "Model",
      "Error",
      "Vectors",
    ],
    rows: controls.map((control) => [
      control.name,
      control.question,
      control.status,
      control.provider,
      control.model,
      control.error,
      control.vectors,
    ]),
  })
  return calls.stopped ? 3 : 0
}
