import type { SandboxHandle } from "@tanstack/ai-sandbox"
import {
  INGEST_AGENT_USER,
  type RootExec,
  runAsRoot,
  STOP_AGENT_PROCESSES,
} from "./ingest-root.js"
import { MAX_TAR_BYTES } from "./ingest-step-output.js"
import {
  INGEST_CONTEXT_ROOT,
  INGEST_HOME,
  INGEST_OPENCODE_ROOT,
  INGEST_OUT_ROOT,
  INGEST_ROOT,
  INGEST_SKILLS_ROOT,
  INGEST_SOURCE_ROOT,
  INGEST_STEP_FILE,
  type IngestSkillBundle,
} from "./skill-bundle.js"

/*
 * Prepare an ingest sandbox (ADR-052). Root owns /ctxpipe, the skill bundle,
 * the OpenCode config, the source and context checkouts, the context index,
 * and step.json. The agent runs as `ctxpipe-agent`, a user with no sudo that
 * prepare makes; root starts each agent command with `runuser`. The agent
 * owns only /ctxpipe/out and /ctxpipe/home. Before each step and before the
 * host collects a step's output, root stops every process of the agent.
 */

export { INGEST_AGENT_USER }

/** The step output that root packs for the host to read. */
const INGEST_STEP_OUTPUT = `${INGEST_ROOT}/step-output.tar`

type Sandbox = Pick<SandboxHandle, "fs" | "process">

/**
 * Ingest runs only in a Docker or Vercel sandbox. Unsandboxed mode runs the
 * agent on the backend host, so ingest refuses it.
 */
