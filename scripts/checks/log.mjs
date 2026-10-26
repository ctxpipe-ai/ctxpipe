import { spawnSync } from "node:child_process"
import { closeSync, mkdirSync, openSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../../", import.meta.url))

// The runner writes the output of each group of checks to its own log in
// .ci-results/checks, because stdout carries only result records. Returns
// the absolute path and the repo-relative path (the `log` of a record).
export function logFile(name) {
  const directory = join(root, ".ci-results", "checks")
  mkdirSync(directory, { recursive: true })
  const path = join(directory, `${name}.log`)
  writeFileSync(path, "")
  return { path, relative: relative(root, path) }
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
