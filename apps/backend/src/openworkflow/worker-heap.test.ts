import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir, totalmem } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import {
  containerMemoryLimit,
  workerHeapLimitMib,
  workerMemoryBytes,
  workerNodeOptions,
} from "./worker-heap.js"

const GiB = 1024 ** 3
const MiB = 1024 ** 2

describe("worker heap options", () => {
  it("caps the heap at 12 GiB on a 24 GB container", () => {
    expect(workerHeapLimitMib(24 * GiB)).toBe(12_288)
  })

  it("keeps the heap below the memory of a small container", () => {
    for (const mib of [1024, 2048, 4096]) {
      const heap = workerHeapLimitMib(mib * 1024 * 1024)
      expect(heap).toBeLessThan(mib * 0.6)
      expect(heap).toBeGreaterThan(mib * 0.5)
    }
  })

  it("adds the heap limit and the snapshot flags", () => {
    expect(workerNodeOptions(undefined, 4 * GiB)).toBe(
      "--max-old-space-size=2252 --heapsnapshot-near-heap-limit=1 --diagnostic-dir=/tmp/heap",
    )
  })

  it("keeps an operator value", () => {
    const options = workerNodeOptions(
      "--max-old-space-size=3000 --diagnostic-dir=/data",
      24 * GiB,
    )
    expect(options).toBe(
      "--max-old-space-size=3000 --diagnostic-dir=/data --heapsnapshot-near-heap-limit=1",
    )
  })

  it("keeps the underscore form of a flag", () => {
    expect(workerNodeOptions("--max_old_space_size=8192", 24 * GiB)).toBe(
      "--max_old_space_size=8192 --heapsnapshot-near-heap-limit=1 --diagnostic-dir=/tmp/heap",
    )
  })

  it("keeps an operator value that turns the snapshot off", () => {
    expect(workerNodeOptions("--heapsnapshot-near-heap-limit=0", 4 * GiB)).toBe(
      "--heapsnapshot-near-heap-limit=0 --max-old-space-size=2252 --diagnostic-dir=/tmp/heap",
    )
  })

  it("does not read a flag name inside another value", () => {
    expect(workerNodeOptions("--title=x--max-old-space-size", 4 * GiB)).toBe(
      "--title=x--max-old-space-size --max-old-space-size=2252 --heapsnapshot-near-heap-limit=1 --diagnostic-dir=/tmp/heap",
    )
  })
})

describe("container memory limit", () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true })
  })

  /** A file system root with the given files (path relative to the root). */
  function fakeRoot(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "cgroup-"))
    roots.push(root)
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), text)
    }
    return root
  }

  it("reads the task limit of a parent cgroup on cgroup v1 (ECS on Fargate)", () => {
    // The container cgroup has no limit of its own; the task cgroup has 2 GiB.
    const root = fakeRoot({
      "proc/self/cgroup":
        "11:cpu,cpuacct:/ecs/task/container\n9:memory:/ecs/task/container\n",
      "sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712\n",
      "sys/fs/cgroup/memory/memory.stat": `cache 0\nrss 1\nhierarchical_memory_limit ${2 * GiB}\nhierarchical_memsw_limit 9223372036854771712\n`,
    })
    expect(containerMemoryLimit(root)).toBe(2 * GiB)
    expect(workerHeapLimitMib(workerMemoryBytes(root))).toBe(1126)
  })

  it("reads the limit of the container cgroup on cgroup v1", () => {
    const root = fakeRoot({
      "proc/self/cgroup": "4:memory:/docker/abc\n",
      "sys/fs/cgroup/memory/docker/abc/memory.limit_in_bytes": `${GiB}\n`,
      "sys/fs/cgroup/memory/docker/abc/memory.stat": `hierarchical_memory_limit ${4 * GiB}\n`,
    })
    expect(containerMemoryLimit(root)).toBe(GiB)
  })

  it("reads the lowest memory.max of the cgroup and its parents on cgroup v2", () => {
    const root = fakeRoot({
      "proc/self/cgroup": "0::/ecs/task/container\n",
      "sys/fs/cgroup/cgroup.controllers": "cpu memory\n",
      "sys/fs/cgroup/ecs/task/container/memory.max": "max\n",
      "sys/fs/cgroup/ecs/task/memory.max": `${2 * GiB}\n`,
      "sys/fs/cgroup/ecs/memory.max": "max\n",
    })
    expect(containerMemoryLimit(root)).toBe(2 * GiB)
  })

  it("reads memory.max of the namespace root on cgroup v2", () => {
    const root = fakeRoot({
      "proc/self/cgroup": "0::/\n",
      "sys/fs/cgroup/cgroup.controllers": "cpu memory\n",
      "sys/fs/cgroup/memory.max": `${1536 * MiB}\n`,
    })
    expect(containerMemoryLimit(root)).toBe(1536 * MiB)
  })

  it("uses the host memory when no cgroup sets a limit", () => {
    const root = fakeRoot({
      "proc/self/cgroup": "0::/\n",
      "sys/fs/cgroup/cgroup.controllers": "cpu memory\n",
      "sys/fs/cgroup/memory.max": "max\n",
    })
    expect(containerMemoryLimit(root)).toBeUndefined()
    expect(workerMemoryBytes(root)).toBe(totalmem())
  })

  it("uses the host memory when there is no cgroup file system", () => {
    const root = fakeRoot({})
    expect(containerMemoryLimit(root)).toBeUndefined()
    expect(workerMemoryBytes(root)).toBe(totalmem())
  })
})
