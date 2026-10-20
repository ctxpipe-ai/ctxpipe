import {
  type BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandInput,
  ConverseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime"

import type { AppEnv } from "../../app/env.js"
import {
  modelParamsFromSpec,
  modelSpecBase,
} from "../../retrieval/services/parseModelSpec.js"
import {
  bedrockConverseInput,
  createBedrockClient,
  withBedrockClient,
} from "../../retrieval/services/providers/bedrockConverse.js"
import { invokeBedrockEmbedding } from "../../retrieval/services/providers/bedrockEmbeddings.js"

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

function openAiFinishReason(stopReason: string | undefined): "length" | "stop" {
  return stopReason === "max_tokens" ? "length" : "stop"
}

function toOpenAiChatCompletion(
  model: string,
  content: string,
  stopReason?: string,
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
        finish_reason: openAiFinishReason(stopReason),
      },
    ],
  }
}

async function streamOpenAiChatCompletion(
  client: BedrockRuntimeClient,
  input: ConverseCommandInput,
  modelName: string,
  signal?: AbortSignal,
): Promise<Response> {
  const { stream } = await client
    .send(new ConverseStreamCommand(input), { abortSignal: signal })
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
          if (!content && !event.messageStop) continue
          const payload = {
            id: completionId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: modelName,
            choices: [
              {
                index: 0,
                delta: content ? { content } : {},
                finish_reason: event.messageStop
                  ? openAiFinishReason(event.messageStop.stopReason)
                  : null,
              },
            ],
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
  signal?: AbortSignal,
): Promise<Response> {
  const modelName =
    typeof body.model === "string" ? modelSpecBase(body.model) : ""
  if (!modelName) {
    return Response.json({ error: "model is required" }, { status: 400 })
  }

  const tierSpec = resolveTierSpecForModel(env, modelName)
  const input = bedrockConverseInput(
    modelName,
    (Array.isArray(body.messages) ? body.messages : []).map((raw) => {
      const message = raw as { role?: string; content?: unknown }
      return {
        role: message.role,
        content:
          typeof message.content === "string"
            ? message.content
            : JSON.stringify(message.content ?? ""),
      }
    }),
    body.temperature,
    tierSpec ? modelParamsFromSpec(tierSpec) : undefined,
  )
  const clientEnv = {
    MODEL_BEDROCK_AWS_REGION: env.MODEL_BEDROCK_AWS_REGION,
    AWS_REGION: process.env.AWS_REGION,
    AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION,
  }
  if (body.stream === true) {
    return streamOpenAiChatCompletion(
      createBedrockClient(clientEnv),
      input,
      modelName,
      signal,
    )
  }
  const result = await withBedrockClient(clientEnv, (client) =>
    client.send(new ConverseCommand(input), { abortSignal: signal }),
  )
  const content = (result.output?.message?.content ?? [])
    .map((part) => part.text ?? "")
    .join("")

  return Response.json(
    toOpenAiChatCompletion(modelName, content, result.stopReason),
  )
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
