import { dirname } from "node:path/posix"
import type { SandboxHandle } from "@tanstack/ai-sandbox"
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
 * and step.json. The agent runs as a user with no sudo. It owns only
 * /ctxpipe/out and /ctxpipe/home, and both are emptied before each step.
 */

/** Runs a shell script as root in the sandbox (see `ingest-root.ts`). */
export type RunAsRoot = (script: string) => Promise<void>

type Sandbox = Pick<SandboxHandle, "fs" | "process">

/** The Vercel agent user. Prepare makes it; it is in no sudoers file. */
export const INGEST_AGENT_USER = "ctxpipe-agent"

/**
 * The user the agent runs as. Docker: the image's nonroot user, which has no
 * sudo. Vercel: the default user has passwordless sudo, so the agent is a
 * separate user. Unsandboxed mode runs the agent on the backend host, so
 * ingest refuses it.
 */
export function ingestAgentUser(provider: string): string | null {
  if (provider === "docker") return null
  if (provider === "vercel") return INGEST_AGENT_USER
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

/** `user:group` for chown: the agent user, else the default user's ids. */
async function agentOwner(
  handle: Sandbox,
  agentUser: string | null,
): Promise<string> {
  if (agentUser) return `${agentUser}:${agentUser}`
  const owner = (
    await run(handle, 'printf "%s:%s" "$(id -u)" "$(id -g)"')
  ).trim()
  if (!/^\d+:\d+$/.test(owner))
    throw new Error(`Ingest sandbox: unexpected user ids ${owner}`)
  return owner
}

/**
 * Root writes the file itself from base64 in the script, so no path the agent
 * can change is read. Large content goes in 48 KiB parts, below the 128 KiB
 * limit for one command argument.
 */
async function writeAsRoot(
  asRoot: RunAsRoot,
  path: string,
  content: string,
): Promise<void> {
  const data = Buffer.from(content)
  const part = `${path}.part`
  await asRoot(`rm -f ${quote(part)} && : > ${quote(part)}`)
  for (let at = 0; at < data.length; at += 48 * 1024)
    await asRoot(
      `printf %s ${quote(data.subarray(at, at + 48 * 1024).toString("base64"))} | base64 -d >> ${quote(part)}`,
    )
  await asRoot(`chmod 644 ${quote(part)} && mv ${quote(part)} ${quote(path)}`)
}

/** Fail when a root-owned copy holds a symlink or another special file. */
function refuseSpecialFiles(path: string): string {
  return `if [ -n "$(find ${quote(path)} ! -type f ! -type d | head -n 1)" ]; then rm -rf ${quote(path)}; echo "Ingest prepare: ${path} holds a symlink or a special file" >&2; exit 1; fi`
}

/**
 * Run once for each sandbox: make the agent user (Vercel), the /ctxpipe
 * layout, the skill bundle, and the OpenCode config. The bundle is always
 * copied again.
 */
export async function prepareIngestSandbox(
  handle: Sandbox,
  asRoot: RunAsRoot,
  input: {
    bundle: IngestSkillBundle
    agentUser: string | null
    opencodeConfig: unknown
  },
): Promise<void> {
  if (input.agentUser !== null && !PLAIN_ID.test(input.agentUser))
    throw new Error("Ingest prepare: the agent user is not a plain name")
  const owner = await agentOwner(handle, input.agentUser)
  // The default user writes a private staging copy; root copies it, checks
  // the copy, and moves it into place.
  const staging = (await run(handle, "mktemp -d")).trim()
  const folders = new Set(input.bundle.files.map((f) => dirname(f.path)))
  await run(
    handle,
    `mkdir -p ${[...folders].map((f) => quote(`${staging}/${f}`)).join(" ")}`,
  )
  for (const file of input.bundle.files)
    await handle.fs.write(
      `${staging}/${file.path}`,
      new Uint8Array(file.content),
    )
  const next = `${INGEST_SKILLS_ROOT}.next`
  const executables = input.bundle.files
    .filter((f) => f.executable)
    .map((f) => quote(`${next}/${f.path}`))
  await asRoot(
    [
      "set -e",
      ...(input.agentUser
        ? [
            `id -u ${input.agentUser} >/dev/null 2>&1 || useradd --system --user-group --no-create-home --shell /bin/sh ${input.agentUser}`,
          ]
        : []),
      `mkdir -p ${INGEST_ROOT} ${INGEST_CONTEXT_ROOT} ${INGEST_SOURCE_ROOT} ${INGEST_OPENCODE_ROOT} ${INGEST_OUT_ROOT} ${INGEST_HOME}`,
      `chown root:root ${INGEST_ROOT} ${INGEST_CONTEXT_ROOT} ${INGEST_SOURCE_ROOT} ${INGEST_OPENCODE_ROOT}`,
      `chmod 755 ${INGEST_ROOT} ${INGEST_CONTEXT_ROOT} ${INGEST_SOURCE_ROOT} ${INGEST_OPENCODE_ROOT}`,
      `chown -R ${owner} ${INGEST_OUT_ROOT} ${INGEST_HOME}`,
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
    asRoot,
    `${INGEST_OPENCODE_ROOT}/opencode.json`,
    JSON.stringify(input.opencodeConfig, null, 2),
  )
}

/**
 * Copy a checkout that prepare cloned as the default user to
 * `/ctxpipe/<context|source>/<id>`, owned by root. Root clones it with git,
 * so no hook, config, or symlink in the user's copy reaches root. Git reads
 * it as the agent through a system `safe.directory` entry.
 */
export async function sealIngestCheckout(
  asRoot: RunAsRoot,
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
  await asRoot(
    [
      "set -e",
      `rm -rf ${next}`,
      // The user's copy has another owner; a throwaway global config lets
      // root read it (upload-pack ignores a -c safe.directory).
      'export GIT_CONFIG_GLOBAL="$(mktemp)"',
      "git config --global safe.directory '*'",
      `git clone -q --no-hardlinks -- ${quote(input.from)} ${next}`,
      'rm -f "$GIT_CONFIG_GLOBAL"',
      ...(input.remoteUrl
        ? [`git -C ${next} remote set-url origin ${quote(input.remoteUrl)}`]
        : []),
      `chown -R root:root ${next}`,
      `chmod -R u=rwX,go=rX ${next}`,
      `rm -rf ${target}`,
      `mv ${next} ${target}`,
      `git config --system --get-all safe.directory | grep -qxF ${target} || git config --system --add safe.directory ${target}`,
    ].join("\n"),
  )
  return target
}

/**
 * Start a step: as root, fetch the shard ref, put the context checkout at
 * the step's base commit, place the context index, empty the agent's
 * /ctxpipe/out and /ctxpipe/home, and write /ctxpipe/step.json for the stage
 * helpers.
 */
export async function startIngestStep(
  handle: Sandbox,
  asRoot: RunAsRoot,
  input: {
    workspaceId: string
    baseCommit: string
    agentUser: string | null
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
  const owner = await agentOwner(handle, input.agentUser)
  const context = `${INGEST_CONTEXT_ROOT}/${input.workspaceId}`
  await asRoot(
    [
      "set -e",
      ...(input.fetch
        ? [
            `git -C ${context} fetch -q ${quote(input.fetch.remote)} ${quote(input.fetch.ref)}`,
          ]
        : []),
      `git -C ${context} checkout -q --detach ${input.baseCommit}`,
      `test "$(git -C ${context} rev-parse HEAD)" = ${input.baseCommit}`,
      `rm -rf ${INGEST_OUT_ROOT} ${INGEST_HOME}`,
      `mkdir -p ${INGEST_OUT_ROOT}/files ${INGEST_HOME}`,
      `chown -R ${owner} ${INGEST_OUT_ROOT} ${INGEST_HOME}`,
      `chmod 755 ${INGEST_OUT_ROOT} ${INGEST_HOME}`,
    ].join("\n"),
  )
  if (input.index !== undefined)
    await writeAsRoot(asRoot, `${context}.index.json`, input.index)
  await writeAsRoot(
    asRoot,
    INGEST_STEP_FILE,
    JSON.stringify({
      workspaceId: input.workspaceId,
      baseCommit: input.baseCommit,
    }),
  )
}
