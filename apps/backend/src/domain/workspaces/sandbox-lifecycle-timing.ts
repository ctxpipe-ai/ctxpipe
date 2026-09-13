import { AsyncLocalStorage } from "node:async_hooks"
import type { SandboxHandle, SandboxProvider } from "@tanstack/ai-sandbox"
import { log } from "../../observability/logger.js"

export const SANDBOX_LIFECYCLE_MARK_PATH =
  "/tmp/ctxpipe-sandbox-lifecycle.jsonl"

type SandboxLifecycleScope = "ensure" | "chat"

type SandboxLifecycleContext = {
  conversationId?: string
  originMs: number
  scope: SandboxLifecycleScope
}

const lifecycleContext = new AsyncLocalStorage<SandboxLifecycleContext>()

export function enterSandboxLifecycleContext(conversationId: string): void {
  lifecycleContext.enterWith({
    conversationId,
    originMs: Date.now(),
    scope: "ensure",
  })
}

export function withSandboxLifecycleContext<T>(
  conversationId: string,
  fn: () => T,
): T {
  return lifecycleContext.run(
    { conversationId, originMs: Date.now(), scope: "ensure" },
    fn,
  )
}

export function setSandboxLifecycleScope(scope: SandboxLifecycleScope): void {
  const current = lifecycleContext.getStore()
  if (current) current.scope = scope
}

export function markSandboxLifecycle(
  phase: string,
  extra?: Record<string, unknown>,
): void {
  const current = lifecycleContext.getStore()
  const ms = typeof extra?.ms === "number" ? extra.ms : undefined
  log.info({
    step: "sandbox-lifecycle",
    phase,
    message:
      ms === undefined
        ? `sandbox lifecycle ${phase}`
        : `sandbox lifecycle ${phase} ${ms}ms`,
    conversationId: current?.conversationId,
    scope: current?.scope,
    sinceTurnMs:
      current === undefined ? undefined : Date.now() - current.originMs,
    ...extra,
  })
}

export async function timeSandboxLifecycle<T>(
  phase: string,
  fn: () => Promise<T>,
  extra?: Record<string, unknown>,
): Promise<T> {
  const started = Date.now()
  try {
    return await fn()
  } finally {
    markSandboxLifecycle(phase, { ...extra, ms: Date.now() - started })
  }
}

export function classifySandboxCommand(command: string): string {
  const cmd = command.trim()
  if (cmd.includes("opencode serve")) return "opencode-serve"
  if (cmd.includes("git cat-file -e")) return "git-cat-file"
  if (cmd.includes("git checkout --detach")) return "git-checkout-detach"
  if (cmd.includes("ls-remote")) return "git-ls-remote"
  if (cmd.includes("fetch --depth 1 origin")) {
    return cmd.includes("refs/heads/")
      ? "git-fetch-session-branch"
      : "git-fetch-commit"
  }
  if (cmd.includes("git checkout -B")) return "git-checkout-branch"
  if (cmd.includes("git rev-parse HEAD")) return "git-rev-parse-head"
  if (cmd.includes("command -v opencode") || cmd.includes("npm install -g"))
    return "setup-opencode"
  if (cmd.includes("info/exclude")) return "setup-git-exclude"
  if (cmd.includes("CTXPIPE_OPENCODE_JSON") || cmd.includes("opencode.json"))
    return "thread-setup-opencode-json"
  if (cmd === "sh" || cmd.startsWith("sh ")) return "bootstrap-shell"
  if (cmd.startsWith("git ")) return "git-exec"
  return "exec"
}

export function wrapSandboxSetupCommand(
  phase: string,
  command: string,
): string {
  if (!/^[a-z0-9-]+$/.test(phase))
    throw new Error(`Sandbox lifecycle phase is not a mark name: ${phase}`)
  return `CTXPIPE_LIFECYCLE_T0=$(date +%s%N)
${command}
CTXPIPE_LIFECYCLE_RC=$?
printf '{"phase":"%s","ns":%s,"endNs":%s}\\n' ${phase} "$CTXPIPE_LIFECYCLE_T0" "$(date +%s%N)" >> ${SANDBOX_LIFECYCLE_MARK_PATH}
(exit $CTXPIPE_LIFECYCLE_RC)`
}

