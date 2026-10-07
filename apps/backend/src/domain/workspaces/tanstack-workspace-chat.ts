import { randomBytes, randomUUID } from "node:crypto"
import { createServer } from "node:net"
import { trace } from "@opentelemetry/api"
import {
  chat,
  defineChatMiddleware,
  type ModelMessage,
  modelMessagesToUIMessages,
  type StreamChunk,
  type UIMessage,
} from "@tanstack/ai"
import { otelMiddleware } from "@tanstack/ai/middlewares/otel"
import { opencodeText } from "@tanstack/ai-opencode"
import { withPersistence } from "@tanstack/ai-persistence"
import {
  createSecrets,
  defineSandbox,
  defineWorkspace,
  getSandbox,
  gitSource,
  SandboxCapability,
  type SandboxHandle,
  type SandboxProvider,
  type WorkspaceDefinition,
  withSandbox,
} from "@tanstack/ai-sandbox"
import { dockerSandbox } from "@tanstack/ai-sandbox-docker"
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process"
import { eq } from "drizzle-orm"
import { parseEnv } from "../../config/env.js"
import { getSystemDb } from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import { loadConversationTurns } from "../../models/conversation-messages.js"
import { getRepoReadCloneToken } from "../../models/github-installation.js"
import {
  heartbeatSandboxInstance,
  SandboxInstanceOwnershipConflict,
} from "../../models/workspace-sandboxes.js"
import { getLogger, log } from "../../observability/logger.js"
import { AgentVaultUnavailableError, type RunVault } from "./agent-vault.js"
import {
  WORKSPACE_CHAT_CLONE_BRANCH_SECRET,
  WORKSPACE_CHAT_CLONE_SHA_SECRET,
  WORKSPACE_CHAT_CLONE_TOKEN_SECRET,
  WORKSPACE_CHAT_CLONE_URL_SECRET,
  WORKSPACE_CHAT_DOCKER_SETUP,
  WORKSPACE_CHAT_OPENCODE_PORT,
  WORKSPACE_CHAT_SANDBOX_SETUP,
  WORKSPACE_CHAT_SESSION_BRANCH_SECRET,
  WORKSPACE_CHAT_THREAD_SETUP,
  WORKSPACE_CHAT_VERCEL_SETUP,
  workspaceChatDockerImage,
  workspaceChatRuntimeConfig,
} from "./chat-runtime.js"
import { originUrlWithoutCredentials } from "./clone-credentials.js"
import { conversationBranchPushTool } from "./conversation-branch-push.js"
import {
  SandboxCapacityError,
  withConversationSandboxSlots,
} from "./conversation-sandbox-lifecycle.js"
import { checkoutSessionBranch } from "./conversation-session-branch.js"
import { nameConversationIfUnnamed } from "./conversation-title.js"
import { openDockerRunVault } from "./docker-run-vault.js"
import { hostedSandboxAccess } from "./hosted-sandbox-access.js"
import { type WorkspaceRevision, workspaceRevisionSchema } from "./revision.js"
import { recordedRunGitToken, revokeRunGitTokens } from "./run-git-tokens.js"
import { modelProxyCredentialRules } from "./sandbox-credential-rules.js"
import { postgresSandboxInstanceStore } from "./sandbox-instance-store.js"
import {
  enterSandboxLifecycleContext,
  flushSandboxSetupMarks,
  markSandboxLifecycle,
  setSandboxLifecycleScope,
  timedSandboxProvider,
  timeSandboxLifecycle,
  wrapSandboxSetupCommand,
} from "./sandbox-lifecycle-timing.js"
import { postgresSandboxLocks } from "./sandbox-lock-store.js"
import {
  stopEarlierTurnProcesses,
  withOwnerWatchdog,
  withSingleOpencodeServer,
} from "./sandbox-process-guards.js"
import {
  discoverSandboxProvider,
  remoteDockerHost,
  type SandboxProvider as SandboxProviderName,
  withDockerAgentPort,
  withProxyCa,
  withSessionOnlyEnv,
} from "./sandbox-provider.js"
import {
  conversationFirewall,
  conversationSandboxTags,
  turnAgentPassword,
  vercelAgentSnapshot,
  vercelConversationProvider,
} from "./vercel-sandbox-provider.js"
import { sandboxAgentImage } from "./workspace-base-providers.js"
import {
  aguiTextDelta,
  conversationRenameChunk,
  type WorkspaceChatWireFormat,
  workspaceChatHttpResponse,
  workspaceChatRunStartedChunk,
  workspaceChatSandboxSetupChunk,
  workspaceChatWireFormat,
} from "./workspace-chat-agui.js"
import {
  sandboxCallbackHost,
  workspaceChatCallbackMiddleware,
  workspaceChatToolBridgePath,
} from "./workspace-chat-callback.js"
import { workspaceChatCompletionsBaseUrl } from "./workspace-chat-model-proxy.js"
import {
  WORKSPACE_CHAT_FIREWALL_PLACEHOLDER,
  WORKSPACE_CHAT_LOCAL_PROCESS_SCRUB_ENV,
  WORKSPACE_CHAT_OPENCODE_JSON_SECRET,
  workspaceChatOpenCodeContract,
  writeWorkspaceChatOpenCodeConfig,
} from "./workspace-chat-opencode-contract.js"
import {
  messagesForOpenCodeChat,
  openCodeTrailingUserMiddleware,
} from "./workspace-chat-opencode-messages.js"
import {
  beginWorkspaceChatTurn,
  finishWorkspaceChatTurn,
  markWorkspaceChatFirstShownToken,
} from "./workspace-chat-otel.js"
import { workspaceChatPersistence } from "./workspace-chat-persistence.js"
import { updateConversationSandboxRevision } from "./workspace-chat-revision-transition.js"
import {
  mintWorkspaceChatRunCapability,
  type WorkspaceChatRunCapabilityPurpose,
} from "./workspace-chat-run-capability.js"
import { workspaceChatThreadLock } from "./workspace-chat-thread-lock.js"
import { mintWorkspaceChatToken } from "./workspace-chat-token.js"
import { WORKSPACE_CHAT_TOOLS } from "./workspace-chat-tools.js"
import {
  baseForNewSandbox,
  startingFromBase,
} from "./workspace-sandbox-base.js"
import { githubRepoFullNameFromWorkspaceUrl } from "./write-status.js"

