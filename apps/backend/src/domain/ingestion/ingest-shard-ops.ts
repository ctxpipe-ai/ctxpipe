import type { SandboxHandle, SandboxProcess } from "@tanstack/ai-sandbox"
import { z } from "zod"

import {
  ingestModelRunCommand,
  type OpenCodeError,
  openCodeModelCalls,
  parseOpenCodeErrors,
  parseOpenCodeUsage,
} from "./ingest-opencode-usage.js"
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
  writeAsRoot,
} from "./ingest-prepare.js"
import { type RootExec, runAsRoot } from "./ingest-root.js"
import type {
  IngestRuntimeStep,
  IngestStepUsage,
} from "./ingest-shard-runtime.js"
import { logIngestEvent } from "./ingest-telemetry.js"
import {
  INGEST_CONTEXT_ROOT,
  INGEST_OUT_ROOT,
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
type SandboxExec = { process: Pick<SandboxProcess, "exec"> }

/** The source checkout: `/ctxpipe/source/source`. */
const INGEST_SOURCE_HANDLE = "source"
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
 * an old `opencode run` lives. `leadMs` makes the signal abort that much
 * earlier.
 */
export function ingestStepSignal(leadMs = 0): AbortSignal {
  const controller = new AbortController()
  setTimeout(
    () => controller.abort(new IngestStepTimeLimitError()),
    INGEST_STEP_LIMIT_MS - leadMs,
  ).unref?.()
  return controller.signal
}

/** A step that reached its time limit or its checkpoint with nothing staged. */
export class IngestStepTimeLimitError extends Error {
  constructor() {
    super("The ingest step reached its time limit")
    this.name = "IngestStepTimeLimitError"
  }
}

/**
 * The checkpoint of one step, one minute before its limit
 * (`IngestRuntimeStep.checkpoint`). A step that the limit ends loses its
 * work, and the retry starts over. The minute gives the host time to stop
 * the model, run `ctxpipe-finish`, and collect the step output.
 */
export function ingestStepCheckpoint(): AbortSignal {
  return ingestStepSignal(60_000)
}

/** The discover-roots result may be at most this large. */
const MAX_DISCOVERY_BYTES = 1024 * 1024

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

async function run(
  handle: SandboxExec,
  command: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = await handle.process.exec(command, signal ? { signal } : {})
  // The Docker provider resolves an aborted exec with exit code 0.
  signal?.throwIfAborted()
  if (result.exitCode !== 0)
    throw new Error(
      `Ingest shard command failed (${result.exitCode}): ${result.stderr.slice(-500)}`,
    )
  return result.stdout
}

/** True for a 429 of the egress proxy or of the Git host to a Git command. */
function isFetch429(error: unknown): boolean {
  return (
    error instanceof Error &&
    /CONNECT tunnel failed, response 429|returned error: 429/.test(
      error.message,
    )
  )
}

/**
 * The Retry-After (in seconds) of the egress proxy's answer to a request to
 * the origin of `url`; no output when the answer has none. `-D -` writes the
 * headers of the CONNECT answer too.
 */
export function retryAfterProbeCommand(url: string): string {
  return `curl -s -o /dev/null -D - -m 10 ${quote(`${new URL(url).origin}/`)} 2>/dev/null | tr -d '\\r' | sed -n 's/^[Rr]etry-[Aa]fter: *\\([0-9][0-9]*\\)$/\\1/p' | tail -n 1`
}

/**
 * Run a clone or a fetch of `url` through the egress proxy. On a 429 (Agent
 * Vault refuses the CONNECT, or the proxy or the Git host refuses a request
 * in the tunnel), the command runs again, at most 3 times (CTX-1470).
 *
 * Git does not show the Retry-After of the answer. Thus a curl request to
 * the same origin through the proxy reads it: curl sends the session in its
 * first CONNECT, and Agent Vault's CONNECT gate only reads its count of
 * failures. The wait is that Retry-After and one second (Agent Vault cuts
 * the fraction of a second). With no Retry-After, the waits are 5, 15 and
 * 30 seconds. All the waits of one command are at most 2 minutes: when the
 * next wait goes past that, the 429 fails the step at once. So a short
 * burst delays the shard, and a long block fails it soon.
 *
 * The command must start again from nothing (for example, it removes its
 * clone first).
 */
export async function runIngestFetch(
  handle: SandboxExec,
  input: { command: string; url: string; signal?: AbortSignal },
): Promise<string> {
  const { signal } = input
  const fallbackWaitsMs = [5_000, 15_000, 30_000]
  let waitedMs = 0
  for (let attempt = 0; ; attempt++) {
    try {
      return await run(handle, input.command, signal)
    } catch (error) {
      const fallbackMs = fallbackWaitsMs[attempt]
      if (fallbackMs === undefined || !isFetch429(error)) throw error
      const probe = await handle.process.exec(
        retryAfterProbeCommand(input.url),
        signal ? { signal } : {},
      )
      const retryAfterS = Number.parseInt(probe.stdout.trim(), 10)
      const waitMs = Number.isNaN(retryAfterS)
        ? fallbackMs
        : (retryAfterS + 1) * 1000
      if (waitedMs + waitMs > 120_000) throw error
      waitedMs += waitMs
      logIngestEvent("warn", "ingestion-v2.fetch-429", {
        attempt: attempt + 1,
        waitMs,
        retryAfter: Number.isNaN(retryAfterS) ? null : retryAfterS,
      })
      await waitFor(waitMs, signal)
    }
  }
}

/**
 * Wait `ms`, or until `signal` aborts. It uses the global `setTimeout`, not
 * `node:timers/promises`: Vitest's fake timers do not replace that module.
 */
async function waitFor(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort)
      resolve()
    }, ms)
    signal?.addEventListener("abort", abort, { once: true })
  })
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
    /**
     * `blobless`: a blobless clone, whose missing blobs a step fetches
     * later (GitHub). A plain git source gets each blob of the window now:
     * a step cannot reach its host.
     */
    source: { url: string; sha: string; blobless: boolean }
    contexts: Array<{ workspaceId: string; url: string }>
    now: Date
    /**
     * The step's signal. Each clone also stops at the step limit, so a git
     * host that stops to send cannot hold the shard lock.
     */
    signal?: AbortSignal
  },
): Promise<void> {
  const signal = input.signal
    ? AbortSignal.any([input.signal, ingestStepSignal()])
    : ingestStepSignal()
  await prepareIngestSandbox(handle, root, {
    bundle: input.bundle,
    opencodeConfig: input.opencodeConfig,
  })
  await assertIngestOpenCodeVersion(root, input.agentEnv)
  const since = new Date(input.now.getTime() - HISTORY_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10)
  const sourceClone = "/tmp/ctxpipe-clone-source"
  const filter = input.source.blobless ? " --filter=blob:none" : ""
  // A plain git source (no blobless clone) comes from a host that we do not
  // control: git stops when that host sends less than 1000 bytes each
  // second for 60 seconds. The clone keeps this config for the fetch below.
  const cloneSource = `git clone -q${filter}${input.source.blobless ? "" : " -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=60"}`
  const url = input.source.url
  const sourceCloneStep = (depth: string) => ({
    command: `rm -rf ${sourceClone} && ${cloneSource} --no-checkout ${depth} -- ${quote(url)} ${sourceClone}`,
    url,
    signal,
  })
  await runIngestFetch(
    handle,
    sourceCloneStep(`--shallow-since=${since}`),
  ).catch(async (error: unknown) => {
    // A repository with no commit in the window fails a `--shallow-since`
    // clone ("error processing shallow info"): then clone its tip only.
    // A 429 that stays, or the end of the step, fails the step.
    if (isFetch429(error) || signal.aborted) throw error
    await runIngestFetch(handle, sourceCloneStep("--depth=1"))
  })
  await runIngestFetch(handle, {
    command: [
      // The run's SHA can be older than the history window.
      `(git -C ${sourceClone} cat-file -e ${input.source.sha}^{commit} 2>/dev/null || git -C ${sourceClone} fetch -q${filter} --depth=1 origin ${input.source.sha})`,
      `git -C ${sourceClone} checkout -q --detach ${input.source.sha}`,
    ].join(" && "),
    url,
    signal,
  })
  await sealIngestCheckout(root, {
    kind: "source",
    id: INGEST_SOURCE_HANDLE,
    from: sourceClone,
    remoteUrl: input.source.url,
  })
  for (const context of input.contexts) {
    const clone = `/tmp/ctxpipe-clone-${context.workspaceId}`
    await runIngestFetch(handle, {
      command: `rm -rf ${quote(clone)} && git clone -q -- ${quote(context.url)} ${quote(clone)}`,
      url: context.url,
      signal,
    })
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
 * The HTTP status of the model proxy's model list, asked as the agent with
 * its environment, so through the egress proxy and its credential rules.
 * `000`: no answer in 20 seconds; `none`: no status (for example no curl).
 * It shows a broken model path before a model step waits for it.
 */
export async function probeIngestModelProxy(
  root: RootExec,
  agentEnv: Record<string, string>,
): Promise<string> {
  const result = await root(
    ingestAgentCommand({
      env: agentEnv,
      command: `curl -s -o /dev/null -m 20 -w '%{http_code}' "$CTXPIPE_MODEL_PROXY_URL/models"`,
    }),
  )
  const status = result.stdout.trim()
  return /^\d{3}$/.test(status) ? status : "none"
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

/** The `--roots` file of each step; root writes it. */
const ROOTS_FILE = `${INGEST_ROOT}/roots.json`

/**
 * The host inputs of a skill step, the same for each skill (ADR-052 section
 * 6): the source checkout, the source URL, the path of the source file in
 * the Workspace (the value of `sources`, ADR-050 revision 2026-10-16), the
 * root-to-file map, and the root of a root step.
 */
export function ingestSkillArguments(step: {
  root: string | null
  sourceUrl: string
  sourcePath: string
}): string {
  return [
    `--source ${SOURCE_DIR}`,
    `--source-url ${quote(step.sourceUrl)}`,
    `--source-path ${quote(step.sourcePath)}`,
    `--roots ${ROOTS_FILE}`,
    ...(step.root === null ? [] : [`--path ${quote(step.root)}`]),
  ].join(" ")
}

/** The prompt of one model step. Source paths are data: they are quoted. */
function ingestStepPrompt(
  step: IngestRuntimeStep,
  source: { sourceUrl: string; sourcePath: string },
): string {
  return [
    `Run the skill ${step.skill}.`,
    step.root === null
      ? `This is the repository-wide step of the source checkout ${SOURCE_DIR}.`
      : `The root is ${JSON.stringify(step.root)} in the source checkout ${SOURCE_DIR}.`,
    `Give each script of the skill these arguments: ${ingestSkillArguments({ root: step.root, ...source })}`,
    `The Workspace is ${step.workspaceId}: its context checkout is ${INGEST_CONTEXT_ROOT}/${step.workspaceId}, and its index is ${INGEST_CONTEXT_ROOT}/${step.workspaceId}.index.json.`,
    "When you are done, run ctxpipe-finish, with --more when files wait for a next page.",
    "The host can end the step at its time limit. It then keeps the files that you staged, and runs the skill again on a next page. So stage your work in parts: write each file, or run the write script of the skill, when a part is ready, not all at the end.",
  ].join(" ")
}

/**
 * True when the gate scan starts the model: the scan failed, or the last
 * line of its output is not `needsModel: false`.
 */
function scanStartsModel(scan: { exitCode: number; stdout: string }): boolean {
  if (scan.exitCode !== 0) return true
  try {
    const last = scan.stdout.trim().split("\n").at(-1) ?? ""
    return (JSON.parse(last) as { needsModel?: unknown }).needsModel !== false
  } catch {
    return true
  }
}

/**
 * Run one skill step: root starts the step (fetch the ref, put the context
 * checkout at the base commit, place the index, write the root-to-file map),
 * the agent runs the skill, then `ctxpipe-finish` writes patch.json. A model
 * step is one `opencode run`. A script step runs
 * `<skill>/scripts/<skill>.mjs` with the same arguments that a model step
 * gives its scripts. `patch.json` holds `more` (ADR-052 section 6). A model
 * step returns the usage that OpenCode reports, when it reports usage. At
 * `step.checkpoint`, a model step stops the model and finishes with
 * `--more`; when it staged nothing, it throws `IngestStepTimeLimitError`.
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
    /**
     * The source file of the repository in the step's Workspace (`sources`).
     */
    sourcePath: string
    index?: string
    /** `ctxpipe/<model>` for a model step. */
    model?: string
  },
): Promise<{ usage?: IngestStepUsage; inputs?: number }> {
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
    CTXPIPE_ROOT: step.root ?? ".",
    CTXPIPE_WORKSPACE: step.workspaceId,
    CTXPIPE_CONTEXT: `${INGEST_CONTEXT_ROOT}/${step.workspaceId}`,
  }
  // In UTF-8 byte parts below the exec argument limit, as base64: a part
  // boundary inside a character cannot change the file.
  await writeAsRoot(root, ROOTS_FILE, JSON.stringify(step.rootMap))
  const skillArguments = ingestSkillArguments({
    root: step.root,
    sourceUrl: input.sourceUrl,
    sourcePath: input.sourcePath,
  })
  // The trusted length of the cursor (CTX-1487): the skill's own finder
  // runs before the model, while root has stopped every process of the agent
  // and emptied /ctxpipe/out and /ctxpipe/home. It reads only what root
  // owns: the bundle, the source, the context checkout, and the step inputs.
  let inputs: number | undefined
  if (step.cursor) {
    const count = await root(
      ingestAgentCommand({
        env,
        command: `node ${INGEST_SKILLS_ROOT}/${step.skill}/scripts/${step.cursor.finder} ${skillArguments} --count`,
      }),
      { signal: step.signal },
    )
    inputs = finderCount(count)
    if (inputs === undefined)
      throw new IngestStepCommandError(
        "count",
        count.exitCode,
        `Ingest step ${step.name}: the finder gave no count (${count.exitCode}): ${count.stderr.slice(-500)}`,
      )
  }
  const command =
    step.run === "model"
      ? ingestModelRunCommand({
          prompt: ingestStepPrompt(step, input),
          ...(input.model ? { model: input.model } : {}),
        })
      : `node ${INGEST_SKILLS_ROOT}/${step.skill}/scripts/${step.skill}.mjs ${skillArguments}`
  // The host runs the scan of `dependencies` first. When no claim is
  // possible, the script has written patch.json with the counts, and the
  // model does not run (CTX-1083). A scan that fails starts the model.
  let skipModel = false
  if (step.run === "model" && step.skill === "dependencies") {
    const scan = await root(
      ingestAgentCommand({
        env,
        command: `node ${INGEST_SKILLS_ROOT}/dependencies/scripts/scan.mjs ${skillArguments} --gate`,
      }),
      { signal: step.signal },
    )
    skipModel = !scanStartsModel(scan)
  }
  // A step that the gate stops makes no model call: its usage is zero,
  // not unknown (CTX-1087).
  let usage: IngestStepUsage | undefined = skipModel
    ? { inputTokens: 0, outputTokens: 0 }
    : undefined
  const runPart = (part: string, stop?: AbortSignal) =>
    root(ingestAgentCommand({ env, command: part }), {
      signal: step.signal,
      ...(stop ? { stop } : {}),
    })
  // At the checkpoint, the model stops, and `ctxpipe-finish --more` keeps
  // what it staged as a page, so the next page continues (CTX-1312).
  let stopped = false
  if (!skipModel) {
    const result = await runPart(
      command,
      step.run === "model" ? step.checkpoint : undefined,
    )
    stopped = result.stopped === true
    if (!stopped && result.exitCode !== 0)
      throw new IngestStepCommandError(
        "skill",
        result.exitCode,
        `Ingest step ${step.name} failed (${result.exitCode}): ${result.stderr.slice(-500)}`,
        step.run === "model"
          ? {
              calls: openCodeModelCalls(result.stdout),
              errors: parseOpenCodeErrors(result.stdout),
            }
          : undefined,
      )
    if (step.run === "model") {
      usage = parseOpenCodeUsage(result.stdout)
      // The worker kept only a part of stdout, so some usage can be lost.
      // The step counts as unknown, so that the spend does not look complete.
      if (result.stdoutTruncated) {
        logIngestEvent("warn", "ingestion-v2.stdout-truncated", {
          ingestStep: step.name,
          workspaceId: step.workspaceId,
        })
        usage = {
          ...(usage ?? { inputTokens: 0, outputTokens: 0 }),
          unknownSteps: 1,
        }
      }
    }
  }
  const finish = await runPart(
    stopped ? "ctxpipe-finish --more" : "ctxpipe-finish",
  )
  if (finish.exitCode !== 0)
    throw new IngestStepCommandError(
      "finish",
      finish.exitCode,
      `Ingest step ${step.name} failed (${finish.exitCode}): ${finish.stderr.slice(-500)}`,
    )
  if (stopped) {
    // With no op in patch.json there is nothing to keep, so the attempt
    // fails at the time limit, as with no checkpoint.
    const patch = await root(`cat ${INGEST_OUT_ROOT}/patch.json`)
    const ops = (JSON.parse(patch.stdout) as { ops?: unknown[] }).ops ?? []
    logIngestEvent("info", "ingestion-v2.step-checkpoint", {
      ingestStep: step.name,
      workspaceId: step.workspaceId,
      ops: ops.length,
    })
    if (!ops.length) throw new IngestStepTimeLimitError()
  }
  return {
    ...(usage ? { usage } : {}),
    ...(inputs === undefined ? {} : { inputs }),
  }
}

