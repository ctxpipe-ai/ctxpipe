"use client"

import { IconArrowUp } from "@tabler/icons-react"
import { type ReactNode, type RefObject, useEffect, useRef } from "react"

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

/** An example prompt: a short label for its pill, and the full text. */
type PromptSuggestion = { label: string; prompt: string }

/**
 * The composer of a chat: the user writes a message and sends it, or stops
 * the turn that runs. The `thread` layout docks it below a conversation; the
 * `empty` layout is the large composer of a new chat, with example prompts.
 * With a `draftKey`, unsent text stays when the user goes to another page.
 */
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
  suggestions?: readonly PromptSuggestion[]
  /** Controls at the leading edge of the footer, such as the base branch picker. */
  tools?: ReactNode
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
    tools,
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
                  ? "min-h-24 px-4 pt-4 pb-12"
                  : "min-h-16 px-4 pt-3 pb-12",
              )}
              autoFocus={layout === "empty" && !isDisabled}
            />
          </PromptInputBody>
          {/* The footer controls start on the text column (16px). The send
              button sits 12px from the right and the bottom edge, and the
              controls share its center line. */}
          <PromptInputFooter className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 border-0 bg-transparent pt-0 pr-3 pb-3 pl-4 shadow-none">
            <PromptInputTools>{tools}</PromptInputTools>
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

/**
 * The example prompts as a centered row of pills under the composer. They
 * have a hairline frame, so they do not look like the quiet controls in the
 * composer footer.
 */
function MessageInputSuggestions(props: {
  suggestions: readonly PromptSuggestion[]
  textareaRef: RefObject<HTMLTextAreaElement | null>
  isDisabled?: boolean
}) {
  const controller = usePromptInputController()
  return (
    <ul
      aria-label="Suggested prompts"
      className="mt-3 flex flex-wrap justify-center gap-2"
    >
      {props.suggestions.map((suggestion) => (
        <li key={suggestion.label}>
          <Button
            variant="quiet"
            size="sm"
            isDisabled={props.isDisabled}
            className="border border-white/10 px-2.5 font-normal"
            onPress={() => {
              controller.textInput.setInput(suggestion.prompt)
              props.textareaRef.current?.focus()
            }}
          >
            {suggestion.label}
          </Button>
        </li>
      ))}
    </ul>
  )
}
