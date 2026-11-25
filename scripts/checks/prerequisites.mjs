import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { connect } from "node:net"
import { hostname } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { graphReady } from "../ci/graph-ready.mjs"

// The named prerequisites of checks (the `prerequisites` of a manifest
// record). Each one makes a thing or verifies it, and throws an error with
// the fix when it cannot. Usage:
//   prerequisites.mjs <name>...   (pnpm checks:prepare)
// The runner (run.mjs) calls `prepare` for the prerequisites of the checks
// that it runs. Command output goes to stderr: stdout of the runner carries
// only result records.

const root = fileURLToPath(new URL("../../", import.meta.url))
const backend = createRequire(join(root, "apps/backend/package.json"))

// Runs a command with its output on stderr. Throws `fix` when it fails.
const step = (command, args, fix, cwd = root, env = process.env) => {
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: ["ignore", 2, 2],
    timeout: 1_800_000,
  })
  if (result.error || result.status !== 0)
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.error?.message ?? `exit ${result.status}`}). ${fix}`,
    )
}
const quiet = (command, args, fix, env = process.env) => {
  try {
    return execFileSync(command, args, {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 60_000,
    }).trim()
  } catch {
    throw new Error(`${command} ${args.join(" ")} failed. ${fix}`)
  }
}
const required = (name, fix) => {
  if (!process.env[name]) throw new Error(`${name} is not set. ${fix}`)
  return process.env[name]
}
const declared = (file, pattern) => {
  const value = readFileSync(join(root, file), "utf8").match(pattern)?.[1]
  if (!value) throw new Error(`Cannot read ${pattern} from ${file}`)
  return value
}
const pgQuery = async (sql) => {
  const { Pool } = backend("pg")
  const pool = new Pool({
    connectionString: required(
      "DATABASE_URL",
      "Start Postgres (pnpm dev:infra) and set DATABASE_URL.",
    ),
    connectionTimeoutMillis: 5_000,
  })
  try {
    return (await pool.query(sql)).rows
  } finally {
    await pool.end()
  }
}
// The pinned versions of the services, the digest of each image and the
// previous release (scripts/ci/service-pins.json). A lane lists the file as
// an input, so a change of a pin changes the key of a check.
const pins = JSON.parse(
  readFileSync(join(root, "scripts/ci/service-pins.json"), "utf8"),
)
// Asks FalkorDB for the version of its graph module through the Redis
// protocol (MODULE LIST), so no client library is needed.
export const falkordbModuleVersion = (uri) =>
  new Promise((resolve, reject) => {
    const url = new URL(uri)
    const bulk = (value) => `$${Buffer.byteLength(value)}\r\n${value}\r\n`
    const socket = connect({
      host: url.hostname,
      port: Number(url.port || 6379),
    })
    let reply = ""
    const timer = setTimeout(
      () => socket.destroy(new Error("no reply")),
      10_000,
    )
    socket.setEncoding("utf8")
    socket.on("connect", () => {
      if (url.password)
        socket.write(
          `*2\r\n${bulk("AUTH")}${bulk(decodeURIComponent(url.password))}`,
        )
      socket.write(`*2\r\n${bulk("MODULE")}${bulk("LIST")}`)
    })
    socket.on("data", (chunk) => {
      reply += chunk
      const found = reply.match(/\$5\r\ngraph\r\n\$3\r\nver\r\n:(\d+)\r\n/)
      if (!found) return
      socket.destroy()
      resolve(Number(found[1]))
    })
    socket.on("close", () => reject(new Error("no graph module in the reply")))
    socket.on("error", reject)
    socket.on("close", () => clearTimeout(timer))
  })
// Each entry: `needs` (other prerequisites, made first) and `prepare` (makes
// or verifies). Keep this a small map; it is not a build system.
export const prerequisites = {
  bun: {
    // `bun check` (the Typecheck check) needs the version of `engines`. An
    // older Bun runs the `check` script of a package, or finds none.
    prepare: () => {
      const wanted = declared("package.json", /"bun": "\^([\d.]+)"/)
      const found = quiet(
        "bun",
        ["--version"],
        `Install Bun ${wanted} or newer (package.json engines).`,
      )
      const parts = (version) => version.split(".").map(Number)
      const [have, want] = [parts(found), parts(wanted)]
      const index = have.findIndex((part, i) => part !== want[i])
      const older = index !== -1 && have[index] < want[index]
      if (older)
        throw new Error(
          `Bun ${found} is older than ${wanted}, so it has no \`bun check\`. Install Bun ${wanted} or newer (package.json engines).`,
        )
    },
  },
  docker: {
    prepare: () => quiet("docker", ["info"], "Start Docker."),
  },
  "ast-grep": {
    prepare: () =>
      quiet(
        "ast-grep",
        ["--version"],
        "Run pnpm install: the root devDependency @ast-grep/cli puts ast-grep in node_modules/.bin, which factory check and pnpm put first on PATH.",
      ),
  },
  zoekt: {
    prepare: () => {
      for (const binary of ["zoekt-index", "zoekt-webserver"])
        try {
          execFileSync(binary, ["-h"], { stdio: "ignore", timeout: 10_000 })
        } catch {
          throw new Error(
            `${binary} is missing. Run scripts/zoekt/build.sh: it builds the pinned zoekt into .tools/bin, which factory check puts first on PATH.`,
          )
        }
    },
  },
  opencode: {
    prepare: () => {
      const expected = declared(
        "apps/backend/src/domain/workspaces/workspace-chat-opencode-contract.ts",
        /WORKSPACE_CHAT_OPENCODE_CLI = "opencode-ai@([^"]+)"/,
      )
      const found = quiet(
        "opencode",
        ["--version"],
        "Run pnpm install: the root devDependency opencode-ai puts opencode in node_modules/.bin, which factory check and pnpm put first on PATH.",
      )
      if (found !== expected)
        throw new Error(
          `OpenCode must be ${expected}; found ${found}. Run pnpm install, and run the check with node_modules/.bin first on PATH (factory check and pnpm do).`,
        )
    },
  },
  // The key of a check holds the pins file, not the running server, so a
  // server of another version must fail here.
  postgres: {
    prepare: async () => {
      const [server] = await pgQuery("SHOW server_version")
      // The installed extension wins over the default of the image: an old
      // volume can hold an older one.
      const [vector] = await pgQuery(
        "SELECT coalesce((SELECT extversion FROM pg_extension WHERE extname = 'vector'), (SELECT default_version FROM pg_available_extensions WHERE name = 'vector')) AS version",
      )
      // The collation decides text ORDER BY: macOS libc and the glibc of the
      // image sort differently.
      const [database] = await pgQuery(
        "SELECT datcollate, datctype, datcollversion FROM pg_database WHERE datname = current_database()",
      )
      const found = {
        serverVersion: server.server_version.split(" ")[0],
        pgvectorVersion: vector?.version,
        collate: database?.datcollate,
        ctype: database?.datctype,
        collationVersion: database?.datcollversion,
      }
      const wrong = Object.keys(found).filter(
        (name) => found[name] !== pins.postgres[name],
      )
      if (wrong.length)
        throw new Error(
          `Postgres differs from the pinned image (scripts/ci/service-pins.json): ${wrong.map((name) => `${name} ${found[name]}, not ${pins.postgres[name]}`).join("; ")}. Run: docker compose pull postgres && pnpm dev:infra, and make the database from the default template.`,
        )
    },
  },
  migrations: {
    needs: ["postgres"],
    prepare: async () => {
      const [row] = await pgQuery(
        "SELECT to_regclass('public.workspaces') AS workspaces, to_regclass('openworkflow.workflow_runs') AS workflows",
      )
      if (!row?.workspaces || !row.workflows)
        throw new Error(
          "The database at DATABASE_URL has no migrations. Run pnpm db:migrate.",
        )
    },
  },
  falkordb: {
    prepare: async () => {
      const uri = required(
        "GRAPH_DB_URI",
        "Start FalkorDB (pnpm dev:infra) and set GRAPH_DB_URI.",
      )
      await graphReady(uri)
      const found = await falkordbModuleVersion(uri)
      if (found !== pins.falkordb.moduleVersion)
        throw new Error(
          `FalkorDB module version must be ${pins.falkordb.moduleVersion}; found ${found}. Run: docker compose pull falkordb && pnpm dev:infra`,
        )
    },
  },
  // Pulls a missing contract image by its pinned digest. The image is only
  // inspected, never run, so a disk cleanup on a shared Docker host can
  // remove it between runs; the digest makes the pull as fixed as a lockfile.
  "contract-images": {
    needs: ["docker"],
    prepare: () => {
      for (const pin of Object.values(pins.contracts)) {
        const image = `${pin.image}:${pin.tag}@${pin.digest}`
        const fix = `Run: docker pull ${image}`
        const pinned = () => {
          try {
            const digests = JSON.parse(
              quiet(
                "docker",
                [
                  "image",
                  "inspect",
                  "--format",
                  "{{json .RepoDigests}}",
                  image,
                ],
                "",
              ),
            )
            return (
              Array.isArray(digests) &&
              digests.includes(`${pin.image}@${pin.digest}`)
            )
          } catch {
            return false
          }
        }
        if (pinned()) continue
        step("docker", ["pull", image], fix)
        if (!pinned())
          throw new Error(`${image} does not have the pinned digest. ${fix}`)
      }
    },
  },
  // Screenshots are taken in one pinned image (scripts/ci/visual-capture.mjs).
  // The Docker server must run linux/arm64 itself: an emulated browser gives
  // other pixels, and a slow, flaky run.
  "visual-container": {
    needs: ["docker"],
    prepare: () => {
      const visualPin = JSON.parse(
        readFileSync(join(root, "scripts/ci/visual-container.json"), "utf8"),
      )
      const platform = quiet(
        "docker",
        ["version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"],
        "Start Docker.",
      )
      if (platform !== visualPin.platform)
        throw new Error(
          `The Docker server is ${platform}; screenshots need ${visualPin.platform}. Use an arm64 host or an arm64 VM (colima start --arch aarch64 --memory 4).`,
        )
      const image = `${visualPin.image}:${visualPin.tag}@${visualPin.digest}`
      try {
        quiet("docker", ["image", "inspect", image], "")
      } catch {
        step(
          "docker",
          ["pull", "--platform", visualPin.platform, image],
          `Run: docker pull ${image}`,
        )
      }
      // The tag of the pin follows the lockfile (check-visual-container.mjs),
      // but the digest can stay behind. The image must hold the browsers
      // that the installed Playwright launches.
      const playwright = createRequire(
        createRequire(join(root, "apps/ui/package.json")).resolve(
          "playwright/package.json",
        ),
      ).resolve("playwright-core/package.json")
      const { browsers } = JSON.parse(
        readFileSync(join(dirname(playwright), "browsers.json"), "utf8"),
      )
      // The label of a test container (scripts/ci/test-containers.mjs, which
      // this file does not import: it would become a check definition). The
      // `finally` removes the container also after a time-out of the client.
      // A signal waits for the end of the synchronous docker call, so that the
      // `finally` runs; then the signal ends the process as before.
      const probe = `ctxpipe-test-visual-probe-${process.pid}`
      const signals = []
      const held = (signal) => signals.push(signal)
      for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
        process.on(signal, held)
      let present
      try {
        present = quiet(
          "docker",
          [
            "run",
            "--rm",
            "--name",
            probe,
            "--label",
            `ai.ctxpipe.test=${process.env.CTXPIPE_TEST_OWNER || `${hostname()}/${process.pid}`}`,
            "--platform",
            visualPin.platform,
            "--entrypoint",
            "ls",
            image,
            "/ms-playwright",
          ],
          `Run: docker pull ${image}`,
        ).split("\n")
      } finally {
        spawnSync("docker", ["rm", "--force", "--volumes", probe], {
          stdio: "ignore",
        })
        // Node runs a signal listener only after the synchronous call.
        setImmediate(() => {
          for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
            process.off(signal, held)
          if (signals[0]) process.kill(process.pid, signals[0])
        })
      }
      const missing = browsers
        .filter(({ name }) => name.startsWith("chromium"))
        .map(({ name, revision }) => `${name.replaceAll("-", "_")}-${revision}`)
        .filter((directory) => !present.includes(directory))
      if (missing.length)
        throw new Error(
          `${image} has no ${missing.join(", ")} (its browsers: ${present.join(", ")}). The digest does not match the playwright version of the lockfile. Pin the linux/arm64 digest of ${visualPin.image}:${visualPin.tag} in scripts/ci/visual-container.json.`,
        )
    },
  },
  "chat-sandbox-image": {
    needs: ["docker"],
    prepare: () => {
      const tag = declared(
        "apps/backend/src/domain/workspaces/chat-runtime.ts",
        /"(ctxpipe-chat-sandbox:[^"]+)"/,
      )
      step(
        "docker",
        ["build", "-t", tag, "scripts/chat-sandbox"],
        "See scripts/chat-sandbox/README.md.",
      )
    },
  },
  chromium: {
    prepare: () =>
      step(
        "pnpm",
        ["exec", "playwright", "install", "chromium"],
        "Install the Playwright Chromium.",
        join(root, "apps/ui"),
      ),
  },
  // CI downloads the build of its Storybook job and sets
  // SKIP_STORYBOOK_BUILD=1, as for scripts/ci/storybook-plays.mjs.
  "storybook-build": {
    prepare: () => {
      if (process.env.SKIP_STORYBOOK_BUILD !== "1")
        step(
          "pnpm",
          ["--filter", "@ctxpipe/ui", "build-storybook"],
          "Fix the Storybook build.",
        )
      if (!existsSync(join(root, "apps/ui/storybook-static/index.json")))
        throw new Error(
          "apps/ui/storybook-static/index.json is missing. Unset SKIP_STORYBOOK_BUILD to build Storybook.",
        )
    },
  },
  // The file converter of the knowledge plane (apps/backend/converter): the
  // backend tests run the real CLI. The global setup of the backend Vitest
  // config runs this before any test file, so no test waits for a build.
  // Cargo reuses an earlier build. CI restores or builds it in a job step
  // and sets SKIP_CONVERTER_BUILD=1, as for the Storybook build.
  converter: {
    prepare: () => {
      if (process.env.SKIP_CONVERTER_BUILD !== "1")
        step(
          "cargo",
          ["build", "--release", "--locked"],
          "Install rustup (rustup.rs) and fix the converter build.",
          // rustup reads rust-toolchain.toml from the working directory, so
          // Cargo runs in the converter folder: it builds with the Rust of the
          // worker image (the pin), not the Rust of the host.
          join(root, "apps/backend/converter"),
          // Only what Cargo needs: the build scripts of the crates get no
          // key of the environment. No RUSTUP_TOOLCHAIN: it would replace the
          // pin.
          Object.fromEntries(
            ["PATH", "HOME", "CARGO_HOME", "RUSTUP_HOME"]
              .filter((name) => process.env[name])
              .map((name) => [name, process.env[name]]),
          ),
        )
      quiet(
        join(root, "apps/backend/converter/target/release/ctxpipe-convert"),
        ["--version"],
        "Build the converter: pnpm checks:prepare converter, with SKIP_CONVERTER_BUILD unset.",
        // No environment, as for each conversion: the binary links the
        // crates, so it gets no key.
        {},
      )
    },
  },
  "previous-release": {
    prepare: () => {
      const tree = required(
        "RELEASE_TREE",
        "Check out the previous release with its dependencies, as the CI job upgrade-from-previous-release does, and set RELEASE_TREE to it.",
      )
      if (!existsSync(join(tree, "apps/backend/node_modules")))
        throw new Error(
          `RELEASE_TREE ${tree} has no apps/backend/node_modules. Run pnpm install --frozen-lockfile --filter "@ctxpipe/backend..." in it.`,
        )
      const { ref } = pins.previousRelease
      const expected = quiet(
        "git",
        ["rev-parse", `${ref}^{commit}`],
        `Run: git fetch origin tag ${ref}`,
      )
      const found = quiet(
        "git",
        ["-C", tree, "rev-parse", "HEAD"],
        `RELEASE_TREE ${tree} is not a git checkout.`,
      )
      if (found !== expected)
        throw new Error(
          `RELEASE_TREE ${tree} is at ${found}, not ${ref} (${expected}). Run: git -C ${tree} checkout --detach ${ref}`,
        )
    },
  },
  "aws-cdk-image-tag": {
    prepare: () =>
      step(
        process.execPath,
        ["packages/aws-cdk/scripts/stamp-image-tag.mjs"],
        "Fix the image tag stamp.",
      ),
  },
  "aws-cdk-build": {
    prepare: () =>
      step(
        "pnpm",
        ["--filter", "@ctxpipe/aws-cdk", "build"],
        "Fix the @ctxpipe/aws-cdk build.",
      ),
  },
  "docs-mdx": {
    prepare: () =>
      step(
        "pnpm",
        ["--filter", "@ctxpipe/docs", "exec", "fumadocs-mdx"],
        "Fix the docs content.",
      ),
  },
}