export type TanstackWorkspaceChatMessage = {
  id?: string
  role: string
  content?: unknown
  parts?: unknown[]
  createdAt?: Date
}

export type TanstackWorkspaceChatInput = {
  conversationId: string
  prompt: string
  messages?: TanstackWorkspaceChatMessage[]
  threadId?: string
  runId?: string
  abortSignal?: AbortSignal
  orgId: string
  orgSlug?: string
  workspaceId: string
  desiredUrl?: string
  desiredSha?: string | null
  desiredGeneration?: number
  githubConnectionId?: string | null
  defaultBranch?: string
  lastBranch?: string | null
  ref?: string
  writeStatus: string
  /**
   * Test fixtures only: the clone token for a remote that is not on GitHub
   * (a local Git server). The backend never sets it; it is not recorded.
   */
  cloneToken?: string
  onFinish?: () => Promise<void> | void
  onError?: () => Promise<void> | void
  onUserPersist?: () => Promise<void> | void
  onDelta?: (delta: string) => Promise<void> | void
  resolveRuntime?: () => Promise<Partial<TanstackWorkspaceChatInput>>
  wireFormat?: WorkspaceChatWireFormat
}

export { conversationRenameChunk } from "./workspace-chat-agui.js"

/** Counters for contract tests: how often a sandbox was ensured. */
export const workspaceChatDockerOwnership = {
  ensures: 0,
  reset() {
    this.ensures = 0
  },
}

/**
 * One stock definition per request. The sandbox key covers the conversation,
 * the Workspace's repository and default branch, and the key image (the
 * Docker chat image, or a fixed Vercel value). The commit, the credentials
 * and the Workspace base a sandbox started from are not part of it, so a
 * conversation keeps its sandbox while the default branch moves (option D)
 * and when its Workspace gets a new base.
 */
function conversationSandboxDefinition(input: {
  provider: SandboxProvider
  workspace: WorkspaceDefinition
  image: string
  revision: WorkspaceRevision
  conversationId: string
}) {
  const definition = defineSandbox({
    // A relinked Workspace (new generation or connection) gets new sandboxes.
    id: `workspace-chat:${input.image}:${input.revision.generation}:${input.revision.remote.connectionId ?? ""}`,
    provider: timedSandboxProvider(input.provider),
    workspace: input.workspace,
    lifecycle: {
      reuse: "thread",
      snapshot: "none",
      destroyOnComplete: false,
    },
    hooks: {
      onReady: async (ready: SandboxHandle) => {
        await flushSandboxSetupMarks(ready)
        setSandboxLifecycleScope("chat")
        markSandboxLifecycle("sandbox-ready", { sandboxId: ready.id })
        log.info({
          step: "workspace-chat-sandbox-ready",
          message: `workspace chat sandbox ready ${ready.id}`,
          conversationId: input.conversationId,
          sandboxId: ready.id,
        })
      },
    },
  })
  const ensure = definition.ensure.bind(definition)
  const ensureExisting = definition.ensureExisting.bind(definition)
  definition.ensure = ((ctx) => {
    workspaceChatDockerOwnership.ensures += 1
    return timeSandboxLifecycle("ensure", () => ensure(ctx), {
      conversationId: ctx.threadId,
    })
  }) as typeof definition.ensure
  definition.ensureExisting = ((ctx) => {
    workspaceChatDockerOwnership.ensures += 1
    return timeSandboxLifecycle("ensure-existing", () => ensureExisting(ctx), {
      conversationId: ctx.threadId,
    })
  }) as typeof definition.ensureExisting
  return definition
}

export function conversationSandboxProvider(
  isolation: SandboxProviderName,
  /** This turn's OpenCode password (`turnAgentPassword`). */
  agentPassword: string,
  /** Docker: the Workspace base image a new sandbox starts from, if any. */
  baseImage: () => Promise<string | undefined>,
  vercel?: Parameters<typeof vercelConversationProvider>[0],
  /** Docker: the run's proxy CA, written into each sandbox before its clone. */
  proxyCaPem?: string,
): SandboxProvider {
  if (isolation === "vercel") {
    if (!vercel) throw new Error("Vercel sandbox options are missing")
    return withSingleOpencodeServer(vercelConversationProvider(vercel))
  }
  if (isolation === "unsandboxed")
    return withOwnerWatchdog(
      localProcessSandbox({
        scrubEnv: [...WORKSPACE_CHAT_LOCAL_PROCESS_SCRUB_ENV],
      }),
    )
  return withSingleOpencodeServer(
    withProxyCa(
      withSessionOnlyEnv(
        withDockerAgentPort(
          startingFromBase({
            make: (image) =>
              dockerSandbox({
                image: image ?? workspaceChatDockerImage(),
                publishPorts: [WORKSPACE_CHAT_OPENCODE_PORT],
                dockerodeOptions: { timeout: 120_000 },
              }),
            baseImage,
          }),
          {
            agentPassword,
            daemonHost: remoteDockerHost(),
          },
        ),
      ),
      proxyCaPem,
    ),
  )
}

