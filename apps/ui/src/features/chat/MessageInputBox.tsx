"use client"

import { IconArrowUp, IconChevronRight } from "@tabler/icons-react"
import { type RefObject, useEffect, useRef } from "react"
import { Disclosure, DisclosurePanel } from "react-aria-components"
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
import { Button } from "@/components/ui/Button"
import type { ChatStatus } from "@/features/chat/types"
import { focusVisibleClassName } from "@/lib/focus-styles"
import { cn } from "@/lib/utils"
import { chatColumnClassName } from "./chat-column"
import { readChatDraft, writeChatDraft } from "./chat-draft"

type MessageInputLayout = "thread" | "empty"

export function MessageInputBox(props: {
  sendMessage: (params: { text: string }) => void
  status?: ChatStatus
  onStop?: () => void
  isDisabled?: boolean
  /** thread: footer dock; empty: hero composer */
  layout?: MessageInputLayout
  placeholder?: string
  draftSeed?: string | null
  /** Unsent text survives navigation for the session under this key. */
  draftKey?: string
  contentClassName?: string
  /** Example prompts under the composer. Picking one fills the composer; it does not send. */
  suggestions?: readonly string[]
}) {
  const {
    sendMessage,
    status,
    onStop,
    isDisabled,
    layout = "thread",
    placeholder,
    draftSeed,
    draftKey,
    contentClassName,
    suggestions,
  } = props
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const isGenerating = status === "submitted" || status === "streaming"

  const handleSubmit = ({ text }: { text: string }) => {
    const trimmed = text.trim()
    if (!trimmed || isDisabled) return
    if (draftKey) writeChatDraft(draftKey, "")
    sendMessage({ text: trimmed })
  }

  const inputShell = (
    <PromptInputProvider
      key={draftKey}
      initialInput={draftSeed ?? (draftKey ? readChatDraft(draftKey) : "")}
    >
      <MessageInputDraftSeed seed={draftSeed ?? null} />
      {draftKey ? <MessageInputDraftStore draftKey={draftKey} /> : null}
      <div
        className={cn(
          "relative overflow-hidden rounded-md bg-zinc-900/80",
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
              ref={textareaRef}
              disabled={isDisabled}
              placeholder={
                placeholder ??
                (layout === "empty"
                  ? "Ask anything…"
                  : "Continue the conversation…")
              }
              className={cn(
                "resize-none border-0 bg-transparent text-sm leading-relaxed text-foreground placeholder:text-muted-foreground focus-visible:ring-0",
                layout === "empty"
                  ? "min-h-24 px-4 pt-4 pb-14"
                  : "min-h-16 px-4 pt-3 pb-12",
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
              isDisabled={isDisabled && !isGenerating}
              className={cn(
                "size-8 shrink-0 rounded-md border-0 bg-primary text-primary-foreground shadow-none",
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
      {suggestions && suggestions.length > 0 ? (
        <MessageInputSuggestions
          suggestions={suggestions}
          textareaRef={textareaRef}
          isDisabled={isDisabled}
        />
      ) : null}
    </PromptInputProvider>
  )

  if (layout === "empty") {
    return <div className="w-full">{inputShell}</div>
  }

  return (
    <div className="shrink-0 p-3 pt-0">
      <div className={cn("mx-auto", chatColumnClassName, contentClassName)}>
        {inputShell}
      </div>
    </div>
  )
}

function MessageInputDraftSeed(props: { seed: string | null }) {
  const controller = usePromptInputController()
  const appliedRef = useRef<string | null>(null)

  useEffect(() => {
    if (props.seed) {
      if (appliedRef.current === props.seed) return
      appliedRef.current = props.seed
      controller.textInput.setInput(props.seed)
      return
    }
    if (appliedRef.current == null) return
    appliedRef.current = null
    controller.textInput.clear()
  }, [controller, props.seed])

  return null
}

/** Mirrors the composer text to sessionStorage; an empty text removes the entry. */
function MessageInputDraftStore(props: { draftKey: string }) {
  const controller = usePromptInputController()
  const text = controller.textInput.value
  useEffect(() => {
    writeChatDraft(props.draftKey, text)
  }, [props.draftKey, text])
  return null
}

function MessageInputSuggestions(props: {
  suggestions: readonly string[]
  textareaRef: RefObject<HTMLTextAreaElement | null>
  isDisabled?: boolean
}) {
  const controller = usePromptInputController()
  return (
    <Disclosure className="group mt-2" isDisabled={props.isDisabled}>
      <Button slot="trigger" variant="quiet" className="h-7 gap-1 px-1 text-xs">
        <IconChevronRight
          aria-hidden
          className="size-3.5 transition-transform group-data-[expanded]:rotate-90"
        />
        Suggested
      </Button>
      <DisclosurePanel>
        <ul
          aria-label="Suggested prompts"
          className="mt-1 flex flex-col gap-0.5"
        >
          {props.suggestions.map((suggestion) => (
            <li key={suggestion}>
              <Button
                variant="ghost"
                className="h-auto w-full justify-start px-2 py-1.5 text-left text-sm"
                onPress={() => {
                  controller.textInput.setInput(suggestion)
                  props.textareaRef.current?.focus()
                }}
              >
                {suggestion}
              </Button>
            </li>
          ))}
        </ul>
      </DisclosurePanel>
    </Disclosure>
  )
}