// The names, then each prerequisite that they need, directly or not. The
// manifest lists this closure, so that a selector can see that a check needs
// Docker (for example through the chat sandbox image) and leave it to CI on a
// host where Docker does not answer.
export function withNeeds(names) {
  const out = [...names]
  for (let i = 0; i < out.length; i++)
    for (const need of prerequisites[out[i]]?.needs ?? [])
      if (!out.includes(need)) out.push(need)
  return out
}

// Makes or verifies the named prerequisites and the ones that they need,
// each once, in order. Returns a map from each name to its error message;
// a name whose prerequisite failed fails too, and is not tried.
export async function prepare(names) {
  const failed = new Map()
  const done = new Set()
  const visit = async (name) => {
    if (done.has(name)) return
    done.add(name)
    const entry = prerequisites[name]
    if (!entry) {
      failed.set(name, `Unknown prerequisite ${name}`)
      return
    }
    for (const need of entry.needs ?? []) {
      await visit(need)
      if (failed.has(need)) {
        failed.set(name, `needs ${need}: ${failed.get(need)}`)
        return
      }
    }
    process.stderr.write(`Prerequisite ${name}\n`)
    try {
      await entry.prepare()
    } catch (error) {
      failed.set(name, error.message)
    }
  }
  for (const name of [...new Set(names)].sort()) await visit(name)
  return failed
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const names = process.argv.slice(2)
  if (!names.length) {
    process.stderr.write(
      `Usage: prerequisites.mjs <name>...\nNames: ${Object.keys(prerequisites).join(", ")}\n`,
    )
    process.exitCode = 1
  } else {
    const failed = await prepare(names)
    for (const name of names)
      process.stdout.write(
        failed.has(name)
          ? `failed ${name}: ${failed.get(name)}\n`
          : `ready ${name}\n`,
      )
    // A socket (FalkorDB, Postgres) can keep the event loop alive, so exit
    // once stdout has the lines.
    process.stdout.write("", () => process.exit(failed.size ? 1 : 0))
  }
}
