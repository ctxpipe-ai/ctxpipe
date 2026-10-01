import { IconCheck, IconCopy } from "@tabler/icons-react"
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
  /**
   * Set once nothing before this step is left to do: the primary becomes
   * Open ctx|, and skipping finishes too.
   */
  finish: {
    onFinish: () => void
    pending: boolean
    /** Why something stays dark, e.g. GitHub was skipped. */
    note: string | null
  } | null
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
  finish,
}: OnboardingAgentStepProps) {
  const back = (
    <Button variant="quiet" className="rounded-none px-0" onPress={onBack}>
      Back
    </Button>
  )
  const note = finish?.note ? (
    <p className="m-0 text-sm text-muted-foreground">{finish.note}</p>
  ) : null
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
          {note}
          <StepActions
            back={back}
            primary={
              finish ? (
                <Button
                  variant="primary"
                  className="rounded-none"
                  isPending={finish.pending}
                  onPress={finish.onFinish}
                >
                  Open ctx|
                </Button>
              ) : undefined
            }
          />
        </>
      ) : (
        <>
          <output className="flex flex-col gap-3 border border-teal-400/30 bg-teal-400/[0.04] p-4">
            <span className="inline-flex items-center gap-2 text-sm text-zinc-100">
              <span className="ctx-indexing-dot" aria-hidden />
              Listening for your agent’s first call
            </span>
            {hasSource && firstRepository ? (
              <span className="flex flex-col gap-1.5">
                <span className="text-sm text-muted-foreground">
                  Paste this into your agent:
                </span>
                <PromptToCopy
                  text={`Use ctx| to explain how ${firstRepository} is structured.`}
                />
              </span>
            ) : (
              <span className="text-sm text-muted-foreground">
                Ask it anything that uses ctx|. Answers stay empty until a
                repository is indexed.
              </span>
            )}
          </output>

          {note}
          <StepActions
            back={back}
            secondary={
              <Button
                variant="ghost"
                className="rounded-none"
                isPending={finish?.pending}
                onPress={() => {
                  onSkip()
                  finish?.onFinish()
                }}
              >
                {finish ? "Skip and open ctx|" : "I’ll do this later"}
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

/** The prompt to try, as one line they can copy in a click. */
function PromptToCopy({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <span className="flex items-stretch border border-white/10 bg-zinc-950">
      <code className="min-w-0 flex-1 px-3 py-2 font-mono text-xs leading-5 text-zinc-100">
        {text}
      </code>
      <Button
        variant="quiet"
        aria-label={copied ? "Copied" : "Copy prompt"}
        className="h-auto shrink-0 rounded-none border-l border-white/10 px-3 text-zinc-400 hover:text-teal-300"
        onPress={async () => {
          try {
            await navigator.clipboard.writeText(text)
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          } catch {
            // The prompt is still there to select by hand.
          }
        }}
      >
        {copied ? (
          <IconCheck className="size-4 text-teal-400" aria-hidden />
        ) : (
          <IconCopy className="size-4" aria-hidden />
        )}
      </Button>
    </span>
  )
}
