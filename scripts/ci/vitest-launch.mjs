import { createRequire } from "node:module"
import { dirname, join } from "node:path"

// The steps that must run before Vitest for a lane. The CI script and the
// check runner both use them, so that a subset run starts Vitest as CI does.
export function setupSteps(lane, root) {
  const cwd = join(root, lane.directory)
  const require = createRequire(join(cwd, "package.json"))
  if (lane.name === "cli")
    return [
      {
        args: [
          require.resolve("typescript/bin/tsc"),
          "-p",
          "tsconfig.build.json",
        ],
        cwd,
      },
    ]
  if (lane.name === "aws-cdk")
    return [
      {
        args: [join(root, "packages/aws-cdk/scripts/stamp-image-tag.mjs")],
        cwd: root,
        timeout: 300_000,
      },
    ]
  return []
}

// The Vitest command line for a lane: the command, its arguments, the
// directory to run it in and its environment. An empty `files` list runs the
// whole lane. With `parts`, the workers record the lines that each test case
// executes and write them to that directory (see scripts/checks/trace.mjs).
export function vitestCommand(lane, root, files, report, parts) {
  const cwd = join(root, lane.directory)
  const require = createRequire(join(cwd, "package.json"))
  const vitest = join(
    dirname(require.resolve("vitest/package.json")),
    "vitest.mjs",
  )
  return {
    command: lane.runtime === "bun" ? "bun" : process.execPath,
    args: [
      vitest,
      "run",
      ...files,
      "--reporter=default",
      "--reporter=json",
      `--outputFile=${report}`,
      ...(parts
        ? [`--reporter=${join(root, "scripts/checks/trace-reporter.mjs")}`]
        : []),
    ],
    cwd,
    env: parts ? { ...process.env, CTXPIPE_TRACE_PARTS: parts } : process.env,
  }
}