export function assertIngestProvider(provider: string): void {
  if (provider !== "docker" && provider !== "vercel")
    throw new Error(
      `Ingest needs a Docker or Vercel sandbox. The ${provider} provider runs the agent on the backend host.`,
    )
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

const PLAIN_ID = /^[A-Za-z0-9_-]+$/

async function run(handle: Sandbox, command: string): Promise<string> {
  const result = await handle.process.exec(command)
  if (result.exitCode !== 0)
    throw new Error(
      `Ingest sandbox command failed (${result.exitCode}): ${result.stderr.slice(0, 500)}`,
    )
  return result.stdout
}

/**
 * Stop every process of the agent user before a locked step does any work,
 * also one that left its process group (`setsid`, a double fork). Then no
 * process of an earlier step can use the credentials that this step gives
 * the sandbox. A sandbox with no agent user yet has no agent process.
 */
export async function stopIngestAgentProcesses(root: RootExec): Promise<void> {
  await runAsRoot(
    root,
    [
      `id -u ${INGEST_AGENT_USER} >/dev/null 2>&1 || exit 0`,
      STOP_AGENT_PROCESSES,
    ].join("\n"),
  )
}

/**
 * Root writes the file itself from base64 in the script, so no path the agent
 * can change is read. Large content goes in 48 KiB parts, below the 128 KiB
 * limit for one command argument.
 */
export async function writeAsRoot(
  root: RootExec,
  path: string,
  content: string,
): Promise<void> {
  const data = Buffer.from(content)
  const part = `${path}.part`
  await runAsRoot(root, `rm -f ${quote(part)} && : > ${quote(part)}`)
  for (let at = 0; at < data.length; at += 48 * 1024)
    await runAsRoot(
      root,
      `printf %s ${quote(data.subarray(at, at + 48 * 1024).toString("base64"))} | base64 -d >> ${quote(part)}`,
    )
  await runAsRoot(
    root,
    `chmod 644 ${quote(part)} && mv ${quote(part)} ${quote(path)}`,
  )
}

/** Fail when a root-owned copy holds a symlink or another special file. */
function refuseSpecialFiles(path: string): string {
  return `if [ -n "$(find ${quote(path)} ! -type f ! -type d | head -n 1)" ]; then rm -rf ${quote(path)}; echo "Ingest prepare: ${path} holds a symlink or a special file" >&2; exit 1; fi`
}

/** Writes each file of a packed bundle under a folder; then deletes the pack. */
const UNPACK_BUNDLE = `const fs = require("node:fs"), path = require("node:path")
const [dir, pack] = process.argv.slice(1)
for (const file of JSON.parse(fs.readFileSync(pack, "utf8"))) {
  const target = path.join(dir, file.path)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, Buffer.from(file.data, "base64"))
}
fs.rmSync(pack)`

/**
 * Run once for each sandbox: make the agent user, the /ctxpipe layout, the
 * skill bundle, and the OpenCode config. The bundle is always copied again.
 */
export async function prepareIngestSandbox(
  handle: Sandbox,
  root: RootExec,
  input: { bundle: IngestSkillBundle; opencodeConfig: unknown },
): Promise<void> {
  // The default user (never the agent) writes a private staging copy; root
  // copies it, checks the copy, and moves it into place.
  const staging = (await run(handle, "mktemp -d")).trim()
  // One upload for the whole bundle: a hosted sandbox makes one API call
  // for each file write, and each call can fail on its own.
  const packed = `${staging}.json`
  await handle.fs.write(
    packed,
    new TextEncoder().encode(
      JSON.stringify(
        input.bundle.files.map((file) => ({
          path: file.path,
          data: Buffer.from(file.content).toString("base64"),
        })),
      ),
    ),
  )
  await run(
    handle,
    `node -e ${quote(UNPACK_BUNDLE)} ${quote(staging)} ${quote(packed)}`,
  )
  const next = `${INGEST_SKILLS_ROOT}.next`
  const executables = input.bundle.files
    .filter((f) => f.executable)
    .map((f) => quote(`${next}/${f.path}`))
  const agent = INGEST_AGENT_USER
  await runAsRoot(
    root,
    [
      "set -e",
      `id -u ${agent} >/dev/null 2>&1 || useradd --system --user-group --no-create-home --shell /bin/sh ${agent}`,
      `mkdir -p ${INGEST_ROOT} ${INGEST_CONTEXT_ROOT} ${INGEST_SOURCE_ROOT} ${INGEST_OPENCODE_ROOT} ${INGEST_OUT_ROOT} ${INGEST_HOME}`,
      `chown root:root ${INGEST_ROOT} ${INGEST_CONTEXT_ROOT} ${INGEST_SOURCE_ROOT} ${INGEST_OPENCODE_ROOT}`,
      `chmod 755 ${INGEST_ROOT} ${INGEST_CONTEXT_ROOT} ${INGEST_SOURCE_ROOT} ${INGEST_OPENCODE_ROOT}`,
      `chown -R ${agent}:${agent} ${INGEST_OUT_ROOT} ${INGEST_HOME}`,
      `rm -rf ${next}`,
      `cp -R ${quote(staging)} ${next}`,
      refuseSpecialFiles(next),
      `chown -R root:root ${next}`,
      `chmod -R u=rwX,go=rX ${next}`,
      ...(executables.length > 0 ? [`chmod 755 ${executables.join(" ")}`] : []),
      `rm -rf ${INGEST_SKILLS_ROOT}`,
      `mv ${next} ${INGEST_SKILLS_ROOT}`,
      `rm -rf ${quote(staging)}`,
    ].join("\n"),
  )
  await writeAsRoot(
    root,
    `${INGEST_OPENCODE_ROOT}/opencode.json`,
    JSON.stringify(input.opencodeConfig, null, 2),
  )
}

/**
 * Shell lines that copy the git checkout `from` to the new folder `to`.
 * Root never runs git in `from`: it copies only the object store, the refs,
 * HEAD, and the shallow list, and makes a new config and a new work tree.
 * A `git clone` of a shallow blobless checkout fails, because the copy does
 * not have most blobs of its history and cannot send them. The new copy is
 * not a partial clone: a read of a missing blob fails and fetches nothing.
 */
export function copyCheckoutScript(input: {
  from: string
  to: string
  /** The remote that later steps fetch from; default: `from`. */
  remoteUrl?: string
}): string[] {
  const from = quote(`${input.from}/.git`)
  const to = quote(input.to)
  const git = `git -C ${to}`
  return [
    `rm -rf ${to}`,
    `if [ -L ${from} ] || [ -n "$(find ${from} -maxdepth 1 -type l)" ]; then echo "Ingest prepare: the git folder of the checkout holds a symlink" >&2; exit 1; fi`,
    `git init -q ${to}`,
    `cp -R ${from}/objects/. ${to}/.git/objects/`,
    `rm -f ${to}/.git/objects/info/alternates ${to}/.git/objects/info/http-alternates`,
    `cp -R ${from}/refs/. ${to}/.git/refs/`,
    `for f in HEAD packed-refs shallow; do if [ -f ${from}/$f ]; then cp ${from}/$f ${to}/.git/$f; fi; done`,
    refuseSpecialFiles(`${input.to}/.git`),
    `${git} remote add origin ${quote(input.remoteUrl ?? input.from)}`,
    // The checkout of `from` has every blob of HEAD; root fetches nothing.
    `GIT_NO_LAZY_FETCH=1 ${git} reset -q --hard`,
  ]
}

/**
 * Copy a checkout that prepare cloned as the default user to
 * `/ctxpipe/<context|source>/<id>`, owned by root. Root copies only its git
 * objects and refs (`copyCheckoutScript`), so no hook, config, or symlink in
 * the user's copy reaches root. Git reads it as the agent through a system
 * `safe.directory` entry.
 */
export async function sealIngestCheckout(
  root: RootExec,
  input: {
    kind: "context" | "source"
    /** The Workspace id (context) or the source handle (source). */
    id: string
    from: string
    /** The remote that later steps fetch from; default: keep `from`. */
    remoteUrl?: string
  },
): Promise<string> {
  if (!PLAIN_ID.test(input.id))
    throw new Error(`Ingest ${input.kind}: the id is not a plain id`)
  const target = `${input.kind === "context" ? INGEST_CONTEXT_ROOT : INGEST_SOURCE_ROOT}/${input.id}`
  const next = `${target}.next`
  await runAsRoot(
    root,
    [
      "set -e",
      ...copyCheckoutScript({ ...input, to: next }),
      `chown -R root:root ${next}`,
      `chmod -R u=rwX,go=rX ${next}`,
      `rm -rf ${target}`,
      `mv ${next} ${target}`,
      // A Vercel sandbox's Git (under /opt/git) has no folder for its
      // system config yet.
      'sys=$(git var GIT_CONFIG_SYSTEM 2>/dev/null || true); if [ -n "$sys" ]; then mkdir -p "$(dirname "$sys")"; fi',
      `git config --system --get-all safe.directory | grep -qxF ${target} || git config --system --add safe.directory ${target}`,
    ].join("\n"),
  )
  return target
}

/**
 * A run-scoped ingest ref (ADR-052 section 6), at most
 * `<runId>/<workspaceId>/shards/<shard>` (see `ingest-refs.ts`).
 */
const INGEST_REF =
  /^refs\/ctxpipe\/ingest\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+){0,3}$/

