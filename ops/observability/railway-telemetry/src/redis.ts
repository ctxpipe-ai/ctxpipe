import { parseWatermark, type OtlpMetricsRequest, type WatermarkMarks } from "./otlp"
import { parseRedisInfo, redisSnapshotToOtlp } from "./redisInfo"

type RedisClientLike = {
  send: (command: string, args: string[]) => Promise<unknown>
  close: () => void
}

export const METRICS_WATERMARK_KEY = "railway-telemetry:watermark:metrics"
export const LOGS_WATERMARK_KEY = "railway-telemetry:watermark:logs"

export async function fetchRedisInfo(redisUrl: string, timeoutMs = 10_000): Promise<string> {
  const result = await withRedis(redisUrl, timeoutMs, "Redis INFO timed out", (client) => client.send("INFO", []))
  return infoText(result)
}

export type StoredWatermarks = WatermarkMarks & { invalidKeys: string[] }

/** GET both marks. A missing key is null. Throws when Redis cannot be reached. */
export async function readWatermarks(redisUrl: string, timeoutMs = 10_000): Promise<StoredWatermarks> {
  return withRedis(redisUrl, timeoutMs, "Redis watermark read timed out", async (client) => {
    const metrics = storedMark(METRICS_WATERMARK_KEY, bulkString(await client.send("GET", [METRICS_WATERMARK_KEY])))
    const logs = storedMark(LOGS_WATERMARK_KEY, bulkString(await client.send("GET", [LOGS_WATERMARK_KEY])))
    return {
      metrics: metrics.value,
      logs: logs.value,
      invalidKeys: [metrics, logs].flatMap((parsed) => (parsed.invalidKey ? [parsed.invalidKey] : [])),
    }
  })
}

export async function writeWatermark(
  redisUrl: string,
  key: string,
  unixSeconds: number,
  timeoutMs = 10_000,
): Promise<void> {
  await withRedis(redisUrl, timeoutMs, "Redis watermark write timed out", (client) =>
    client.send("SET", [key, String(unixSeconds)]),
  )
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

async function withRedis<T>(
  redisUrl: string,
  timeoutMs: number,
  timeoutMessage: string,
  fn: (client: RedisClientLike) => Promise<T>,
): Promise<T> {
  const url = new URL(redisUrl)
  if (url.protocol !== "redis:") throw new Error(`unsupported Redis URL protocol ${url.protocol}`)
  if (!url.hostname) throw new Error("REDIS_URL is missing a host")

  const client = new Bun.RedisClient(redisUrl) as RedisClientLike
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      fn(client),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
    try {
      client.close()
    } catch {
      // The socket may already be closed after a failed connect.
    }
  }
}

function bulkString(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === "string") return value
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value)
  if (value instanceof Uint8Array) return new TextDecoder().decode(value)
  throw new Error("Redis GET returned an unexpected payload")
}

function storedMark(key: string, raw: string | null): { value: number | null; invalidKey: string | null } {
  const parsed = parseWatermark(raw)
  if (!parsed.ok) return { value: null, invalidKey: key }
  return { value: parsed.value, invalidKey: null }
}
