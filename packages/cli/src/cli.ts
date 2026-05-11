import { parseArgs } from "./args.js"
import { dispatch } from "./commands.js"

export async function runCli(rawArgs: string[] = process.argv.slice(2)): Promise<void> {
  await dispatch(parseArgs(rawArgs))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`ctxpipe: ${message}`)
    process.exitCode = 1
  })
}
