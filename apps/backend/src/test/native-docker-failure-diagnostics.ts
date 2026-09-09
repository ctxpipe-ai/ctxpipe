import Docker from "dockerode"

function statusCode(error: unknown): string | number | undefined {
  if (!error || typeof error !== "object" || !("statusCode" in error))
    return undefined
  const value = error.statusCode
  return typeof value === "string" || typeof value === "number"
    ? value
    : undefined
}

/** Credential-free state captured after a native Docker contract failure. */
export async function nativeDockerFailureDiagnostics(input: {
  childRuntime?: string
  ownedName?: string
  proxyTrace?: string[]
  transport: string
}) {
  const docker = new Docker({
    socketPath: "/var/run/docker.sock",
    timeout: 2_000,
  })
  let ping: "ok" | "failed" = "failed"
  try {
    await docker.ping()
    ping = "ok"
  } catch {
    // The failed ping is the diagnostic; preserve the original test error.
  }

  let owned:
    | { exists: true; running: boolean; status: string }
    | { exists: false; statusCode: 404 }
    | { exists: "unknown"; statusCode?: string | number }
    | undefined
  if (input.ownedName) {
    try {
      const info = await docker.getContainer(input.ownedName).inspect()
      owned = {
        exists: true,
        running: info.State.Running,
        status: info.State.Status,
      }
    } catch (error) {
      const code = statusCode(error)
      owned =
        code === 404
          ? { exists: false, statusCode: 404 }
          : {
              exists: "unknown",
              ...(code !== undefined ? { statusCode: code } : {}),
            }
    }
  }

  return {
    processRuntime: `node ${process.version}`,
    ...(input.childRuntime ? { childRuntime: input.childRuntime } : {}),
    transport: input.transport,
    ping,
    ...(owned ? { owned } : {}),
    ...(input.proxyTrace ? { proxyTrace: input.proxyTrace } : {}),
  }
}
