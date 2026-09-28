import { useState } from "react"
import { Button } from "@/components/ui/Button"
import { mcpConfigSnippet } from "./onboarding-state"

type OnboardingAgentStepProps = {
  orgSlug: string
  hasSource: boolean
  firstRepository: string | null
  onSkip: () => void
}

export function OnboardingAgentStep({
  orgSlug,
  hasSource,
  firstRepository,
  onSkip,
}: OnboardingAgentStepProps) {
  const snippet = mcpConfigSnippet(orgSlug)
  return (
    <>
      <p className="m-0 text-sm text-muted-foreground">
        Paste this into your agent’s MCP settings. It points at{" "}
        <code className="font-mono text-zinc-200">{orgSlug}</code>.
      </p>
      <pre className="m-0 overflow-x-auto border border-white/10 bg-zinc-950 p-3 font-mono text-xs leading-5 text-zinc-200">
        <code>{snippet}</code>
      </pre>
      <CopyButton text={snippet} label="Copy config" />
      <p className="m-0 text-sm text-muted-foreground">
        Or run <code className="font-mono text-zinc-200">npx ctxpipe init</code>{" "}
        inside a repository. It writes the config for Cursor, Claude Code,
        Codex, OpenCode or VS Code.
      </p>

      <output className="flex flex-col gap-1 border border-teal-400/30 bg-teal-400/[0.04] p-4">
        <span className="inline-flex items-center gap-2 text-sm text-zinc-100">
          <span className="ctx-indexing-dot" aria-hidden />
          Listening for your agent’s first call
        </span>
        <span className="text-sm text-muted-foreground">
          {hasSource && firstRepository
            ? `Ask it something that needs ctx|, for example: “Use ctx| to explain how ${firstRepository} is structured.”`
            : "Ask it anything that uses ctx|. Answers stay empty until a repository is indexed."}
        </span>
      </output>

      <div>
        <Button variant="ghost" className="rounded-none" onPress={onSkip}>
          I’ll do this later
        </Button>
      </div>
    </>
  )
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "error">("idle")
  return (
    <div>
      <Button
        variant="primary"
        className="rounded-none"
        onPress={async () => {
          try {
            await navigator.clipboard.writeText(text)
            setState("copied")
          } catch {
            setState("error")
          }
        }}
      >
        {state === "copied"
          ? "Copied"
          : state === "error"
            ? "Copy failed"
            : label}
      </Button>
    </div>
  )
}