function abortControllerFrom(signal?: AbortSignal): AbortController {
  const abortController = new AbortController()
  if (!signal) return abortController
  if (signal.aborted) abortController.abort(signal.reason)
  else {
    signal.addEventListener(
      "abort",
      () => abortController.abort(signal.reason),
      {
        once: true,
      },
    )
  }
  return abortController
}

export async function collectTanstackWorkspaceChatText(
  input: TanstackWorkspaceChatInput,
): Promise<
  { ok: true; text: string } | { ok: false; status: number; error: string }
> {
  try {
    let text = ""
    for await (const chunk of streamTanstackWorkspaceChat(input)) {
      const delta = aguiTextDelta(chunk)
      if (delta) {
        text += delta
        await input.onDelta?.(delta)
      }
    }
    return { ok: true, text }
  } catch (error) {
    await input.onError?.()
    throw error
  }
}

export async function* streamTanstackWorkspaceChat(
  input: TanstackWorkspaceChatInput,
): AsyncGenerator<StreamChunk> {
  const turnId = input.runId ?? input.conversationId
  beginWorkspaceChatTurn(input.conversationId, turnId)
  enterSandboxLifecycleContext(input.conversationId)
  try {
    yield* streamTanstackWorkspaceChatBody(input, turnId)
  } catch (error) {
    finishWorkspaceChatTurn(turnId, {
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  } finally {
    finishWorkspaceChatTurn(turnId)
  }
}

async function* streamTanstackWorkspaceChatBody(
  input: TanstackWorkspaceChatInput,
  turnId: string,
): AsyncGenerator<StreamChunk> {
  yield workspaceChatRunStartedChunk({
    threadId: input.conversationId,
    runId: turnId,
  })
  yield workspaceChatSandboxSetupChunk("starting")
  const resolved = input.resolveRuntime ? await input.resolveRuntime() : {}
  const turn: TanstackWorkspaceChatInput = { ...input, ...resolved }
  await turn.onUserPersist?.()
  const prepared = await startWorkspaceChat(turn)
  if (!prepared.ok) throw new Error(prepared.error)
  yield workspaceChatSandboxSetupChunk("ready")
  for await (const chunk of prepared.stream) {
    const typed = chunk as StreamChunk
    if (typed.type === "RUN_STARTED") continue
    if (typed.type === "RUN_ERROR") await turn.onError?.()
    if (typed.type === "RUN_FINISHED") {
      const name = await nameConversationIfUnnamed({
        conversationId: turn.conversationId,
        prompt: turn.prompt,
      })
      if (name) yield conversationRenameChunk(name)
      await turn.onFinish?.()
    }
    if (
      typed.type === "TEXT_MESSAGE_CONTENT" ||
      typed.type === "REASONING_MESSAGE_CONTENT" ||
      typed.type === "TOOL_CALL_START"
    )
      markWorkspaceChatFirstShownToken(turnId)
    yield typed
  }
}

/**
 * Schedule the sweep that stops a sandbox once it has been idle. The
 * scheduler sits next to its workflow, which connects to OpenWorkflow on
 * import, so it is loaded only when a sandbox is used.
 */
async function scheduleIdleStop(orgId: string, usedAt: Date): Promise<void> {
  try {
    const { scheduleIdleSandboxStop } = await import(
      "../../openworkflow/workflows/conversation-sandbox-sweep.js"
    )
    await scheduleIdleSandboxStop(orgId, usedAt)
  } catch (error) {
    // The worker-start backstop restarts a lost sweep.
    log.error({
      step: "conversation-sandbox-sweep-schedule",
      message: `Scheduling the sandbox sweep failed: ${String(error)}`,
      orgId,
    })
  }
}

/**
 * Ask the worker to build (or refresh) the Workspace base, without waiting:
 * this start goes ahead as it is. Loaded lazily like the sweep scheduler.
 */
async function requestBaseBuild(
  orgId: string,
  workspaceId: string,
): Promise<void> {
  try {
    const { requestWorkspaceSandboxBase } = await import(
      "../../openworkflow/workflows/workspace-sandbox-base.js"
    )
    await requestWorkspaceSandboxBase(orgId, workspaceId)
  } catch (error) {
    // The next new conversation asks again.
    log.error({
      step: "workspace-base-request",
      message: `Requesting the Workspace base build failed: ${String(error)}`,
      orgId,
      workspaceId,
    })
  }
}

export async function runTanstackWorkspaceChat(
  input: TanstackWorkspaceChatInput,
): Promise<Response> {
  return workspaceChatHttpResponse(
    streamTanstackWorkspaceChat(input),
    input.wireFormat ?? workspaceChatWireFormat(new Request("http://local")),
  )
}

function sandboxEnsureContext(
  input: TanstackWorkspaceChatInput,
  built: Extract<
    Awaited<ReturnType<typeof buildWorkspaceChatSandbox>>,
    { ok: true }
  >,
  abortController: AbortController,
) {
  return {
    threadId: input.conversationId,
    runId: input.runId ?? `prepare-${input.conversationId}`,
    store: built.instances,
    locks: postgresSandboxLocks(
      input.orgId,
      abortController,
      `workspace-sandboxes:${input.workspaceId}`,
    ),
    signal: abortController.signal,
    // Match the optional fields emitted by native withSandbox's tenantFrom.
    tenant: { userId: undefined, orgId: input.orgId },
    adapterName: "opencode",
  }
}

/**
 * Prepare the conversation's sandbox. `existingOnly` attaches to a sandbox
 * that already exists (Files reads) and never creates one; otherwise the
 * sandbox is created if needed and moved to the Workspace's current commit.
 * `effectiveRevision` is set when the move conflicted and the sandbox stayed
 * on its previous commit.
 */
export async function warmTanstackWorkspaceChat(
  input: TanstackWorkspaceChatInput,
  options?: {
    existingOnly?: boolean
    transcriptLocked?: boolean
  },
): Promise<
  | { ok: true; handle: SandboxHandle; effectiveRevision?: WorkspaceRevision }
  | { ok: false; status: 400 | 409 | 429 | 503; error: string }
> {
  if (!options?.existingOnly && !options?.transcriptLocked) {
    return postgresSandboxLocks(
      input.orgId,
      abortControllerFrom(input.abortSignal),
    ).withLock(`chat-thread:${input.conversationId}`, () =>
      warmTanstackWorkspaceChat(input, { ...options, transcriptLocked: true }),
    )
  }
  enterSandboxLifecycleContext(input.conversationId)
  const prepareStarted = Date.now()
  // Attaching (Files reads) runs no Git command that needs a token.
  const cloneLabel = options?.existingOnly ? undefined : `clone:${randomUUID()}`
  const built = await buildWorkspaceChatSandbox(input, cloneLabel)
  if (!built.ok) return built
  const abortController = abortControllerFrom(input.abortSignal)
  try {
    const ctx = sandboxEnsureContext(input, built, abortController)
    const ready = options?.existingOnly
      ? await built.definition.ensureExisting(ctx)
      : await built.definition.ensure(ctx)
    if (!ready) return { ok: false, status: 409, error: "missing_sandbox" }
    let effectiveRevision: WorkspaceRevision | undefined
    if (!options?.existingOnly) {
      const updated = await updateConversationSandboxRevision({
        handle: ready,
        orgId: input.orgId,
        sandboxKey: built.definition.key(ctx),
        desired: built.revision,
        signal: abortController.signal,
      })
      effectiveRevision = updated.effective
    }
    log.info({
      step: "workspace-chat-timing",
      phase: "prepare",
      message: `workspace chat timing prepare ${Date.now() - prepareStarted}ms`,
      ms: Date.now() - prepareStarted,
      conversationId: input.conversationId,
    })
    return {
      ok: true,
      handle: ready,
      ...(effectiveRevision ? { effectiveRevision } : {}),
    }
  } catch (error) {
    if (error instanceof SandboxInstanceOwnershipConflict)
      return { ok: false, status: 409, error: error.message }
    if (error instanceof SandboxCapacityError)
      return { ok: false, status: 429, error: error.message }
    getLogger().error(
      error instanceof Error ? error : new Error(String(error)),
      { step: "workspace-chat-prepare-ensure" },
    )
    return { ok: false, status: 503, error: "workspace chat prepare failed" }
  } finally {
    // The prepare's credentials end with it, while the conversation lock is
    // still held. A turn gets its own.
    await built.release()
    // Opening or reading a conversation counts as use; also covers a start
    // that failed after its sandbox began running.
    if (built.isolation !== "unsandboxed")
      await scheduleIdleStop(input.orgId, new Date())
  }
}

async function startWorkspaceChat(input: TanstackWorkspaceChatInput): Promise<
  | {
      ok: true
      stream: AsyncIterable<object>
    }
  | { ok: false; status: number; error: string }
> {
  // One label per turn: the turn end revokes exactly its own token.
  const cloneLabel = `clone:${input.runId ?? randomUUID()}`
  const built = await buildWorkspaceChatSandbox(input, cloneLabel)
  if (!built.ok) return built
  let activeSandbox: SandboxHandle | undefined
  const runtime = workspaceChatRuntimeConfig({
    writeStatus: input.writeStatus,
    getCurrentBranch: async () => {
      if (!activeSandbox) throw new Error("Chat sandbox is not ready")
      const current = await activeSandbox.process.exec(
        "git branch --show-current",
      )
      if (current.exitCode !== 0)
        throw new Error("Chat working branch is unavailable")
      return current.stdout.trim()
    },
    defaultBranch: input.defaultBranch,
    // Hosted: the firewall. Docker: all egress goes through Agent Vault.
    openNetwork: built.isolation !== "unsandboxed",
  })
  const { session, callbackHost, definition } = built
  // OpenCode treats `--port=0` as 4096, so overlapping unsandboxed sends must
  // claim distinct loopback ports before serve starts.
  let opencodeListen: { port: number; hostname?: "127.0.0.1" } = {
    port: WORKSPACE_CHAT_OPENCODE_PORT,
  }
  if (built.isolation === "unsandboxed") {
    opencodeListen = {
      hostname: "127.0.0.1",
      port: await new Promise<number>((resolve, reject) => {
        const server = createServer()
        server.once("error", reject)
        server.listen(0, "127.0.0.1", () => {
          const address = server.address()
          if (!address || typeof address === "string") {
            server.close()
            reject(new Error("Unsandboxed OpenCode listen port missing"))
            return
          }
          const allocated = address.port
          server.close((error) => (error ? reject(error) : resolve(allocated)))
        })
      }),
    }
  }
  let revisionConflict: WorkspaceRevision | undefined
  const persistence = workspaceChatPersistence({
    threadId: input.conversationId,
  })
  const chatStarted = Date.now()
  const abortController = abortControllerFrom(input.abortSignal)
  let transcriptOwner: string | undefined
  // Hosted: the firewall, and the turn's tool bridge, known before the run
  // so the firewall can add its token.
  const hosted = built.firewall
    ? {
        firewall: built.firewall,
        bridge: {
          id: randomBytes(16).toString("hex"),
          token: randomBytes(24).toString("hex"),
        },
        sandboxId: undefined as string | undefined,
      }
    : undefined
  // The turn's credentials leave the firewall before the conversation lock
  // is released, so this cannot replace the next turn's rules. A failure is
  // logged: the model capability stops working when the lock is released,
  // the bridge closes with the run, and the next update replaces the rules.
  const closeHostedTurn = async () => {
    if (!hosted?.sandboxId) return
    await hosted.firewall.closeTurn(hosted.sandboxId).catch((error: unknown) =>
      log.warn({
        step: "workspace-chat-firewall-close",
        message: `Removing the turn's credentials from the sandbox firewall failed: ${String(error)}`,
        conversationId: input.conversationId,
      }),
    )
  }
  // The idle clock starts when the turn ends. Runs before the conversation
  // lock is released, so the sweep never sees a free lock with a stale time.
  // The sweep it schedules is due exactly 5 minutes after this use.
  const markSandboxUsed = async (ctx: { runId: string }) => {
    const usedAt = new Date()
    try {
      await heartbeatSandboxInstance(
        definition.key({
          threadId: input.conversationId,
          runId: ctx.runId,
          tenant: { userId: undefined, orgId: input.orgId },
        }),
        usedAt,
        input.orgId,
      )
    } catch (error) {
      log.warn({
        step: "workspace-chat-sandbox-used",
        message: `Recording the sandbox's last use failed: ${String(error)}`,
        conversationId: input.conversationId,
      })
    }
    if (built.isolation !== "unsandboxed")
      await scheduleIdleStop(input.orgId, usedAt)
  }
  // Revoke this turn's GitHub tokens as soon as it ends; a failure is left
  // for the sandbox sweep and never fails the turn.
  const revokeTurnGitTokens = () => built.release()
  const stream = await chat({
    adapter: opencodeText(built.contract.opencodeModel, {
      ...opencodeListen,
      permissionMode: runtime.permissionMode,
      onPermissionRequest: runtime.onPermissionRequest,
    }),
    threadId: input.conversationId,
    runId: input.runId,
    context: {
      orgId: input.orgId,
      orgSlug: session.orgSlug,
      workspaceId: input.workspaceId,
    },
    messages: (input.messages
      ? messagesForOpenCodeChat(input.messages, input.prompt)
      : []) as Array<ModelMessage | UIMessage>,
    abortController,
    tools: [
      ...WORKSPACE_CHAT_TOOLS,
      conversationBranchPushTool({
        conversationId: input.conversationId,
        orgId: input.orgId,
        orgSlug: session.orgSlug,
        workspaceId: input.workspaceId,
        sandbox: () => activeSandbox,
      }),
    ],
    middleware: [
      otelMiddleware({
        tracer: trace.getTracer("ctxpipe-workspace-chat"),
      }),
      defineChatMiddleware({
        name: "workspace-chat-sandbox-used",
        onFinish: markSandboxUsed,
        onError: markSandboxUsed,
        onAbort: markSandboxUsed,
      }),
      // Before the thread lock: TanStack runs onFinish in this order.
      defineChatMiddleware({
        name: "workspace-chat-firewall",
        onFinish: closeHostedTurn,
        onError: closeHostedTurn,
        onAbort: closeHostedTurn,
      }),
      workspaceChatThreadLock({
        locks: postgresSandboxLocks(
          input.orgId,
          abortController,
          undefined,
          (lease) => {
            if (lease.key === `chat-thread:${input.conversationId}`)
              transcriptOwner = lease.owner
          },
        ),
        loadThread: (threadId) =>
          persistence.stores.messages.loadThread(threadId),
      }),
      // After the thread lock: TanStack runs onFinish in this order, so the
      // lock is released first and a run capability can mint nothing after
      // the revoke. A mint already in flight is recorded for the sweep, and
      // the route does not return it.
      defineChatMiddleware({
        name: "workspace-chat-run-git-tokens",
        onFinish: revokeTurnGitTokens,
        onError: revokeTurnGitTokens,
        onAbort: revokeTurnGitTokens,
      }),
      withPersistence(persistence, { snapshotStreaming: true }),
      withSandbox(definition, {
        instances: built.instances,
        locks: postgresSandboxLocks(
          input.orgId,
          abortController,
          `workspace-sandboxes:${input.workspaceId}`,
        ),
      }),
      defineChatMiddleware({
        name: "workspace-chat-revision",
        requires: [SandboxCapability],
        async setup(ctx) {
          return timeSandboxLifecycle("revision-setup", async () => {
            const handle = getSandbox(ctx)
            const updated = await updateConversationSandboxRevision({
              handle,
              orgId: input.orgId,
              sandboxKey: definition.key({
                threadId: input.conversationId,
                runId: ctx.runId,
                tenant: { userId: undefined, orgId: input.orgId },
              }),
              desired: built.revision,
              signal: abortController.signal,
            })
            if (updated.conflict) revisionConflict = updated.effective
            else
              await checkoutSessionBranch({
                handle,
                orgId: input.orgId,
                conversationId: input.conversationId,
                desired: built.revision,
              })
          })
        },
        onConfig(_ctx, config) {
          if (!revisionConflict) return
          return {
            systemPrompts: [
              ...config.systemPrompts,
              JSON.stringify({
                type: "workspace_revision_conflict",
                effectiveSha: revisionConflict.sha,
                desiredSha: built.revision.sha,
                instructions:
                  "Keep the current branch. Publishing is blocked until it is rebased onto desiredSha. Inspect Git status and saved stashes before repairing. An interrupted update is recorded at .git/ctxpipe-revision-transition; after recovering its saved edits and resolving the rebase, remove that marker so the next turn can move to the new commit. Never discard saved edits without the user's request.",
              }),
            ],
          }
        },
      }),
      workspaceChatCallbackMiddleware(
        callbackHost,
        built.publicBaseUrl && hosted
          ? { publicBaseUrl: built.publicBaseUrl, bridge: hosted.bridge }
          : undefined,
        built.vault,
      ),
      defineChatMiddleware({
        name: "workspace-chat-permissions",
        requires: [SandboxCapability],
        async setup(ctx) {
          return timeSandboxLifecycle("permissions-setup", async () => {
            activeSandbox = getSandbox(ctx)
            abortController.signal.throwIfAborted()
            if (!transcriptOwner)
              throw new Error("Conversation lock ownership is unavailable")
            const authority = {
              expectedOwner: transcriptOwner,
              authSecret: process.env.AUTH_SECRET?.trim() ?? "",
              orgId: input.orgId,
              orgSlug: session.orgSlug,
              conversationId: input.conversationId,
              revision: built.revision,
            }
            const mint = (purpose: WorkspaceChatRunCapabilityPurpose) =>
              mintWorkspaceChatRunCapability({
                ...authority,
                runId: input.runId,
                purpose,
              })
            // A turn starts with no agent process of an earlier turn: such a
            // process would get this turn's capability, rules or session.
            if (built.isolation !== "unsandboxed")
              await stopEarlierTurnProcesses(activeSandbox)
            // The conversation lock is held and OpenCode has not started.
            // Its subprocesses inherit these values (none when hosted, a
            // placeholder on Docker).
            await activeSandbox.env.set(
              await workspaceChatRunCapabilities(
                built.isolation,
                built.vault,
                session.proxyUrl,
                mint,
              ),
            )
            abortController.signal.throwIfAborted()
            if (hosted) {
              // The firewall adds the turn's credentials; the sandbox sends
              // placeholders.
              hosted.sandboxId = activeSandbox.id
              await hosted.firewall.openTurn(activeSandbox.id, {
                modelProxyPath: new URL(session.proxyUrl).pathname,
                modelCapability: await mint("workspace-chat-model"),
                bridgePath: workspaceChatToolBridgePath(hosted.bridge.id),
                bridgeToken: hosted.bridge.token,
              })
              abortController.signal.throwIfAborted()
            }
          })
        },
      }),
      openCodeTrailingUserMiddleware(input.prompt),
    ],
  })
  log.info({
    step: "workspace-chat-timing",
    phase: "chat-create",
    message: `workspace chat timing chat-create ${Date.now() - chatStarted}ms`,
    ms: Date.now() - chatStarted,
    attached: workspaceChatDockerOwnership.ensures,
    conversationId: input.conversationId,
  })
  return {
    ok: true,
    stream,
  }
}

/**
 * The run capabilities a sandbox gets as environment variables. A hosted
 * sandbox gets none: its firewall adds each credential outside the sandbox
 * (see `conversationFirewall`). A Docker sandbox gets none either: the run's
 * vault holds the model capability, and Agent Vault adds it to model proxy
 * calls (the OpenCode config sends a placeholder). Only an unsandboxed run
 * gets the capability itself.
 */
export async function workspaceChatRunCapabilities(
  isolation: SandboxProviderName,
  vault: Pick<RunVault, "addRules"> | undefined,
  proxyUrl: string,
  mint: (purpose: WorkspaceChatRunCapabilityPurpose) => Promise<string>,
): Promise<Record<string, string>> {
  if (isolation === "vercel") return {}
  const model = await mint("workspace-chat-model")
  if (!vault) return { CTXPIPE_OPENCODE_RUN_TOKEN: model }
  await vault.addRules(modelProxyCredentialRules(proxyUrl, model))
  return {}
}

async function resolveWorkspaceChatSession(
  input: TanstackWorkspaceChatInput,
  isolation: SandboxProviderName,
  callbackHost?: string,
  /** Remote sandboxes reach the model proxy at the backend's public origin. */
  publicBaseUrl?: string,
): Promise<
  | { ok: true; runToken: string; proxyUrl: string; orgSlug: string }
  | { ok: false; status: 503; error: string }
> {
  const authSecret = process.env.AUTH_SECRET?.trim() ?? ""
  if (authSecret.length < 32) {
    return {
      ok: false,
      status: 503,
      error: "Workspace chat needs AUTH_SECRET to mint a completions token.",
    }
  }
  const orgSlug = await resolveWorkspaceChatOrgSlug(input)
  if (!orgSlug) {
    return {
      ok: false,
      status: 503,
      error: "Workspace chat needs an organization slug.",
    }
  }
  return {
    ok: true,
    orgSlug,
    runToken: mintWorkspaceChatToken({
      authSecret,
      orgId: input.orgId,
      orgSlug,
      conversationId: input.conversationId,
      runId: input.runId,
    }),
    proxyUrl: publicBaseUrl
      ? `${publicBaseUrl}/${orgSlug}/api/v1/workspace-chat/openai/v1`
      : workspaceChatCompletionsBaseUrl({
          isolation,
          orgSlug,
          port: Number(process.env.PORT) || 3000,
          ...(callbackHost ? { callbackHost } : {}),
        }),
  }
}

async function resolveWorkspaceChatOrgSlug(
  input: TanstackWorkspaceChatInput,
): Promise<string | null> {
  const fromInput = input.orgSlug?.trim()
  if (fromInput) return fromInput
  const [row] = await getSystemDb()
    .select({ slug: organizations.slug })
    .from(organizations)
    .where(eq(organizations.id, input.orgId))
    .limit(1)
  return row?.slug ?? null
}

/**
 * `cloneLabel` names this call's GitHub token: in a Docker run's vault, or a
 * local run's clone token (`release` ends it; the sweep ends what a crash
 * left). Without it the sandbox gets no credential: it is only attached to.
 */
async function buildWorkspaceChatSandbox(
  input: TanstackWorkspaceChatInput,
  cloneLabel?: string,
) {
  const desiredUrl = input.desiredUrl?.trim() ?? ""
  if (!desiredUrl) {
    return {
      ok: false as const,
      status: 400 as const,
      error: "workspace_required",
    }
  }
  let selectedProvider: SandboxProviderName
  try {
    selectedProvider = await discoverSandboxProvider()
  } catch (error) {
    return {
      ok: false as const,
      status: 503 as const,
      error: error instanceof Error ? error.message : String(error),
    }
  }
  const contract = workspaceChatOpenCodeContract(process.env)
  if (!contract.ok) {
    return {
      ok: false as const,
      status: contract.status,
      error: contract.error,
    }
  }
  const revision = workspaceRevisionSchema.safeParse({
    workspaceId: input.workspaceId,
    remote: { url: desiredUrl, connectionId: input.githubConnectionId ?? null },
    sha: input.desiredSha,
    generation: input.desiredGeneration ?? 1,
    defaultBranch: input.defaultBranch ?? "main",
    access: "read",
  })
  if (!revision.success) {
    return {
      ok: false as const,
      status: 409 as const,
      error: "Workspace chat needs a stored desired SHA",
    }
  }
  const agentPassword = turnAgentPassword()
  const vercel =
    selectedProvider === "vercel"
      ? await hostedSandboxOptions(input, desiredUrl, agentPassword)
      : undefined
  if (vercel && !vercel.ok) return vercel
  const publicBaseUrl = vercel?.ok ? vercel.publicBaseUrl : undefined
  let callbackHost: string | undefined
  try {
    callbackHost = await sandboxCallbackHost()
  } catch (error) {
    return {
      ok: false as const,
      status: 503 as const,
      error: error instanceof Error ? error.message : String(error),
    }
  }
  const session = await resolveWorkspaceChatSession(
    input,
    selectedProvider,
    callbackHost,
    publicBaseUrl,
  )
  if (!session.ok) return session
  // `image` is part of the sandbox key; `agentImage` picks the base.
  let image = "local-process"
  let agentImage = image
  if (selectedProvider !== "unsandboxed") {
    try {
      agentImage = await sandboxAgentImage(selectedProvider)
      // Docker: the chat image's id, so a new image gives new sandboxes.
      // Vercel: one fixed value, so an OpenCode upgrade never orphans
      // hosted conversations (a resumed sandbox keeps its OpenCode).
      image = selectedProvider === "docker" ? agentImage : "vercel-agent"
    } catch (error) {
      getLogger().error(
        error instanceof Error ? error : new Error(String(error)),
        { step: "workspace-chat-docker-image" },
      )
      return {
        ok: false as const,
        status: 503 as const,
        error: "Workspace chat requires the initialized chat sandbox image.",
      }
    }
  }
  // A new sandbox starts from the Workspace base, chosen at create (under the
  // Workspace lock); an existing one is resumed whatever it started from.
  const base = async (): Promise<{
    ref?: string
    failed: () => Promise<void>
  }> => {
    if (selectedProvider === "unsandboxed")
      return { failed: async () => undefined }
    const choice = await baseForNewSandbox({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      agent: { provider: selectedProvider, image: agentImage },
      revision: revision.data,
    })
    if (choice.requestBuild)
      void requestBaseBuild(input.orgId, input.workspaceId)
    return choice
  }
  const repoFullName = githubRepoFullNameFromWorkspaceUrl(desiredUrl)
  // Docker: the run's vault holds the GitHub token and Agent Vault adds it.
  // A Files read (no label) runs no network command and gets no vault.
  let vault: RunVault | undefined
  if (selectedProvider === "docker" && cloneLabel) {
    try {
      vault = await openDockerRunVault({
        orgId: input.orgId,
        conversationId: input.conversationId,
        label: cloneLabel,
        revision: revision.data,
      })
    } catch (error) {
      if (!(error instanceof AgentVaultUnavailableError)) throw error
      getLogger().error(error, { step: "workspace-chat-agent-vault" })
      return {
        ok: false as const,
        status: 503 as const,
        error: `Workspace chat is unavailable: ${error.message}`,
      }
    }
  }
  // Hosted sandboxes never hold the token: the firewall adds it to GitHub
  // calls. Docker sandboxes never hold it either: Agent Vault adds it.
  const cloneToken =
    selectedProvider === "vercel" || selectedProvider === "docker"
      ? ""
      : input.cloneToken
        ? input.cloneToken
        : cloneLabel && repoFullName
          ? ((await recordedRunGitToken({
              orgId: input.orgId,
              conversationId: input.conversationId,
              label: cloneLabel,
              mint: () =>
                getRepoReadCloneToken(
                  input.orgId,
                  parseEnv(process.env as Record<string, string | undefined>),
                  {
                    githubConnectionId: input.githubConnectionId ?? undefined,
                    repoFullName,
                    fresh: true,
                  },
                ),
            })) ?? "")
          : ""
  const workspace = conversationSandboxWorkspace({
    isolation: selectedProvider,
    input,
    cloneToken,
    desiredUrl,
    runToken: session.runToken,
    proxyUrl: session.proxyUrl,
    modelBase: contract.modelBase,
    proxyEnv: vault?.env,
  })
  const provider = conversationSandboxProvider(
    selectedProvider,
    agentPassword,
    async () => (await base()).ref,
    vercel?.ok
      ? {
          ...vercel.options,
          base,
          logContext: { orgId: input.orgId, workspaceId: input.workspaceId },
          // No base: the agent snapshot (OpenCode only), never npm.
          agentSnapshot: () =>
            vercelAgentSnapshot({
              credentials: vercel.options.credentials,
              environment: vercel.environment,
            }),
        }
      : undefined,
    vault?.caPem,
  )
  return {
    ok: true as const,
    isolation: selectedProvider,
    publicBaseUrl,
    vault,
    /**
     * End this call's credentials: a Docker vault (its session stops, then
     * its GitHub token is revoked) or a local run's clone token. Never throws.
     */
    release: async () => {
      if (vault) return vault.close()
      if (selectedProvider === "unsandboxed" && cloneLabel)
        await revokeRunGitTokens({
          orgId: input.orgId,
          conversationId: input.conversationId,
          prefixes: [`${cloneLabel}:`],
        })
    },
    firewall: vercel?.ok ? vercel.options.access.firewall : undefined,
    definition: conversationSandboxDefinition({
      provider:
        selectedProvider === "unsandboxed"
          ? provider
          : withConversationSandboxSlots(provider, {
              orgId: input.orgId,
              workspaceId: input.workspaceId,
              conversationId: input.conversationId,
              provider: selectedProvider,
              image,
              revision: revision.data,
            }),
      workspace,
      image,
      revision: revision.data,
      conversationId: input.conversationId,
    }),
    contract,
    session,
    callbackHost,
    revision: revision.data,
    instances: postgresSandboxInstanceStore({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      revision: revision.data,
      image,
      provider:
        selectedProvider === "unsandboxed" ? "local-process" : selectedProvider,
    }),
  }
}

/**
 * Hosted sandboxes fail closed: without Vercel credentials, a GitHub
 * Workspace repository, or a public backend origin there is no chat.
 */
async function hostedSandboxOptions(
  input: TanstackWorkspaceChatInput,
  desiredUrl: string,
  agentPassword: string,
): Promise<
  | {
      ok: true
      publicBaseUrl: string
      environment: string
      options: Omit<
        Parameters<typeof vercelConversationProvider>[0],
        "base" | "agentSnapshot"
      >
    }
  | { ok: false; status: 503; error: string }
> {
  const hosted = await hostedSandboxAccess({
    orgId: input.orgId,
    githubConnectionId: input.githubConnectionId,
    desiredUrl,
  })
  if (!hosted.ok) return hosted
  return {
    ok: true,
    publicBaseUrl: hosted.publicBaseUrl,
    environment: hosted.environment,
    options: {
      credentials: hosted.credentials,
      agentPassword,
      access: {
        firewall: conversationFirewall(hosted.backendHost),
        tokens: hosted.tokens,
        mintGitToken: hosted.mintGitToken,
      },
      tags: conversationSandboxTags(hosted.environment),
    },
  }
}

function conversationSandboxWorkspace(input: {
  isolation: SandboxProviderName
  input: TanstackWorkspaceChatInput
  cloneToken: string
  desiredUrl: string
  runToken: string
  proxyUrl: string
  modelBase: string
  /** Docker: the run's proxy session and CA trust. */
  proxyEnv?: Record<string, string>
}) {
  const { input: chatInput } = input
  const opencodeHome = writeWorkspaceChatOpenCodeConfig({
    conversationId: chatInput.conversationId,
    modelBase: input.modelBase,
    isolation: input.isolation,
  })
  const { cloneToken } = input
  const secrets = createSecrets({
    ...(input.isolation === "unsandboxed"
      ? { CTXPIPE_OPENCODE_RUN_TOKEN: input.runToken }
      : {}),
    CTXPIPE_MODEL_PROXY_URL: input.proxyUrl,
    [WORKSPACE_CHAT_CLONE_URL_SECRET]: originUrlWithoutCredentials(
      input.desiredUrl,
    ),
    [WORKSPACE_CHAT_CLONE_BRANCH_SECRET]:
      chatInput.defaultBranch?.trim() || "main",
    [WORKSPACE_CHAT_CLONE_SHA_SECRET]: chatInput.desiredSha?.trim() ?? "",
    [WORKSPACE_CHAT_OPENCODE_JSON_SECRET]: opencodeHome.configJson,
    ...(chatInput.lastBranch?.startsWith("ctxpipe/chat/")
      ? { [WORKSPACE_CHAT_SESSION_BRANCH_SECRET]: chatInput.lastBranch }
      : {}),
    ...opencodeHome.homeEnv,
    ...(input.isolation === "docker"
      ? {
          ...input.proxyEnv,
          // `gh` sends no request without a token; Agent Vault replaces the header.
          GH_TOKEN: WORKSPACE_CHAT_FIREWALL_PLACEHOLDER,
        }
      : { [WORKSPACE_CHAT_CLONE_TOKEN_SECRET]: cloneToken }),
  })
  const setup = [
    ...(input.isolation === "docker"
      ? WORKSPACE_CHAT_DOCKER_SETUP
      : input.isolation === "vercel"
        ? WORKSPACE_CHAT_VERCEL_SETUP
        : WORKSPACE_CHAT_SANDBOX_SETUP),
    ...WORKSPACE_CHAT_THREAD_SETUP,
  ]
  const setupNames = [
    "setup-opencode",
    "setup-git-exclude",
    "setup-checkout",
    "setup-opencode-json",
  ]
  return defineWorkspace({
    source: gitSource({
      url: originUrlWithoutCredentials(input.desiredUrl),
      ref: chatInput.defaultBranch?.trim() || "main",
      // Always present: the sandbox key covers whether auth exists, not the
      // token, and stock clone only authenticates when the token is non-empty.
      auth: { token: cloneToken },
    }),
    setup: setup.map((command, index) =>
      wrapSandboxSetupCommand(setupNames[index] ?? `setup-${index}`, command),
    ),
    secrets,
  })
}

export async function conversationHasStoredTurns(
  conversationId: string,
): Promise<boolean> {
  const persisted =
    await workspaceChatPersistence().stores.messages.loadThread(conversationId)
  if (persisted.length > 0) return true
  const turns = await loadConversationTurns(conversationId)
  return turns.length > 0
}

export function conversationUiMessagesFromModelMessages(
  messages: Parameters<typeof modelMessagesToUIMessages>[0],
) {
  return modelMessagesToUIMessages(messages)
}
