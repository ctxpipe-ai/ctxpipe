import type { SandboxHandle } from "@tanstack/ai-sandbox"
import {
  assertIngestOpenCodeVersion,
  type IngestOpenCodeConfig,
  ingestAgentCommand,
  ingestOpenCodeEnv,
} from "./ingest-opencode.js"
import {
  prepareIngestSandbox,
  sealIngestCheckout,
  startIngestStep,
} from "./ingest-prepare.js"
import { type RootExec, runAsRoot } from "./ingest-root.js"
import type { IngestRuntimeStep } from "./ingest-shard-runtime.js"
import {
  INGEST_CONTEXT_ROOT,
  INGEST_ROOT,
  INGEST_SKILLS_ROOT,
  INGEST_SOURCE_ROOT,
  type IngestSkillBundle,
} from "./skill-bundle.js"

/*
 * The commands of one ingest shard in its sandbox (ADR-052 section 7), for
 * any provider: `handle` runs as the sandbox's default user, `root` as root.
 * The default user clones (its network goes through the egress proxy); root
 * seals each clone, so the agent can only read it. The agent runs each skill
 * as `ctxpipe-agent`, with only the environment that `agentEnv` gives.
 */

type Sandbox = Pick<SandboxHandle, "fs" | "process">

/** The source checkout: `/ctxpipe/source/source`. */
export const INGEST_SOURCE_HANDLE = "source"
const SOURCE_DIR = `${INGEST_SOURCE_ROOT}/${INGEST_SOURCE_HANDLE}`
/** Root writes it last in prepare; the agent cannot write in /ctxpipe. */
const PREPARED = `${INGEST_ROOT}/prepared`
/** Concept section 5.4: 180 days of history. */
const HISTORY_DAYS = 180
/** One step: 10 minutes (concept section 8). */
export const INGEST_STEP_LIMIT_MS = 10 * 60_000

/**
 * The time limit of one step. At the limit, the step's exec ends its process
 * group in the sandbox before the step returns, so a retry never runs while
 * an old `opencode run` lives.
 */
export function ingestStepSignal(): AbortSignal {
  const controller = new AbortController()
  setTimeout(
    () => controller.abort(new Error("The ingest step reached its time limit")),
    INGEST_STEP_LIMIT_MS,
  ).unref?.()
  return controller.signal
}

/** The discover-roots result may be at most this large. */
const MAX_DISCOVERY_BYTES = 1024 * 1024

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

async function run(handle: Sandbox, command: string): Promise<string> {
  const result = await handle.process.exec(command)
  if (result.exitCode !== 0)
    throw new Error(
      `Ingest shard command failed (${result.exitCode}): ${result.stderr.slice(-500)}`,
    )
  return result.stdout
}

/** True when an earlier `prepareIngestShard` finished in this sandbox. */
export async function ingestShardPrepared(root: RootExec): Promise<boolean> {
  return (await root(`test -f ${PREPARED}`)).exitCode === 0
}

/**
 * Prepare a new shard sandbox: the bundle and the OpenCode config, the
 * source at the run's SHA with 180 days of history (blobless), and each
 * destination Workspace repository. Each clone is made again from the start,
 * so a failed prepare can run again.
 */
export async function prepareIngestShard(
  handle: Sandbox,
  root: RootExec,
  input: {
    bundle: IngestSkillBundle
    opencodeConfig: IngestOpenCodeConfig
    agentEnv: Record<string, string>
    source: { url: string; sha: string }
    contexts: Array<{ workspaceId: string; url: string }>
    now: Date
  },
): Promise<void> {
  await prepareIngestSandbox(handle, root, {
    bundle: input.bundle,
    opencodeConfig: input.opencodeConfig,
  })
  await assertIngestOpenCodeVersion(root, input.agentEnv)
  const since = new Date(input.now.getTime() - HISTORY_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10)
  const sourceClone = "/tmp/ctxpipe-clone-source"
  await run(
    handle,
    [
      `rm -rf ${sourceClone}`,
      `git clone -q --filter=blob:none --no-checkout --shallow-since=${since} -- ${quote(input.source.url)} ${sourceClone}`,
      // The run's SHA can be older than the history window.
      `(git -C ${sourceClone} cat-file -e ${input.source.sha}^{commit} 2>/dev/null || git -C ${sourceClone} fetch -q --filter=blob:none --depth=1 origin ${input.source.sha})`,
      `git -C ${sourceClone} checkout -q --detach ${input.source.sha}`,
    ].join(" && "),
  )
  await sealIngestCheckout(root, {
    kind: "source",
    id: INGEST_SOURCE_HANDLE,
    from: sourceClone,
    remoteUrl: input.source.url,
  })
  for (const context of input.contexts) {
    const clone = `/tmp/ctxpipe-clone-${context.workspaceId}`
    await run(
      handle,
      `rm -rf ${quote(clone)} && git clone -q -- ${quote(context.url)} ${quote(clone)}`,
    )
    await sealIngestCheckout(root, {
      kind: "context",
      id: context.workspaceId,
      from: clone,
      remoteUrl: context.url,
    })
  }
  await run(
    handle,
    `rm -rf ${sourceClone} ${input.contexts.map((c) => quote(`/tmp/ctxpipe-clone-${c.workspaceId}`)).join(" ")}`,
  )
  await runAsRoot(root, `touch ${PREPARED} && chmod 644 ${PREPARED}`)
}

/**
 * Run the bundle's `discover-roots` script as the agent; return its parsed
 * JSON. The host checks it (`resolveDiscoveredRoots`) before it plans roots.
 */
