import { spawn, spawnSync } from "node:child_process"
import { closeSync, mkdirSync, openSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../../", import.meta.url))
let directory = join(root, ".ci-results", "checks")

// The folder of the logs: .ci-results/checks, or the folder that
// `run.mjs --logs` gives.
export const logDirectory = () => directory

export function setLogDirectory(path) {
  directory = path
}

// The runner writes the output of each group of checks to its own log in
// the log folder, because stdout carries only result records. Returns the
// absolute path and the path for the `log` of a record: repo-relative in the
// checkout, else absolute (a --logs folder outside the checkout).
export function logFile(name) {
  mkdirSync(directory, { recursive: true })
  const path = join(directory, `${name}.log`)
  writeFileSync(path, "")
  const inRepo = relative(root, path)
  return { path, relative: inRepo.startsWith("..") ? path : inRepo }
}

// Writes the command line to the log, and returns a file descriptor that
// appends to it, for the output of the command.
const openLog = (log, command, args) => {
  writeFileSync(log, `$ ${command} ${args.join(" ")}\n`, { flag: "a" })
  return openSync(log, "a")
}

const timeLimit = (timeout) =>
  `it did not end within its time limit of ${timeout / 1000} seconds`

// Runs a command with its output in the log, and returns the spawnSync result.
// When the command passes its `timeout`, the error message names the time
// limit: spawnSync gives only the code ETIMEDOUT.
export function logged(log, command, args, options = {}) {
  const fd = openLog(log, command, args)
  try {
    const run = spawnSync(command, args, {
      stdio: ["ignore", fd, fd],
      ...options,
    })
    if (run.error?.code === "ETIMEDOUT")
      run.error.message = timeLimit(options.timeout)
    return run
  } finally {
    closeSync(fd)
  }
}

// As `logged`, but the command runs while the caller continues. The runner
// starts the shards of a serial lane at the same time (lanes.mjs). Returns a
// promise of { status, signal, error }, as spawnSync gives them.
export function loggedAsync(log, command, args, options = {}) {
  const fd = openLog(log, command, args)
  const { timeout, ...rest } = options
  return new Promise((resolve) => {
    let error
    const child = spawn(command, args, { stdio: ["ignore", fd, fd], ...rest })
    const timer =
      timeout &&
      setTimeout(() => {
        error = new Error(timeLimit(timeout))
        child.kill("SIGTERM")
      }, timeout)
    child.on("error", (cause) => {
      error ??= cause
    })
    child.on("close", (status, signal) => {
      clearTimeout(timer)
      closeSync(fd)
      resolve({ status, signal, error })
    })
  })
}
