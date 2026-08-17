import type * as TanstackAi from "@tanstack/ai"
import type * as TanstackOpencode from "@tanstack/ai-opencode"
import type * as TanstackSandbox from "@tanstack/ai-sandbox"
import type * as TanstackDocker from "@tanstack/ai-sandbox-docker"
import type * as TanstackLocal from "@tanstack/ai-sandbox-local-process"

export type TanstackChatModules = {
  chat: typeof TanstackAi.chat
  opencodeText: typeof TanstackOpencode.opencodeText
  defineSandbox: typeof TanstackSandbox.defineSandbox
  defineWorkspace: typeof TanstackSandbox.defineWorkspace
  gitSource: typeof TanstackSandbox.gitSource
  withSandbox: typeof TanstackSandbox.withSandbox
  dockerSandbox?: typeof TanstackDocker.dockerSandbox
  sbxSandbox?: typeof TanstackDocker.sbxSandbox
  localProcessSandbox?: typeof TanstackLocal.localProcessSandbox
}

export async function loadTanstackChatModules(): Promise<TanstackChatModules> {
  const [{ chat }, { opencodeText }, sandbox, docker, local] =
    await Promise.all([
      import("@tanstack/ai"),
      import("@tanstack/ai-opencode"),
      import("@tanstack/ai-sandbox"),
      import("@tanstack/ai-sandbox-docker").catch(() => null),
      import("@tanstack/ai-sandbox-local-process").catch(() => null),
    ])
  return {
    chat,
    opencodeText,
    defineSandbox: sandbox.defineSandbox,
    defineWorkspace: sandbox.defineWorkspace,
    gitSource: sandbox.gitSource,
    withSandbox: sandbox.withSandbox,
    dockerSandbox: docker?.dockerSandbox,
    sbxSandbox: docker?.sbxSandbox,
    localProcessSandbox: local?.localProcessSandbox,
  }
}
