"use client"

import { IconArrowUp } from "@tabler/icons-react"
import type { ChatStatus } from "ai"
import { useEffect } from "react"
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputProvider,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputController,
} from "@/components/ai-elements/prompt-input"
import { cn } from "@/lib/utils"

export type MessageInputLayout = "thread" | "empty"

export function MessageInputBox(props: {
  sendMessage: (params: { text: string }) => void
  status?: ChatStatus
  onStop?: () => void
  isDisabled?: boolean
  /** thread: footer dock with top border; empty: hero composer */
  layout?: MessageInputLayout
  placeholder?: string
  draftSeed?: string | null
  onDraftSeedConsumed?: () => void
  contentClassName?: string
}) {
  const {
    sendMessage,
    status,
    onStop,
    isDisabled,
    layout = "thread",
    placeholder,
    draftSeed,
    onDraftSeedConsumed,
    contentClassName,
  } = props
  const isGenerating = status === "submitted" || status === "streaming"

  const handleSubmit = ({ text }: { text: string }) => {
    const trimmed = text.trim()
    if (!trimmed || isDisabled) return
    sendMessage({ text: trimmed })
  }

  const inputShell = (
    <PromptInputProvider>
      <MessageInputDraftSeed
        seed={draftSeed ?? null}
        onConsumed={onDraftSeedConsumed}
      />
      <div className="relative ctx-border ctx-surface overflow-hidden transition-colors focus-within:border-primary/30">
        <PromptInput
          className="w-full [&_[data-slot=input-group]]:min-h-0 [&_[data-slot=input-group]]:flex-col [&_[data-slot=input-group]]:items-stretch [&_[data-slot=input-group]]:rounded-none [&_[data-slot=input-group]]:border-0 [&_[data-slot=input-group]]:bg-transparent [&_[data-slot=input-group]]:shadow-none"
          onSubmit={(message) => handleSubmit(message)}
        >
          <PromptInputBody>
            <PromptInputTextarea
              placeholder={
                placeholder ??
                (layout === "empty"
                  ? "Ask anything…"
                  : "Continue the conversation…")
              }
              className={cn(
                "resize-none border-0 bg-transparent text-[15px] leading-relaxed focus-visible:ring-0",
                layout === "empty"
                  ? "min-h-[120px] p-4 pb-16"
                  : "min-h-[80px] p-4 pb-12",
              )}
              autoFocus={layout === "empty"}
            />
          </PromptInputBody>
          <PromptInputFooter className="absolute bottom-4 right-4 flex items-center gap-3 border-0 bg-transparent p-0 shadow-none">
            <PromptInputTools />
            <PromptInputSubmit
              size="sm"
              variant="primary"
              status={status}
              onStop={onStop}
              isDisabled={isDisabled}
              className="h-8 gap-2 rounded-none border-0 bg-teal-500 px-3 text-sm font-medium text-white shadow-none hover:bg-teal-400 focus-visible:ring-2 focus-visible:ring-teal-400/80 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              {isGenerating ? undefined : (
                <>
                  Send
                  <IconArrowUp aria-hidden className="h-3.5 w-3.5" />
                </>
              )}
            </PromptInputSubmit>
          </PromptInputFooter>
        </PromptInput>
      </div>
    </PromptInputProvider>
  )

  if (layout === "empty") {
    return <div className="w-full">{inputShell}</div>
  }

  return (
    <div className="shrink-0 border-t border-white/[0.04] p-4">
      <div className={cn("mx-auto max-w-2xl", contentClassName)}>
        {inputShell}
      </div>
    </div>
  )
}

function MessageInputDraftSeed(props: {
  seed: string | null
  onConsumed?: () => void
}) {
  const controller = usePromptInputController()

  useEffect(() => {
    if (!props.seed) return
    controller.textInput.setInput(props.seed)
    props.onConsumed?.()
  }, [props.seed, props.onConsumed, controller])

  return null
}
