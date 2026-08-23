"use client"

import { IconArrowUp } from "@tabler/icons-react"
import type { ChatStatus } from "@/features/chat/types"
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
import { focusVisibleClassName } from "@/lib/focus-styles"
import { cn } from "@/lib/utils"

export type MessageInputLayout = "thread" | "empty"

export function MessageInputBox(props: {
  sendMessage: (params: { text: string }) => void
  status?: ChatStatus
  onStop?: () => void
  isDisabled?: boolean
  /** thread: footer dock; empty: hero composer */
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
      <div
        className={cn(
          "relative overflow-hidden rounded-xl bg-zinc-900/80",
          "ring-1 ring-white/[0.08] transition-[box-shadow,background-color]",
          "focus-within:bg-zinc-900 focus-within:ring-teal-400/40",
        )}
      >
        <PromptInput
          className="w-full [&_[data-slot=input-group]]:min-h-0 [&_[data-slot=input-group]]:flex-col [&_[data-slot=input-group]]:items-stretch [&_[data-slot=input-group]]:rounded-none [&_[data-slot=input-group]]:border-0 [&_[data-slot=input-group]]:bg-transparent [&_[data-slot=input-group]]:shadow-none"
          onSubmit={(message) => handleSubmit(message)}
        >
          <PromptInputBody>
            <PromptInputTextarea
              disabled={isDisabled}
              placeholder={
                placeholder ??
                (layout === "empty"
                  ? "Ask anything…"
                  : "Continue the conversation…")
              }
              className={cn(
                "resize-none border-0 bg-transparent text-sm leading-relaxed text-foreground placeholder:text-muted-foreground focus-visible:ring-0",
                layout === "empty" ? "min-h-28 px-4 pt-4 pb-14" : "min-h-20 px-4 pt-3 pb-12",
              )}
              autoFocus={layout === "empty" && !isDisabled}
            />
          </PromptInputBody>
          <PromptInputFooter className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 border-0 bg-transparent px-3 pb-3 pt-0 shadow-none">
            <PromptInputTools />
            <PromptInputSubmit
              size="icon-sm"
              variant="primary"
              status={status}
              onStop={onStop}
              isDisabled={isDisabled}
              className={cn(
                "size-8 shrink-0 rounded-full border-0 bg-primary text-primary-foreground shadow-none",
                "hover:bg-primary/90",
                focusVisibleClassName,
              )}
            >
              {isGenerating ? undefined : (
                <IconArrowUp aria-hidden className="size-4" stroke={1.75} />
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
    <div className="shrink-0 p-3 pt-0">
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
