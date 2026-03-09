import { parseEnv } from "../../config/env.js"

const EMBEDDING_MODEL = "qwen3-embedding"
const EMBEDDING_DIMENSIONS = 4096

function getOllamaUrl(): string {
  const env = parseEnv(process.env as Record<string, string | undefined>)
  return env.OLLAMA_URL ?? "http://localhost:11434"
}

/**
 * Generates a 4096-dimensional embedding for text using Qwen3 Embedding 8B via Ollama.
 * Returns empty array if Ollama is not configured or request fails.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const url = getOllamaUrl()
  const res = await fetch(`${url}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text,
      dimensions: EMBEDDING_DIMENSIONS,
    }),
  })

  if (!res.ok) {
    throw new Error(
      `Ollama embedding failed: ${res.status} ${await res.text()}`,
    )
  }

  const data = (await res.json()) as {
    embeddings?: number[][]
    embedding?: number[]
  }

  const embedding =
    data.embeddings?.[0] ?? data.embedding ?? ([] as number[])

  if (embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Expected ${EMBEDDING_DIMENSIONS} dimensions, got ${embedding.length}`,
    )
  }

  return embedding
}
