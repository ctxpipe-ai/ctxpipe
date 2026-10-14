import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { z } from "zod"
import { closeDb, initDb } from "../../src/db/client.js"
import { initEvlog, log } from "../../src/observability/logger.js"
import { closeGraphDb } from "../../src/platform/graph/client.js"
import { prepareMcpEvalRepositories, seedMcpEval } from "./seed.js"

async function main(argv: string[]) {
  if (argv[0] === "prepare" && argv.length === 2 && argv[1]) {
    const remotes = await prepareMcpEvalRepositories(resolve(argv[1]))
    process.stdout.write(`${JSON.stringify(remotes, null, 2)}\n`)
    return
  }
  const [, target, run, userId, remoteFile] = argv
  if (
    argv[0] !== "seed" ||
    argv.length !== 5 ||
    !["local", "preview"].includes(target ?? "") ||
    !run ||
    !userId ||
    !remoteFile
  ) {
    throw new Error(
      "Usage: run-seed.ts prepare DIRECTORY | seed local|preview RUN USER_ID REMOTES_JSON",
    )
  }
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
  const remotes = z
    .record(z.string(), z.string().min(1))
    .parse(JSON.parse(await readFile(remoteFile, "utf8")))
  initDb(process.env.DATABASE_URL)
  try {
    const result = await seedMcpEval({ run, userId, remotes })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } finally {
    await closeGraphDb()
    await closeDb()
  }
}

initEvlog()
await main(process.argv.slice(2)).catch((error) => {
  log.error({
    step: "mcp-eval.seed",
    message: error instanceof Error ? error.message : String(error),
  })
  process.exitCode = 1
})
