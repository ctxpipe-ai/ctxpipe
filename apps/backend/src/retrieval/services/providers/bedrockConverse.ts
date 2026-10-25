import {
  BedrockRuntimeClient,
  type ConverseCommandInput,
  type Message,
} from "@aws-sdk/client-bedrock-runtime"
import { NodeHttpHandler } from "@smithy/node-http-handler"

import type { ModelParams } from "../modelParams.js"
import { resolveBedrockRegion } from "./bedrockRegion.js"
import type { ProviderCallEnv } from "./providerTypes.js"

function isNonEmptyRecord(value: Record<string, unknown>): boolean {
  return Object.keys(value).length > 0
}

/** Map canonical parameters to native Bedrock Converse fields. */
function lowerBedrockConverseParams(params: ModelParams | undefined):
  | {
      maxTokens?: number
      topP?: number
      additionalModelRequestFields?: Record<string, unknown>
    }
  | undefined {
  if (!params) return undefined

  const additionalModelRequestFields: Record<string, unknown> = {}
  let maxTokens: number | undefined
  let topP: number | undefined

  if (params.reasoning?.effort !== undefined) {
    additionalModelRequestFields.reasoning_effort = params.reasoning.effort
  }

  if (params.text?.verbosity !== undefined) {
    additionalModelRequestFields.verbosity = params.text.verbosity
  }

  if (params.sampling?.maxTokens !== undefined) {
    maxTokens = params.sampling.maxTokens
  }
  if (params.sampling?.topP !== undefined) {
    topP = params.sampling.topP
  }

  if (params.bedrock && isNonEmptyRecord(params.bedrock)) {
    Object.assign(additionalModelRequestFields, params.bedrock)
  }

  const out: {
    maxTokens?: number
    topP?: number
    additionalModelRequestFields?: Record<string, unknown>
  } = {}

  if (maxTokens !== undefined) out.maxTokens = maxTokens
  if (topP !== undefined) out.topP = topP
  if (isNonEmptyRecord(additionalModelRequestFields)) {
    out.additionalModelRequestFields = additionalModelRequestFields
  }

  return Object.keys(out).length > 0 ? out : undefined
}

export function createBedrockClient(env: ProviderCallEnv) {
  return new BedrockRuntimeClient({
    region: resolveBedrockRegion(env),
    maxAttempts: 3,
    requestHandler: new NodeHttpHandler(),
  })
}

export async function withBedrockClient<T>(
  env: ProviderCallEnv,
  run: (client: BedrockRuntimeClient) => Promise<T>,
): Promise<T> {
  const client = createBedrockClient(env)
  try {
    return await run(client)
  } finally {
    client.destroy()
  }
}

export function bedrockConverseInput(
  modelId: string,
  input: { role?: string; content: string }[],
  temperature?: number,
  modelParams?: ModelParams,
): ConverseCommandInput {
  const system: NonNullable<ConverseCommandInput["system"]> = []
  const messages: Message[] = []
  for (const message of input) {
    const block = { text: message.content }
    if (message.role === "system") {
      system.push(block)
      continue
    }
    const role = message.role === "assistant" ? "assistant" : "user"
    const last = messages.at(-1)
    if (last?.role === role) last.content?.push(block)
    else messages.push({ role, content: [block] })
  }
  const params = lowerBedrockConverseParams(modelParams)
  return {
    modelId,
    system: system.length ? system : undefined,
    messages,
    inferenceConfig: {
      temperature,
      maxTokens: params?.maxTokens,
      topP: params?.topP,
    },
    additionalModelRequestFields:
      params?.additionalModelRequestFields as ConverseCommandInput["additionalModelRequestFields"],
  }
}
