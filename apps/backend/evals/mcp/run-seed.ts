import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { z } from "zod"
import { closeDb, getSystemDb, initDb } from "../../src/db/client.js"
import { users } from "../../src/db/schema/auth.js"
import { initEvlog, log } from "../../src/observability/logger.js"
import { closeGraphDb } from "../../src/platform/graph/client.js"
import {
  advanceMcpEvalWorkspace,
  createMcpEvalApiKey,
  prepareMcpEvalRepositories,
  seedMcpEval,
} from "./seed.js"

async function main(argv: string[]) {
  if (argv[0] === "prepare" && argv.length === 2 && argv[1]) {
    const remotes = await prepareMcpEvalRepositories(resolve(argv[1]))
    process.stdout.write(`${JSON.stringify(remotes, null, 2)}\n`)
    return
  }
  if (argv[0] === "ci" && argv.length === 4) {
    await seedForCi(argv[1] ?? "", argv[2] ?? "", argv[3] ?? "")
    return
  }
  const [command, run, userId, remoteFile] = argv
  if (
    !["seed", "advance"].includes(command ?? "") ||
    argv.length !== 4 ||
    !run ||
    !userId ||
    !remoteFile
  ) {
    throw new Error(
      "Usage: run-seed.ts prepare DIRECTORY | seed RUN USER_ID REMOTES_JSON | advance RUN USER_ID REMOTES_JSON | ci RUN DIRECTORY OUT_JSON",
    )
  }
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
  const remotes = z
    .record(z.string(), z.string().min(1))
    .parse(JSON.parse(await readFile(remoteFile, "utf8")))
  initDb(process.env.DATABASE_URL)
  try {
    const result = await (command === "seed"
      ? seedMcpEval
      : advanceMcpEvalWorkspace)({
      run,
      userId,
      remotes,
    })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } finally {
    await closeGraphDb()
    await closeDb()
  }
}

/**
 * CI only: prepare the fixture repositories in DIRECTORY, create a made-up
 * user, seed the fixtures, and write the run name, the user id, the remotes
 * file, and a personal API key for the two fixture organizations to
 * OUT_JSON (mode 0600). `run.ts --seed OUT_JSON` reads it. Use a disposable
 * database.
 */
async function seedForCi(run: string, directory: string, out: string) {
  if (!run || !directory || !out)
    throw new Error("ci needs RUN DIRECTORY OUT_JSON")
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
  const remotes = await prepareMcpEvalRepositories(resolve(directory))
  const remoteFile = resolve(directory, "remotes.json")
  await writeFile(remoteFile, JSON.stringify(remotes))
  initDb(process.env.DATABASE_URL)
  try {
    const userId = `user_mcp_eval_${run}`
    await getSystemDb()
      .insert(users)
      .values({ id: userId, name: "MCP eval", email: `${run}@example.test` })
    const seeded = await seedMcpEval({ run, userId, remotes })
    const { key } = await createMcpEvalApiKey({
      userId,
      organizationIds: seeded.organizations.map((org) => org.id),
    })
    await writeFile(
      out,
      JSON.stringify({ run, userId, remotes: remoteFile, apiKey: key }),
      { mode: 0o600 },
    )
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
