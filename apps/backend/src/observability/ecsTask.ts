let cached: { uri: string; taskId: Promise<string | undefined> } | undefined

/**
 * The id of the ECS task that runs this process, from the task metadata
 * endpoint (`ECS_CONTAINER_METADATA_URI_V4`). It is the last part of the
 * task ARN, and the name of the CloudWatch log stream of the task. Undefined
 * outside ECS, or when the endpoint gives no ARN within 60 seconds.
 */
export function ecsTaskId(): Promise<string | undefined> {
  const uri = process.env.ECS_CONTAINER_METADATA_URI_V4?.trim()
  if (!uri) return Promise.resolve(undefined)
  if (cached?.uri !== uri) cached = { uri, taskId: readTaskId(uri) }
  return cached.taskId
}

/**
 * The timeout is long because the timer also runs while the event loop is
 * blocked. The OpenWorkflow CLI compiles the worker's modules synchronously
 * for 20 to 30 seconds after `register.ts` sends this request. A 2-second
 * timer then fired before Node read the response, and the worker had no
 * task id (CTX-1705). The exporters wait for the id until the timeout.
 */
async function readTaskId(uri: string): Promise<string | undefined> {
  try {
    const response = await fetch(`${uri.replace(/\/$/, "")}/task`, {
      signal: AbortSignal.timeout(60_000),
    })
    if (!response.ok) return undefined
    const { TaskARN } = (await response.json()) as { TaskARN?: unknown }
    if (typeof TaskARN !== "string") return undefined
    return TaskARN.split("/").pop() || undefined
  } catch {
    return undefined
  }
}
