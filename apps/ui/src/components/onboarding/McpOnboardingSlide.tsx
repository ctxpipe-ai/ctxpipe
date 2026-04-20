import { useState } from "react"
import { McpConfigPrWizard } from "@/components/onboarding/McpConfigPrWizard"

export function McpOnboardingSlide(props: {
  orgSlug: string | null
  hasGithubInstallation: boolean
  mcpSnippet: string
  mcpCopyState: "idle" | "copied" | "error"
  onCopySnippet: () => void
  onContinue: () => void
  onSkip: () => void
}) {
  const { orgSlug, hasGithubInstallation } = props
  const [mode, setMode] = useState<"choose" | "manual" | "auto">("choose")

  return (
    <>
      <h2 className="onb-in-1 mb-4 text-3xl font-semibold text-zinc-100 sm:text-4xl">
        Connect ctx| to your agents
      </h2>

      {mode === "choose" && (
        <div className="onb-in-2 mx-auto mb-10 max-w-3xl">
          <p className="mx-auto mb-8 max-w-2xl text-balance text-zinc-300">
            Add the ctx| MCP server manually with a JSON snippet, or open pull
            requests that drop the right config files into repositories you
            already connected on GitHub.
          </p>
          <div className="mx-auto grid max-w-2xl gap-4 sm:grid-cols-2">
            <button
              type="button"
              className="rounded-none border border-border bg-zinc-950/70 p-6 text-left transition-colors hover:border-teal-400/40"
              onClick={() => setMode("manual")}
            >
              <span className="block text-lg font-medium text-zinc-100">
                Install manually
              </span>
              <span className="mt-2 block text-sm text-zinc-400">
                Copy a ready-made MCP config for Cursor, Claude Code, or other
                HTTP MCP clients.
              </span>
            </button>
            <button
              type="button"
              disabled={!hasGithubInstallation}
              className={`rounded-none border border-border p-6 text-left transition-colors ${
                hasGithubInstallation
                  ? "bg-zinc-950/70 hover:border-teal-400/40"
                  : "cursor-not-allowed bg-zinc-950/40 opacity-60"
              }`}
              onClick={() => hasGithubInstallation && setMode("auto")}
            >
              <span className="block text-lg font-medium text-zinc-100">
                Open PRs for me
              </span>
              <span className="mt-2 block text-sm text-zinc-400">
                {hasGithubInstallation
                  ? "Pick agents and repos; we commit config files and open one PR per repository."
                  : "Connect GitHub in the previous step (or from repository settings) to use automatic PRs."}
              </span>
            </button>
          </div>
          <div className="mt-10 flex flex-col items-center gap-6">
            <button
              type="button"
              className="text-sm text-zinc-500 underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-zinc-300"
              onClick={() => props.onSkip()}
            >
              I&apos;ll do this later
            </button>
          </div>
        </div>
      )}

      {mode === "manual" && (
        <div className="onb-in-2 mx-auto mb-10 max-w-3xl">
          <p className="mx-auto mb-6 max-w-2xl text-balance text-zinc-300">
            Paste this into your MCP client configuration. The URL targets this
            deployment and includes your organisation slug.
          </p>
          <div className="mx-auto max-w-3xl rounded-none border border-border bg-zinc-950/70 p-4 text-left">
            <pre className="overflow-x-auto text-sm leading-6 text-zinc-100">
              <code>{props.mcpSnippet}</code>
            </pre>
          </div>
          <div className="mt-6 flex flex-col items-center gap-6">
            <button
              type="button"
              className="inline-flex h-11 items-center justify-center rounded-none border border-border bg-zinc-100 px-6 text-sm font-medium text-zinc-950 transition-colors hover:bg-zinc-200"
              onClick={() => void props.onCopySnippet()}
            >
              {props.mcpCopyState === "copied"
                ? "Copied"
                : props.mcpCopyState === "error"
                  ? "Copy failed"
                  : "Copy JSON"}
            </button>
            <button
              type="button"
              className="text-sm text-zinc-500 underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-zinc-300"
              onClick={() => props.onContinue()}
            >
              Continue
            </button>
            <button
              type="button"
              className="text-sm text-zinc-500 underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-zinc-300"
              onClick={() => setMode("choose")}
            >
              Back
            </button>
          </div>
        </div>
      )}

      {mode === "auto" && (
        <McpConfigPrWizard
          variant="onboarding"
          orgSlug={orgSlug}
          hasGithubInstallation={hasGithubInstallation}
          onContinue={props.onContinue}
          onBackToModeChoice={() => setMode("choose")}
        />
      )}
    </>
  )
}
