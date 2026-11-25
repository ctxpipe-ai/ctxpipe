/**
 * The Node options of the worker child process. The supervisor sets them on
 * the child only, so the supervisor keeps the default heap.
 *
 * The heap limit is about 55% of the memory the container may use, up to
 * 12 GiB. This leaves room for native memory, Git, and the sandbox SDKs, and
 * it fits every target (a 1 GiB ECS task, a small Compose host, a 24 GB
 * container). An operator overrides it with `--max-old-space-size` in
 * `NODE_OPTIONS`.
 */

import { existsSync, readFileSync } from "node:fs"
import { totalmem } from "node:os"
import { dirname, join, sep } from "node:path"

const MAX_HEAP_MIB = 12_288
const HEAP_SHARE = 0.55
export const HEAP_SNAPSHOT_DIR = "/tmp/heap"

export function workerHeapLimitMib(memoryBytes: number): number {
  return Math.min(
    MAX_HEAP_MIB,
    Math.floor((memoryBytes * HEAP_SHARE) / 1024 / 1024),
  )
}

/** `memoryBytes`: the container limit, or the host memory when there is none. */
export function workerNodeOptions(
  existing: string | undefined,
  memoryBytes: number,
): string {
  const options = existing?.trim() ?? ""
  const names = new Set(
    options
      .split(/\s+/)
      .filter((token) => token.startsWith("--"))
      .map((token) => (token.split("=", 1)[0] ?? token).replaceAll("_", "-")),
  )
  const add: string[] = []
  if (!names.has("--max-old-space-size"))
    add.push(`--max-old-space-size=${workerHeapLimitMib(memoryBytes)}`)
  // Kept on by default: if the platform kills the process while it writes the
  // snapshot, the result is the same crash as without the flag.
  if (!names.has("--heapsnapshot-near-heap-limit"))
    add.push("--heapsnapshot-near-heap-limit=1")
  if (!names.has("--diagnostic-dir"))
    add.push(`--diagnostic-dir=${HEAP_SNAPSHOT_DIR}`)
  return [options, ...add].filter(Boolean).join(" ")
}

/** A cgroup writes "no limit" as `max` (v2) or as a value near 2^63 (v1). */
const NO_LIMIT_BYTES = 2 ** 60

function limitBytes(text: string | undefined): number | undefined {
  const value = Number(text?.trim())
  return Number.isFinite(value) && value > 0 && value < NO_LIMIT_BYTES
    ? value
    : undefined
}

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

function lowest(values: (number | undefined)[]): number | undefined {
  const known = values.filter((value) => value !== undefined)
  return known.length ? Math.min(...known) : undefined
}

/**
 * The directory of the cgroup of this process under `mount`. In a cgroup
 * namespace, or when the runtime mounts only the cgroup of the container,
 * the path from `/proc/self/cgroup` is not under the mount, and the mount
 * itself is the cgroup of the process.
 */
function ownCgroupDir(mount: string, path: string): string {
  const dir = join(mount, ...path.split("/").filter(Boolean))
  return dir.startsWith(mount + sep) && existsSync(dir) ? dir : mount
}

/**
 * The memory limit of the container of this process in bytes, from its
 * cgroup, or undefined when no cgroup sets one. `root` is the file system
 * root (a test gives a folder with fake cgroup files).
 *
 * The limit can be on a parent cgroup. ECS (also Fargate) sets the task
 * memory on the cgroup of the task, and the cgroup of the container has no
 * limit. `process.constrainedMemory()` reads only the cgroup of the process,
 * so on Fargate it found no limit, and the worker got a heap limit from the
 * memory of the host, above the task memory (CTX-1615). Thus this function
 * reads the limits of the parents too: cgroup v2 `memory.max` of each parent
 * that the container can see, and cgroup v1 `hierarchical_memory_limit`,
 * which is the lowest limit of the cgroup and its parents.
 */
export function containerMemoryLimit(root = "/"): number | undefined {
  const lines = readText(join(root, "proc/self/cgroup"))?.split("\n") ?? []
  const cgroup = join(root, "sys/fs/cgroup")
  const unified = lines.find((line) => line.startsWith("0::"))
  if (unified !== undefined && existsSync(join(cgroup, "cgroup.controllers"))) {
    const limits: (number | undefined)[] = []
    for (
      let dir = ownCgroupDir(cgroup, unified.slice(3));
      dir.startsWith(cgroup);
      dir = dirname(dir)
    )
      limits.push(limitBytes(readText(join(dir, "memory.max"))))
    return lowest(limits)
  }
  const memory = lines.find((line) =>
    line.split(":")[1]?.split(",").includes("memory"),
  )
  if (memory === undefined) return undefined
  const dir = ownCgroupDir(
    join(cgroup, "memory"),
    memory.split(":").slice(2).join(":"),
  )
  const stat = readText(join(dir, "memory.stat"))
  // The lowest limit of the cgroup and its parents; without memory.stat,
  // the limit of the cgroup only.
  return limitBytes(
    stat === undefined
      ? readText(join(dir, "memory.limit_in_bytes"))
      : stat
          .split("\n")
          .find((line) => line.startsWith("hierarchical_memory_limit "))
          ?.split(" ")[1],
  )
}

export const mib = (bytes: number) => Math.round(bytes / 1024 / 1024)

/** The memory the worker may use: the container limit, else the host memory. */
export function workerMemoryBytes(root = "/"): number {
  const limit = containerMemoryLimit(root)
  return limit === undefined ? totalmem() : Math.min(limit, totalmem())
}