export async function discoverIngestRoots(
  root: RootExec,
  agentEnv: Record<string, string>,
  signal?: AbortSignal,
): Promise<unknown> {
  const result = await root(
    ingestAgentCommand({
      env: agentEnv,
      command: `node ${INGEST_SKILLS_ROOT}/discover-roots/scripts/discover-roots.mjs ${SOURCE_DIR}`,
    }),
    signal ? { signal } : undefined,
  )
  if (result.exitCode !== 0)
    throw new Error(`discover-roots failed: ${result.stderr.slice(-500)}`)
  if (result.stdout.length > MAX_DISCOVERY_BYTES)
    throw new Error("discover-roots wrote too much output")
  return JSON.parse(result.stdout)
}

/** The prompt of one model step. Source paths are data: they are quoted. */
export function ingestStepPrompt(step: IngestRuntimeStep): string {
  return [
    `Run the skill ${step.skill}.`,
    `The root is ${JSON.stringify(step.root)} in the source checkout ${SOURCE_DIR}.`,
    `The Workspace is ${step.workspaceId}: its context checkout is ${INGEST_CONTEXT_ROOT}/${step.workspaceId}, and its index is ${INGEST_CONTEXT_ROOT}/${step.workspaceId}.index.json.`,
    "When you are done, run ctxpipe-finish.",
  ].join(" ")
}

/** The `--roots` file of a repository-wide script step; root writes it. */
const ROOTS_FILE = `${INGEST_ROOT}/roots.json`

/**
 * Run one skill step: root starts the step (fetch the ref, put the context
 * checkout at the base commit, place the index), the agent runs the skill,
 * then `ctxpipe-finish` writes patch.json. A model step is one `opencode run`.
 * A script step gets `--source`, `--source-url`, and `--roots` (ADR-052
 * section 6), and returns the `more` of its result line.
 */
export async function runIngestShardStep(
  root: RootExec,
  input: {
    step: IngestRuntimeStep
    agentEnv: Record<string, string>
    /** The Workspace remote that the ref is fetched from. */
    remote: string
    /** The source repository URL that the step's files cite. */
    sourceUrl: string
    index?: string
    /** `ctxpipe/<model>` for a model step. */
    model?: string
  },
): Promise<{ more: boolean }> {
  const { step } = input
  await startIngestStep(root, {
    workspaceId: step.workspaceId,
    baseCommit: step.baseCommit,
    ...(step.fetchRef
      ? { fetch: { remote: input.remote, ref: step.fetchRef } }
      : {}),
    ...(input.index !== undefined ? { index: input.index } : {}),
  })
  const env = {
    ...input.agentEnv,
    CTXPIPE_SOURCE: SOURCE_DIR,
    CTXPIPE_ROOT: step.root,
    CTXPIPE_WORKSPACE: step.workspaceId,
    CTXPIPE_CONTEXT: `${INGEST_CONTEXT_ROOT}/${step.workspaceId}`,
  }
  if (step.run === "script") {
    // One exec argument holds at most 128 KiB on Linux: write in parts.
    const json = JSON.stringify(step.rootMap ?? { roots: [] })
    await runAsRoot(root, `: > ${ROOTS_FILE} && chmod 644 ${ROOTS_FILE}`)
    for (let at = 0; at < json.length; at += 60_000)
      await runAsRoot(
        root,
        `printf '%s' ${quote(json.slice(at, at + 60_000))} >> ${ROOTS_FILE}`,
      )
  }
  const command =
    step.run === "model"
      ? `opencode run${input.model ? ` --model ${quote(input.model)}` : ""} ${quote(ingestStepPrompt(step))}`
      : `node ${INGEST_SKILLS_ROOT}/${step.skill}/scripts/${step.skill}.mjs --source ${SOURCE_DIR} --source-url ${quote(input.sourceUrl)} --roots ${ROOTS_FILE}`
  let more = false
  for (const part of [command, "ctxpipe-finish"]) {
    const result = await root(ingestAgentCommand({ env, command: part }), {
      signal: step.signal,
    })
    if (result.exitCode !== 0)
      throw new Error(
        `Ingest step ${step.name} failed (${result.exitCode}): ${result.stderr.slice(-500)}`,
      )
    if (part === command && step.run === "script")
      more = scriptResultMore(result.stdout)
  }
  return { more }
}

/** The `more` of a script step's last stdout line (`{ ops, skipped, more }`). */
export function scriptResultMore(stdout: string): boolean {
  const last = stdout.trim().split("\n").pop() ?? ""
  try {
    return (JSON.parse(last) as { more?: unknown }).more === true
  } catch {
    return false
  }
}

/**
 * The agent's environment: the OpenCode isolation flags, the stage helpers
 * on PATH, and the sandbox's egress proxy settings. `env -i` gives the agent
 * nothing else.
 */
export async function ingestAgentEnv(
  root: RootExec,
  input: { modelProxyUrl: string },
): Promise<Record<string, string>> {
  const result = await root("tr '\\0' '\\n' < /proc/1/environ")
  const keep =
    /^(https?_proxy|HTTPS?_PROXY|no_proxy|NO_PROXY|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|GIT_SSL_CAINFO|PATH)$/
  const sandbox = Object.fromEntries(
    result.stdout
      .split("\n")
      .map((line) => [
        line.slice(0, line.indexOf("=")),
        line.slice(line.indexOf("=") + 1),
      ])
      .filter(([key]) => key && keep.test(key)),
  )
  const { PATH: path = "/usr/local/bin:/usr/bin:/bin", ...proxy } = sandbox
  return {
    ...proxy,
    ...ingestOpenCodeEnv({ path }),
    CTXPIPE_MODEL_PROXY_URL: input.modelProxyUrl,
  }
}