const FinderCountSchema = z.object({
  count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
})

/** The `{"count": <n>}` of the last line of a finder; else undefined. */
function finderCount(run: {
  exitCode: number
  stdout: string
}): number | undefined {
  if (run.exitCode !== 0) return undefined
  try {
    const last = run.stdout.trim().split("\n").at(-1) ?? ""
    return FinderCountSchema.safeParse(JSON.parse(last)).data?.count
  } catch {
    return undefined
  }
}

/**
 * A failed command of an ingest step: the skill command (`opencode run` or
 * the skill script) or `ctxpipe-finish`. The message holds the command's
 * stderr, which can hold source text. `part`, `exitCode`, and `model` hold no
 * source text, so a log can show them. `model` (a model command only) holds
 * the count of finished model calls, and the name and HTTP status of each
 * OpenCode `error` event.
 */
export class IngestStepCommandError extends Error {
  constructor(
    readonly part: "count" | "skill" | "finish",
    readonly exitCode: number,
    message: string,
    readonly model?: { calls: number; errors: OpenCodeError[] },
  ) {
    super(message)
    this.name = "IngestStepCommandError"
  }
}

/**
 * The agent's environment: the OpenCode isolation flags, the stage helpers
 * on PATH, and the sandbox's egress proxy settings (also the proxy auth method
 * of Git, see `openRunVault`). `env -i` gives the agent nothing else.
 *
 * The proxy settings come from the root command's own environment: a Docker
 * exec gets the container's environment, where the vault session is. Root
 * in a Docker sandbox cannot read `/proc/1/environ` when PID 1 runs as
 * another user (no `CAP_SYS_PTRACE`); then the agent got no proxy, and each
 * model call went direct, which the sandbox host drops. Where root can read
 * it, `/proc/1/environ` is read last, so its values win.
 */
export async function ingestAgentEnv(
  root: RootExec,
  input: { modelProxyUrl: string },
): Promise<Record<string, string>> {
  const result = await root(
    "{ env -0; cat /proc/1/environ 2>/dev/null; } | tr '\\0' '\\n'",
  )
  const keep =
    /^(https?_proxy|HTTPS?_PROXY|no_proxy|NO_PROXY|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|GIT_SSL_CAINFO|GIT_HTTP_PROXY_AUTHMETHOD|PATH)$/
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
