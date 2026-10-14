import {
  BedrockRuntimeClient,
  type ContentBlock,
  ConverseCommand,
  type ConverseCommandInput,
  ConverseStreamCommand,
  type Message,
} from "@aws-sdk/client-bedrock-runtime"
import { NodeHttpHandler } from "@smithy/node-http-handler"

import type { AppEnv } from "../../app/env.js"
import {
  modelParamsFromSpec,
  modelSpecBase,
} from "../../retrieval/services/parseModelSpec.js"
import { invokeBedrockEmbedding } from "../../retrieval/services/providers/bedrockEmbeddings.js"
import { lowerBedrockConverseParams } from "../../retrieval/services/providers/bedrockModelProvider.js"
import { resolveBedrockRegion } from "../../retrieval/services/providers/bedrockRegion.js"

type OpenAiChatBody = {
  model?: string
  messages?: unknown[]
  stream?: boolean
  temperature?: number
}

type OpenAiEmbeddingBody = {
  model?: string
  input?: unknown
}

function configuredChatModelSpecs(env: AppEnv["Variables"]["env"]): string[] {
  return [
    env.MODEL_FAST_NAME,
    env.MODEL_MEDIUM_NAME,
    env.MODEL_HIGH_NAME,
  ].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  )
}

function resolveTierSpecForModel(
  env: AppEnv["Variables"]["env"],
  requestedModel: string,
): string | undefined {
  const requestedBase = modelSpecBase(requestedModel)
  return configuredChatModelSpecs(env).find(
    (spec) => modelSpecBase(spec) === requestedBase,
  )
}

/** Converse takes system text apart, and merges consecutive messages of one role. */
function openAiMessagesToConverse(messages: unknown[]): {
  system: ConverseCommandInput["system"]
  messages: Message[]
} {
  const system: NonNullable<ConverseCommandInput["system"]> = []
  const converse: Message[] = []
  for (const raw of messages) {
    const message = raw as { role?: string; content?: unknown }
    const text =
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content ?? "")
    if (message.role === "system") {
      system.push({ text })
      continue
    }
    const role = message.role === "assistant" ? "assistant" : "user"
    const block: ContentBlock = { text }
    const last = converse.at(-1)
    if (last?.role === role) last.content?.push(block)
    else converse.push({ role, content: [block] })
  }
  return { system: system.length > 0 ? system : undefined, messages: converse }
}

/** The Converse request for one OpenAI chat body, with the tier's sampling settings. */
function converseInput(
  modelId: string,
  tierSpec: string | undefined,
  body: OpenAiChatBody,
): ConverseCommandInput {
  const params = lowerBedrockConverseParams(
    tierSpec ? modelParamsFromSpec(tierSpec) : undefined,
  )
  const { system, messages } = openAiMessagesToConverse(
    Array.isArray(body.messages) ? body.messages : [],
  )
  return {
    modelId,
    system,
    messages,
    inferenceConfig: {
      ...(typeof body.temperature === "number"
        ? { temperature: body.temperature }
        : {}),
      ...(params?.maxTokens !== undefined
        ? { maxTokens: params.maxTokens }
        : {}),
      ...(params?.topP !== undefined ? { topP: params.topP } : {}),
    },
    ...(params?.additionalModelRequestFields
      ? {
          additionalModelRequestFields:
            params.additionalModelRequestFields as ConverseCommandInput["additionalModelRequestFields"],
        }
      : {}),
  }
}

function bedrockClient(env: AppEnv["Variables"]["env"]) {
  return new BedrockRuntimeClient({
    region: resolveBedrockRegion({
      MODEL_BEDROCK_AWS_REGION: env.MODEL_BEDROCK_AWS_REGION,
      AWS_REGION: process.env.AWS_REGION,
      AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION,
    }),
    // Node transport on every runtime, so each call sends one plain HTTP request.
    requestHandler: new NodeHttpHandler(),
  })
}

function toOpenAiChatCompletion(
  model: string,
  content: string,
): Record<string, unknown> {
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
  }
}

async function streamOpenAiChatCompletion(
  client: BedrockRuntimeClient,
  input: ConverseCommandInput,
  modelName: string,
): Promise<Response> {
  const { stream } = await client
    .send(new ConverseStreamCommand(input))
    .catch((err) => {
      client.destroy()
      throw err
    })
  const encoder = new TextEncoder()
  const completionId = `chatcmpl-${crypto.randomUUID()}`

  const body = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of stream ?? []) {
          const content = event.contentBlockDelta?.delta?.text
          if (!content) continue
          const payload = {
            id: completionId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: modelName,
            choices: [{ index: 0, delta: { content }, finish_reason: null }],
          }
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
          )
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"))
        controller.close()
      } catch (err) {
        controller.error(err)
      } finally {
        client.destroy()
      }
    },
  })

  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  })
}

export async function handleBedrockChatCompletion(
  env: AppEnv["Variables"]["env"],
  body: OpenAiChatBody,
): Promise<Response> {
  const modelName =
    typeof body.model === "string" ? modelSpecBase(body.model) : ""
  if (!modelName) {
    return Response.json({ error: "model is required" }, { status: 400 })
  }

  const input = converseInput(
    modelName,
    resolveTierSpecForModel(env, modelName),
    body,
  )
  const client = bedrockClient(env)

  if (body.stream === true) {
    return streamOpenAiChatCompletion(client, input, modelName)
  }

  const result = await client
    .send(new ConverseCommand(input))
    .finally(() => client.destroy())
  const content = (result.output?.message?.content ?? [])
    .map((part) => part.text ?? "")
    .join("")

  return Response.json(toOpenAiChatCompletion(modelName, content))
}

export async function handleBedrockEmbedding(
  env: AppEnv["Variables"]["env"],
  body: OpenAiEmbeddingBody,
): Promise<Response> {
  const embeddingSpec =
    typeof env.MODEL_EMBEDDING_NAME === "string" &&
    env.MODEL_EMBEDDING_NAME.length > 0
      ? env.MODEL_EMBEDDING_NAME
      : undefined
  const modelId =
    typeof body.model === "string"
      ? modelSpecBase(body.model)
      : embeddingSpec
        ? modelSpecBase(embeddingSpec)
        : ""

  if (!modelId) {
    return Response.json({ error: "model is required" }, { status: 400 })
  }

  const input = body.input
  const text =
    typeof input === "string"
      ? input
      : Array.isArray(input)
        ? input.map(String).join("\n")
        : String(input ?? "")

  const embedding = await invokeBedrockEmbedding(text, modelId, {
    MODEL_BEDROCK_AWS_REGION: env.MODEL_BEDROCK_AWS_REGION,
    AWS_REGION: process.env.AWS_REGION,
    AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION,
  })

  return Response.json({
    object: "list",
    data: [{ object: "embedding", embedding, index: 0 }],
    model: modelId,
    usage: { prompt_tokens: 0, total_tokens: 0 },
  })
}