/**
 * Start a step, as root: stop every agent process, fetch the shard ref, put
 * the context checkout at the step's base commit, place the context index,
 * empty /ctxpipe/out and /ctxpipe/home, and write /ctxpipe/step.json for the
 * stage helpers.
 */
export async function startIngestStep(
  root: RootExec,
  input: {
    workspaceId: string
    baseCommit: string
    /** The shard ref to fetch first; absent when the commit is already there. */
    fetch?: { remote: string; ref: string }
    /** The T07 `<workspaceId>.index.json` content. */
    index?: string
  },
): Promise<void> {
  if (!PLAIN_ID.test(input.workspaceId))
    throw new Error("Ingest step: the Workspace id is not a plain id")
  if (!/^[0-9a-f]{40,64}$/.test(input.baseCommit))
    throw new Error("Ingest step: the base commit is not a full SHA")
  if (input.fetch && !INGEST_REF.test(input.fetch.ref))
    throw new Error("Ingest step: the ref is not an ingest ref")
  const context = `${INGEST_CONTEXT_ROOT}/${input.workspaceId}`
  const agent = INGEST_AGENT_USER
  await runAsRoot(
    root,
    [
      "set -e",
      STOP_AGENT_PROCESSES,
      ...(input.fetch
        ? [
            `git -C ${context} fetch -q -- ${quote(input.fetch.remote)} ${quote(input.fetch.ref)}`,
          ]
        : []),
      `git -C ${context} checkout -q --detach ${input.baseCommit}`,
      `test "$(git -C ${context} rev-parse HEAD)" = ${input.baseCommit}`,
      `rm -rf ${INGEST_OUT_ROOT} ${INGEST_HOME} ${INGEST_STEP_OUTPUT} || { echo "Cannot empty ${INGEST_OUT_ROOT} and ${INGEST_HOME}" >&2; exit 1; }`,
      `mkdir -p ${INGEST_OUT_ROOT}/files ${INGEST_HOME}`,
      `chown -R ${agent}:${agent} ${INGEST_OUT_ROOT} ${INGEST_HOME}`,
      `chmod 755 ${INGEST_OUT_ROOT} ${INGEST_HOME}`,
    ].join("\n"),
  )
  if (input.index !== undefined)
    await writeAsRoot(root, `${context}.index.json`, input.index)
  await writeAsRoot(
    root,
    INGEST_STEP_FILE,
    JSON.stringify({
      workspaceId: input.workspaceId,
      baseCommit: input.baseCommit,
    }),
  )
}

/**
 * Collect a finished step, as root: stop every agent process so the output
 * cannot change, then pack /ctxpipe/out into a root-owned tar. `tar` without
 * `-h` stores a symlink as a link and never reads its target, so the host
 * patch validator sees it and rejects it. Returns the tar bytes.
 */
export async function collectIngestStep(
  handle: Sandbox,
  root: RootExec,
): Promise<Uint8Array> {
  await runAsRoot(
    root,
    [
      "set -e",
      STOP_AGENT_PROCESSES,
      `rm -f ${INGEST_STEP_OUTPUT}`,
      `tar -C ${INGEST_OUT_ROOT} -cf ${INGEST_STEP_OUTPUT} .`,
      `chmod 644 ${INGEST_STEP_OUTPUT}`,
      // The size check is in the sandbox: a read of a tar of gigabytes
      // would fill the worker heap before the host could refuse it (CTX-971).
      `size=$(wc -c < ${INGEST_STEP_OUTPUT})`,
      `if [ "$size" -gt ${MAX_TAR_BYTES} ]; then echo "The step output is $size bytes; the limit is ${MAX_TAR_BYTES} bytes. The skill wrote too much into ${INGEST_OUT_ROOT}." >&2; exit 1; fi`,
    ].join("\n"),
  )
  return handle.fs.readBytes(INGEST_STEP_OUTPUT)
}
