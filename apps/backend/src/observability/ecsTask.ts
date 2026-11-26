import { setTimeout as sleep } from "node:timers/promises"

let cached: { uri: string; taskId: Promise<string | undefined> } | undefined

/**
 * The id of the ECS task that runs this process, from the task metadata
 * endpoint (`ECS_CONTAINER_METADATA_URI_V4`). It is the last part of the
 * task ARN, and the name of the CloudWatch log stream of the task. Undefined
 * outside ECS, when the endpoint gives no ARN, or when it does not answer
 * within 60 seconds.
 */
export function ecsTaskId(): Promise<string | undefined> {
  const uri = process.env.ECS_CONTAINER_METADATA_URI_V4?.trim()
  if (!uri) return Promise.resolve(undefined)
  if (cached?.uri !== uri) cached = { uri, taskId: readTaskId(uri) }
  return cached.taskId
}

/**
 * Each request has a 2-second timeout. A failed request is sent again, so a
 * blocked event loop does not lose the id: the OpenWorkflow CLI compiles the
 * worker's modules synchronously for 20 to 30 seconds after `register.ts`
 * sends the first request, and then the timeout fires before Node reads the
 * response (CTX-1705).
 */
async function readTaskId(uri: string): Promise<string | undefined> {
  const deadline = Date.now() + 60_000
  for (;;) {
    try {
      const response = await fetch(`${uri.replace(/\/$/, "")}/task`, {
        signal: AbortSignal.timeout(2_000),
      })
      if (!response.ok) return undefined
      const { TaskARN } = (await response.json()) as { TaskARN?: unknown }
      if (typeof TaskARN !== "string") return undefined
      return TaskARN.split("/").pop() || undefined
    } catch {
      if (Date.now() >= deadline) return undefined
      await sleep(1_000)
    }
  }
}
