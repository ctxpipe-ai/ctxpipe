import {
  CODEBASE_DIDNT_FIT_AVAILABLE_MEMORY,
  errorFromIndexerExit,
} from "../src/domain/indexing/memoryFitError.ts"

/**
 * Drive a child that grows RSS until the cgroup kills it, then classify the
 * exit the same way zoekt-index / SCIP spawn does.
 *
 * Prefer a native allocator (`dd` into tmpfs) so the kernel SIGKILLs (137)
 * instead of Bun raising a JS-heap RangeError first.
 */
const child = Bun.spawn(
  [
    "sh",
    "-c",
    [
      "if [ -d /dev/shm ]; then",
      "  i=0; while true; do",
      "    dd if=/dev/zero of=/dev/shm/ctxpipe-oom-hog.$i bs=1M count=8 status=none || exit $?",
      "    i=$((i + 1))",
      "  done",
      "fi",
      "exec bun -e 'const chunks = []; while (true) chunks.push(Buffer.allocUnsafe(8 * 1024 * 1024))'",
    ].join("\n"),
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
process.stdout.write(`${JSON.stringify(payload)}\n`)

if (!payload.memoryFit && exitCode !== 137) {
  process.exit(1)
}
