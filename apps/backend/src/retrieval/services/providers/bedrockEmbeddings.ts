import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime"

import { resolveBedrockRegion } from "./bedrockRegion.js"
import type { ProviderCallEnv } from "./providerTypes.js"

const TARGET_EMBEDDING_DIMENSIONS = 2000
/** Cohere Embed v4 on Bedrock supports up to 1536 output dimensions. */
const COHERE_EMBED_V4_MAX_DIMENSIONS = 1536

function padEmbeddingToTargetDimensions(embedding: number[]): number[] {
  if (embedding.length >= TARGET_EMBEDDING_DIMENSIONS) {
    return embedding.slice(0, TARGET_EMBEDDING_DIMENSIONS)
  }
  return [
    ...embedding,
    ...new Array(TARGET_EMBEDDING_DIMENSIONS - embedding.length).fill(0),
  ]
}

function parseCohereEmbedResponse(body: string): number[] {
  const parsed = JSON.parse(body) as {
    embeddings?: { float?: number[][] }
    embedding?: number[]
  }
  const fromEmbeddings = parsed.embeddings?.float?.[0]
  if (fromEmbeddings) return fromEmbeddings
  if (parsed.embedding) return parsed.embedding
  throw new Error("Bedrock embedding response missing embedding vector")
}

export async function invokeBedrockEmbedding(
  text: string,
  modelId: string,
  env: ProviderCallEnv,
): Promise<number[]> {
  const region = resolveBedrockRegion(env)
  const client = new BedrockRuntimeClient({ region })

  const requestBody: Record<string, unknown> = {
    texts: [text],
    input_type: "search_document",
    embedding_types: ["float"],
  }

  if (modelId.startsWith("cohere.embed")) {
    requestBody.output_dimension = COHERE_EMBED_V4_MAX_DIMENSIONS
  }

  const response = await client.send(
    new InvokeModelCommand({
      modelId,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify(requestBody),
    }),
  )

  const raw = response.body
  if (!raw) {
    throw new Error("Bedrock embedding response missing body")
  }

  const embedding = parseCohereEmbedResponse(
    typeof raw === "string" ? raw : new TextDecoder().decode(raw),
  )
  const normalized = padEmbeddingToTargetDimensions(embedding)

  if (normalized.length !== TARGET_EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Expected ${TARGET_EMBEDDING_DIMENSIONS} dimensions, got ${normalized.length}`,
    )
  }

  return normalized
}
