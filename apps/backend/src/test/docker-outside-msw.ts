import http from "node:http"
import type { SetupServer } from "msw/node"

/**
 * Start `server`, but send each request to a Unix socket (the Docker API)
 * directly, not through msw.
 *
 * msw replays a passthrough request on a new connection that has
 * `Connection: close`. On a Linux Docker daemon under load, a Docker exec then
 * fails with `write EPIPE` from time to time. `server.close()` puts back the
 * `http.request` that was there before `listen`, so it also removes this
 * bypass.
 */
export function listenWithDockerOutsideMsw(
  server: SetupServer,
  options: Parameters<SetupServer["listen"]>[0],
) {
  const direct = http.request
  server.listen(options)
  const intercepted = http.request
  http.request = ((...args: Parameters<typeof http.request>) => {
    const [first] = args
    const unixSocket =
      typeof first === "object" &&
      "socketPath" in first &&
      Boolean(first.socketPath)
    // biome-ignore lint/suspicious/noExplicitAny: forwards an overloaded call as is
    return ((unixSocket ? direct : intercepted) as any)(...args)
  }) as typeof http.request
}
