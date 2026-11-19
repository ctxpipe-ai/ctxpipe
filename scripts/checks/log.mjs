import { spawnSync } from "node:child_process"
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

// Runs a command with its output in the log, and returns the spawnSync result.
export function logged(log, command, args, options = {}) {
  writeFileSync(log, `$ ${command} ${args.join(" ")}\n`, { flag: "a" })
  const fd = openSync(log, "a")
  try {
    return spawnSync(command, args, { stdio: ["ignore", fd, fd], ...options })
  } finally {
    closeSync(fd)
  }
}
