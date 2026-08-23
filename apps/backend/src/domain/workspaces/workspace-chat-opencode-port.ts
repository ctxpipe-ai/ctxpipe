import { createServer } from "node:http"

let localProcessPortTail = Promise.resolve()

export function withLocalProcessOpenCodePort<T>(
  run: () => Promise<T>,
): Promise<T> {
  const next = localProcessPortTail.then(run, run)
  localProcessPortTail = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

export async function waitForListenPortFree(
  port: number,
  timeoutMs = 15_000,
): Promise<void> {
  const started = Date.now()
  for (;;) {
    const free = await tryListen(port)
    if (free) return
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`port ${port} still bound after ${timeoutMs}ms`)
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

function tryListen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once("error", () => resolve(false))
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true))
    })
  })
}