export function parseSandboxLifecycleMarks(raw: string): Array<{
  phase: string
  ms: number
}> {
  const marks: Array<{ phase: string; ms: number }> = []
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const row = JSON.parse(trimmed) as {
      phase?: unknown
      ns?: unknown
      endNs?: unknown
    }
    if (
      typeof row.phase !== "string" ||
      typeof row.ns !== "number" ||
      typeof row.endNs !== "number"
    )
      continue
    marks.push({
      phase: row.phase,
      ms: Math.max(0, Math.round((row.endNs - row.ns) / 1_000_000)),
    })
  }
  return marks
}

export async function flushSandboxSetupMarks(
  handle: SandboxHandle,
): Promise<void> {
  const raw = await handle.fs.read(SANDBOX_LIFECYCLE_MARK_PATH).catch(() => "")
  for (const mark of parseSandboxLifecycleMarks(raw)) {
    markSandboxLifecycle(mark.phase, { ms: mark.ms, source: "setup-mark" })
  }
}

export function timedSandboxProvider(
  provider: SandboxProvider,
): SandboxProvider {
  return new Proxy(provider, {
    get(target, prop, receiver) {
      if (prop === "create") {
        return async (options: Parameters<SandboxProvider["create"]>[0]) =>
          timedSandboxHandle(
            await timeSandboxLifecycle("provider-create", () =>
              target.create(options),
            ),
          )
      }
      if (prop === "resume") {
        return async (options: Parameters<SandboxProvider["resume"]>[0]) => {
          const handle = await timeSandboxLifecycle("provider-resume", () =>
            target.resume(options),
          )
          return handle ? timedSandboxHandle(handle) : handle
        }
      }
      if (prop === "restoreSnapshot" && target.restoreSnapshot) {
        const restore = target.restoreSnapshot.bind(target)
        return async (
          options: Parameters<
            NonNullable<SandboxProvider["restoreSnapshot"]>
          >[0],
        ) =>
          timedSandboxHandle(
            await timeSandboxLifecycle("provider-restore-snapshot", () =>
              restore(options),
            ),
          )
      }
      return Reflect.get(target, prop, receiver)
    },
  })
}

export function timedSandboxHandle(handle: SandboxHandle): SandboxHandle {
  return {
    ...handle,
    env: {
      ...handle.env,
      set: (values) =>
        timeSandboxLifecycle("env-set", () => handle.env.set(values), {
          count: Object.keys(values).length,
        }),
    },
    git: {
      ...handle.git,
      clone: (options) =>
        timeSandboxLifecycle("git-clone", () => handle.git.clone(options), {
          ref: options.ref,
          depth: options.depth,
        }),
    },
    fs: {
      ...handle.fs,
      exists: async (path) => {
        const started = Date.now()
        const exists = await handle.fs.exists(path)
        if (path.endsWith("/.git") || /(?:^|\/)[^/]*lock[^/]*$/.test(path)) {
          markSandboxLifecycle(
            path.endsWith("/.git") ? "git-exists" : "fs-exists",
            { path, exists, ms: Date.now() - started },
          )
        }
        return exists
      },
    },
    process: {
      ...handle.process,
      exec: (command, options) => {
        const phase = classifySandboxCommand(command)
        const scope = lifecycleContext.getStore()?.scope ?? "chat"
        if (scope === "chat" && phase === "exec")
          return handle.process.exec(command, options)
        return timeSandboxLifecycle(
          phase,
          () => handle.process.exec(command, options),
          {
            command: command.slice(0, 96),
          },
        )
      },
      spawn: async (command, options) => {
        const phase = classifySandboxCommand(command)
        const started = Date.now()
        markSandboxLifecycle(`${phase}:start`, {
          command: command.slice(0, 96),
        })
        const proc = await handle.process.spawn(command, options)
        return {
          ...proc,
          kill: async () => {
            markSandboxLifecycle(phase, { ms: Date.now() - started })
            return proc.kill()
          },
        }
      },
    },
  }
}
