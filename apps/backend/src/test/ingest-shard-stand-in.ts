import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import { promisify } from "node:util"

import { buildContextIndex } from "../domain/ingestion/context-index.js"
import { IngestStepCommandError } from "../domain/ingestion/ingest-shard-ops.js"
import type {
  IngestShardRuntime,
  IngestShardRuntimeFactory,
  IngestStepUsage,
} from "../domain/ingestion/ingest-shard-runtime.js"
import { withExistingRootFiles } from "../domain/ingestion/ingestion-plan.js"

const exec = promisify(execFile)

/**
 * A stand-in for the ingest sandbox: the same `/ctxpipe` layout in a host
 * folder, the bundle's own scripts and stage helpers (`--root`), and real git
 * clones of the source and the destination repositories. The context index
 * of each step comes from the host path (`buildContextIndex` at the step
 * base). Only the agent is replaced: a model step posts
 * `{ step, skill, root, workspaceId, args, index }` to `modelUrl` (`index`:
 * the paths of the index entries) and stages the files of the reply
 * (`{ files: [{ path, content }], more?, usage? }`); `more` runs
 * `ctxpipe-finish --more`, and `usage` is the model usage that the step
 * reports.
 *
 * The folder is named by run and shard, so a replacement worker process finds
 * it, and `ensure` makes it again when it is gone (a lost sandbox).
 */
export function standInIngestShardRuntime(options: {
  modelUrl: string
  folder: string
}): IngestShardRuntimeFactory {
  const folderOf = (target: { runId: string; shard: number }) =>
    join(options.folder, `${target.runId}-${target.shard}`)
  const factory = (spec: Parameters<IngestShardRuntimeFactory>[0]) => {
    const root = folderOf(spec)
    const ready = join(root, "ready")
    const sourceDir = join(root, "source", "source")
    const git = (cwd: string, ...args: string[]) =>
      exec("git", ["-C", cwd, ...args], { encoding: "utf8" }).then((r) =>
        r.stdout.trim(),
      )
    const node = (script: string, ...args: string[]) =>
      exec(process.execPath, [join(root, "skills", script), ...args], {
        encoding: "utf8",
      }).then((r) => r.stdout)
    const runtime: IngestShardRuntime = {
      async ensure() {
        if (existsSync(ready)) return
        await rm(root, { recursive: true, force: true })
        for (const file of spec.bundle.files) {
          const path = join(root, "skills", file.path)
          await mkdir(dirname(path), { recursive: true })
          await writeFile(path, file.content)
        }
        await mkdir(join(root, "source"), { recursive: true })
        await exec("git", ["clone", "-q", spec.source.url, sourceDir])
        await git(sourceDir, "checkout", "-q", "--detach", spec.source.sha)
        for (const destination of spec.destinations)
          await exec("git", [
            "clone",
            "-q",
            destination.url,
            join(root, "context", destination.workspaceId),
          ])
        await writeFile(ready, "")
      },
      async discoverRoots() {
        await runtime.ensure()
        return JSON.parse(
          await node("discover-roots/scripts/discover-roots.mjs", sourceDir),
        )
      },
      async runStep(step) {
        await runtime.ensure()
        const context = join(root, "context", step.workspaceId)
        if (step.fetchRef)
          await git(context, "fetch", "-q", "origin", step.fetchRef)
        await git(context, "checkout", "-q", "--detach", step.baseCommit)
        const destination = spec.destinations.find(
          (d) => d.workspaceId === step.workspaceId,
        )
        if (!destination)
          throw new Error("The step's Workspace is not in the shard")
        const { index, json, rootFiles } = await buildContextIndex({
          workspaceId: step.workspaceId,
          sha: destination.pinnedRevision,
          base: step.baseCommit,
          sourcePath: destination.sourcePath,
          repoDir: context,
        })
        await writeFile(
          join(root, "context", `${step.workspaceId}.index.json`),
          json,
        )
        const rootsFile = join(root, "roots.json")
        // The host adds the existing files of each root (ADR-052 section 6).
        await writeFile(
          rootsFile,
          JSON.stringify(withExistingRootFiles(step.rootMap, rootFiles)),
        )
        // The same host inputs as the sandbox (ADR-052 section 6).
        const args = [
          "--source",
          sourceDir,
          "--source-url",
          spec.source.url,
          "--source-path",
          destination.sourcePath,
          "--roots",
          rootsFile,
          ...(step.root === null ? [] : ["--path", step.root]),
        ]
        const out = join(root, "out")
        await rm(out, { recursive: true, force: true })
        await mkdir(join(out, "files"), { recursive: true })
        await writeFile(
          join(root, "step.json"),
          JSON.stringify({
            workspaceId: step.workspaceId,
            baseCommit: step.baseCommit,
          }),
        )
        let more = false
        let usage: IngestStepUsage | undefined
        if (step.run === "script") {
          await node(
            `${step.skill}/scripts/${step.skill}.mjs`,
            "--root",
            root,
            ...args,
          )
        } else {
          const response = await fetch(options.modelUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              step: step.name,
              skill: step.skill,
              root: step.root,
              workspaceId: step.workspaceId,
              args,
              index: index.entries.map((e) => e.path),
            }),
            signal: step.signal,
          })
          // As the sandbox: a failed model call fails the skill command,
          // with the error of the model call.
          if (!response.ok)
            throw new IngestStepCommandError(
              "skill",
              1,
              `Model stand-in: ${response.status}`,
              {
                calls: 1,
                errors: [{ name: "APIError", status: response.status }],
              },
            )
          const reply = (await response.json()) as {
            files: Array<{ path: string; content: string }>
            more?: boolean
            usage?: IngestStepUsage
          }
          usage = reply.usage
          for (const file of reply.files) {
            await node("bin/ctxpipe-stage", "--root", root, file.path)
            await writeFile(join(out, "files", file.path), file.content)
          }
          more = reply.more === true
        }
        await node(
          "bin/ctxpipe-finish",
          "--root",
          root,
          ...(more ? ["--more"] : []),
        )
        return { tar: await tarOf(out), ...(usage ? { usage } : {}) }
      },
    }
    return runtime
  }
  return Object.assign(factory, {
    destroy: (target: { runId: string; shard: number }) =>
      rm(folderOf(target), { recursive: true, force: true }),
  })
}

