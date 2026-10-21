/**
 * The Node options of the worker child process. The supervisor sets them on
 * the child only, so the supervisor keeps the default heap.
 *
 * The heap limit is about 55% of the memory the container may use, up to
 * 12 GiB. This leaves room for native memory, Git, and the sandbox SDKs, and
 * it fits every target (a 1 GiB ECS task, a small Compose host, a 24 GB
 * Railway container). An operator overrides it with `--max-old-space-size`
 * in `NODE_OPTIONS`.
 */

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
  const add: string[] = []
  if (!options.includes("--max-old-space-size"))
    add.push(`--max-old-space-size=${workerHeapLimitMib(memoryBytes)}`)
  if (!options.includes("--heapsnapshot-near-heap-limit"))
    add.push("--heapsnapshot-near-heap-limit=1")
  if (!options.includes("--diagnostic-dir"))
    add.push(`--diagnostic-dir=${HEAP_SNAPSHOT_DIR}`)
  return [options, ...add].filter(Boolean).join(" ")
}
