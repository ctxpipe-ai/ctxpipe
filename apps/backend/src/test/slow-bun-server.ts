// Bun subprocess fixture: a UI upstream that answers after a delay.
// It reads `NITRO_BUN_IDLE_TIMEOUT` with the same expression as the Nitro
// `bun` preset entry, so the test sees the idle timeout of the UI server.
import { writeFile } from "node:fs/promises"

const [readyFile, delayArgument] = process.argv.slice(2)
if (!readyFile) throw new Error("A ready-file path is required")
const delayMs = Number(delayArgument)
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout:
    Number.parseInt(process.env.NITRO_BUN_IDLE_TIMEOUT ?? "") || undefined,
  async fetch() {
    await Bun.sleep(delayMs)
    return new Response("<html>slow page</html>", {
      headers: { "content-type": "text/html" },
    })
  },
})
await writeFile(readyFile, JSON.stringify({ port: server.port }))
process.once("SIGTERM", () => {
  server.stop(true)
  process.exit(0)
})
