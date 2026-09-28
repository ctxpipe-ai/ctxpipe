import { useState } from "react"
import { Button } from "@/components/ui/Button"
import { Radio, RadioGroup } from "@/components/ui/RadioGroup"
import { StepActions } from "./OnboardingStep"
import { agentSetup } from "./onboarding-state"

type OnboardingAgentStepProps = {
  orgSlug: string
  hasSource: boolean
  firstRepository: string | null
  /** Set once their agent has called ctx| (the step was reopened). */
  connectedClient: string | null
  onSkip: () => void
  onBack: () => void
}

type Method = "cli" | "claude" | "json"

const METHODS: Array<{ id: Method; title: string; description: string }> = [
  {
    id: "cli",
    title: "npx ctxpipe init",
    description:
      "Recommended. Run it in a repository to set up Cursor, Claude Code, Codex, OpenCode or VS Code.",
  },
  {
    id: "claude",
    title: "Quick add to Claude Code",
    description: "One command adds ctx| to Claude Code for your user.",
  },
  {
    id: "json",
    title: "Other agents",
    description: "Paste the MCP config into any agent that takes a server URL.",
  },
]

export function OnboardingAgentStep({
  orgSlug,
  hasSource,
  firstRepository,
  connectedClient,
  onSkip,
  onBack,
}: OnboardingAgentStepProps) {
  const [method, setMethod] = useState<Method>("cli")
  const setup = agentSetup(window.location.origin, orgSlug)
  const text = setup[method]

  return (
    <>
      <RadioGroup
        aria-label="How to connect your agent"
        value={method}
        onChange={(value) => setMethod(value as Method)}
      >
        {METHODS.map((option) => (
          <Radio key={option.id} value={option.id} className="items-start">
            <span className="flex flex-col gap-0.5">
              <span
                className={`text-sm font-medium text-zinc-100 ${option.id === "cli" ? "font-mono" : ""}`}
              >
                {option.title}
              </span>
              <span className="text-sm text-muted-foreground">
                {option.description}
              </span>
            </span>
          </Radio>
        ))}
      </RadioGroup>

      <pre className="m-0 overflow-x-auto border border-white/10 bg-zinc-950 p-3 font-mono text-xs leading-5 text-zinc-200">
        <code>{text}</code>
      </pre>
      <CopyButton
        key={method}
        text={text}
        label={method === "json" ? "Copy config" : "Copy command"}
      />

      {connectedClient ? (
        <>
          <p className="m-0 text-sm text-muted-foreground">
            <span className="font-mono text-zinc-200">{connectedClient}</span>{" "}
            is connected. Add ctx| to another agent the same way.
          </p>
          <StepActions
            back={
              <Button
                variant="quiet"
                className="rounded-none px-0"
                onPress={onBack}
              >
                Back
              </Button>
            }
          />
        </>
      ) : (
        <>
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

          <StepActions
            back={
              <Button
                variant="quiet"
                className="rounded-none px-0"
                onPress={onBack}
              >
                Back
              </Button>
            }
            secondary={
              <Button variant="ghost" className="rounded-none" onPress={onSkip}>
                I’ll do this later
              </Button>
            }
          />
        </>
      )}
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
