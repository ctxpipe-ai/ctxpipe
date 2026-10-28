import { appendFileSync, mkdirSync } from "node:fs"
import { dirname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

// A Bun preload. trace-worker.mjs adds it to BUN_OPTIONS for the child
// processes of a traced case. Bun runs JavaScriptCore, so it writes no V8
// coverage. This hook records the repo files that the Bun process loads, one
// path on each line, in `bun-<pid>.txt` in the NODE_V8_COVERAGE directory of
// the case. It appends each path at once, so a file that a signal stops
// keeps its list. The hook only observes: it returns nothing, and Bun
// resolves each import as it does without the hook.

const root = resolve(fileURLToPath(import.meta.url), "../../..") + sep
const directory = process.env.NODE_V8_COVERAGE
if (directory)
  try {
    mkdirSync(directory, { recursive: true })
    const list = join(directory, `bun-${process.pid}.txt`)
    const seen = new Set()
    // `Bun.resolveSync` calls this hook again; the inner calls do nothing.
    let busy = false
    Bun.plugin({
      name: "ctxpipe-trace",
      setup(build) {
        build.onResolve({ filter: /.*/ }, ({ path, importer }) => {
          if (busy) return
          const from = importer.startsWith("/")
            ? dirname(importer)
            : process.cwd()
          const key = `${from}\0${path}`
          if (
            seen.has(key) ||
            /^(node|bun):/.test(path) ||
            from.includes("/node_modules/")
          )
            return
          seen.add(key)
          busy = true
          try {
            const file = Bun.resolveSync(path, from)
            if (
              !seen.has(file) &&
              file.startsWith(root) &&
              !file.includes("/node_modules/")
            ) {
              seen.add(file)
              appendFileSync(list, `${file}\n`)
            }
          } catch {
            // A path that does not resolve here fails in Bun's own resolve.
          } finally {
            busy = false
          }
        })
      },
    })
  } catch {
    // Tracing never changes a result: without the hook, the child runs as is.
  }