// The tar archive of `dir`, with the entries that `tar -C dir -cf - .` of the
// sandbox writes. Node writes it, so the archive is the same on every host:
// macOS bsdtar and GNU tar write different archives. A path longer than 100
// bytes gets a GNU long-name entry.
async function tarOf(dir: string): Promise<Uint8Array> {
  const blocks: Buffer[] = []
  const padding = (size: number) => Buffer.alloc((512 - (size % 512)) % 512)
  const header = (name: string, type: string, size: number) => {
    const block = Buffer.alloc(512)
    block.write(name, 0, 100, "utf8")
    block.write(type === "5" ? "0000755\0" : "0000644\0", 100)
    block.write("0000000\0", 108)
    block.write("0000000\0", 116)
    block.write(`${size.toString(8).padStart(11, "0")}\0`, 124)
    block.write("00000000000\0", 136)
    block.fill(" ", 148, 156)
    block.write(type, 156)
    block.write("ustar  \0", 257)
    const sum = block.reduce((total, byte) => total + byte, 0)
    block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148)
    return block
  }
  const add = (name: string, type: string, data = Buffer.alloc(0)) => {
    if (Buffer.byteLength(name) > 100) {
      const long = Buffer.from(`${name}\0`)
      blocks.push(header("././@LongLink", "L", long.length), long)
      blocks.push(padding(long.length))
    }
    blocks.push(header(name, type, data.length), data, padding(data.length))
  }
  add("./", "5")
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  const paths = entries
    .map((entry) => ({
      entry,
      path: relative(dir, join(entry.parentPath, entry.name)),
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  for (const { entry, path } of paths) {
    if (entry.isDirectory()) add(`./${path}/`, "5")
    else if (entry.isFile())
      add(`./${path}`, "0", await readFile(join(dir, path)))
  }
  blocks.push(Buffer.alloc(1024))
  return new Uint8Array(Buffer.concat(blocks))
}
