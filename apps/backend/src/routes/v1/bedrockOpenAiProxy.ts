import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages"
import type { BaseMessage } from "@langchain/core/messages"
import { ChatBedrockConverse } from "@langchain/aws"

import type { AppEnv } from "../../app/env.js"
import { invokeBedrockEmbedding } from "../../retrieval/services/providers/bedrockEmbeddings.js"
import { lowerBedrockConverseParams } from "../../retrieval/services/providers/bedrockModelProvider.js"
import {
  modelParamsFromSpec,
  modelSpecBase,
} from "../../retrieval/services/parseModelSpec.js"
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

function openAiMessagesToLangChain(messages: unknown[]): BaseMessage[] {
  return messages.map((raw) => {
    const message = raw as { role?: string; content?: unknown }
    const content =
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content ?? "")
    switch (message.role) {
      case "system":
        return new SystemMessage(content)
      case "assistant":
        return new AIMessage(content)
      default:
        return new HumanMessage(content)
    }
  })
}

function createBedrockChatModel(
  env: AppEnv["Variables"]["env"],
  modelId: string,
  tierSpec: string | undefined,
  temperature?: number,
): ChatBedrockConverse {
  const region = resolveBedrockRegion({
    MODEL_BEDROCK_AWS_REGION: env.MODEL_BEDROCK_AWS_REGION,
    AWS_REGION: process.env.AWS_REGION,
    AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION,
  })
  const converseParams = lowerBedrockConverseParams(
    tierSpec ? modelParamsFromSpec(tierSpec) : undefined,
  )

  return new ChatBedrockConverse({
    model: modelId,
    region,
    streaming: true,
    ...(temperature !== undefined ? { temperature } : {}),
    ...(converseParams?.maxTokens !== undefined
      ? { maxTokens: converseParams.maxTokens }
      : {}),
    ...(converseParams?.topP !== undefined ? { topP: converseParams.topP } : {}),
    ...(converseParams?.additionalModelRequestFields
      ? {
          additionalModelRequestFields:
            converseParams.additionalModelRequestFields,
        }
      : {}),
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

function chunkContent(chunk: AIMessageChunk): string {
  if (typeof chunk.content === "string") return chunk.content
  if (Array.isArray(chunk.content)) {
    return chunk.content
      .map((part) => {
        if (typeof part === "string") return part
        if (part && typeof part === "object" && "text" in part) {
          return String((part as { text?: unknown }).text ?? "")
        }
        return ""
      })
      .join("")
  }
  return String(chunk.content ?? "")
}

async function streamOpenAiChatCompletion(
  model: ChatBedrockConverse,
  messages: BaseMessage[],
  modelName: string,
): Promise<Response> {
  const stream = await model.stream(messages)
  const encoder = new TextEncoder()
  const completionId = `chatcmpl-${crypto.randomUUID()}`

  const body = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of stream) {
          const content = chunkContent(chunk as AIMessageChunk)
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

  const tierSpec = resolveTierSpecForModel(env, modelName)
  const chat = createBedrockChatModel(
    env,
    modelName,
    tierSpec,
    typeof body.temperature === "number" ? body.temperature : undefined,
  )
  const messages = openAiMessagesToLangChain(
    Array.isArray(body.messages) ? body.messages : [],
  )

  if (body.stream === true) {
    return streamOpenAiChatCompletion(chat, messages, modelName)
  }

  const result = await chat.invoke(messages)
  const content =
    typeof result.content === "string"
      ? result.content
      : JSON.stringify(result.content ?? "")

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
