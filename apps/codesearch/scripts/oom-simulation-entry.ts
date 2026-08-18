import {
  CODEBASE_DIDNT_FIT_AVAILABLE_MEMORY,
  errorFromIndexerExit,
} from "../src/domain/indexing/memoryFitError.ts"

/**
 * Drive a child process that allocates until the cgroup kills it, then
 * classify the exit the same way zoekt-index / SCIP spawn does.
 */
const child = Bun.spawn(
  [
    "bun",
    "-e",
    "const chunks = []; while (true) chunks.push(new Uint8Array(8 * 1024 * 1024))",
  ],
  { stdout: "pipe", stderr: "pipe" },
)

const [stdout, stderr, exitCode] = await Promise.all([
  new Response(child.stdout).text(),
  new Response(child.stderr).text(),
  child.exited,
])

const error = errorFromIndexerExit({
  exitCode,
  stderr,
  stdout,
  headline: `Command failed with exit code ${exitCode}`,
})

const payload = {
  exitCode,
  error: error.message,
  memoryFit: error.message === CODEBASE_DIDNT_FIT_AVAILABLE_MEMORY,
}
console.log(JSON.stringify(payload))

if (!payload.memoryFit && exitCode !== 137) {
  process.exit(1)
}
