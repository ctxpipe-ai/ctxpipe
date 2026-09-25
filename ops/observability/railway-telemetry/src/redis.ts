import type { OtlpMetricsRequest } from "./otlp"
import { parseRedisInfo, redisSnapshotToOtlp } from "./redisInfo"

type RedisClientLike = {
  send: (command: string, args: string[]) => Promise<unknown>
  close: () => void
}

export async function fetchRedisInfo(redisUrl: string, timeoutMs = 10_000): Promise<string> {
  const url = new URL(redisUrl)
  if (url.protocol !== "redis:") throw new Error(`unsupported Redis URL protocol ${url.protocol}`)
  if (!url.hostname) throw new Error("REDIS_URL is missing a host")

  const client = new Bun.RedisClient(redisUrl) as RedisClientLike
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      client.send("INFO", []),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Redis INFO timed out")), timeoutMs)
      }),
    ])
    return infoText(result)
  } finally {
    if (timer) clearTimeout(timer)
    try {
      client.close()
    } catch {
      // The socket may already be closed after a failed connect.
    }
  }
}

export async function collectRedisMetrics(redisUrl: string, timeUnixNano: string): Promise<OtlpMetricsRequest> {
  const text = await fetchRedisInfo(redisUrl)
  return redisSnapshotToOtlp(parseRedisInfo(text), timeUnixNano)
}

function infoText(value: unknown): string {
  if (typeof value === "string") return value
  if (value instanceof Uint8Array) return new TextDecoder().decode(value)
  throw new Error("Redis INFO returned an unexpected payload")
}
