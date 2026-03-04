"use client"

import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input"
import type { ChatStatus } from "ai"

export function MessageInputBox(props: {
  sendMessage: (params: { text: string }) => void
  status?: ChatStatus
  onStop?: () => void
  isDisabled?: boolean
}) {
  const { sendMessage, status, onStop, isDisabled } = props
  const isGenerating = status === "submitted" || status === "streaming"

  const handleSubmit = ({ text }: { text: string }) => {
    const trimmed = text.trim()
    if (!trimmed || isDisabled) return
    sendMessage({ text: trimmed })
  }

  return (
    <div className="bg-zinc-950/70 px-4 py-3">
      <PromptInput
        className="w-full"
        onSubmit={(message) => handleSubmit(message)}
      >
        <PromptInputBody>
          <PromptInputTextarea
            placeholder="Ask anything..."
            className="p-4 pb-0"
            autoFocus
          />
        </PromptInputBody>
        <PromptInputFooter className="p-4 pt-1!">
          <PromptInputTools></PromptInputTools>
          <PromptInputSubmit
            status={status}
            onStop={onStop}
            isDisabled={isDisabled}
            className={
              "px-4 border-teal-500 text-white border w-auto rounded-md shadow-[0_0_12px_--theme(--color-teal-500/0.35)] hover:bg-teal-500/10 hover:shadow-[0_0_20px_--theme(--color-teal-500/0.55)] focus-visible:shadow-[0_0_20px_--theme(--color-teal-500/0.55)] transition-shadow"
            }
          >
            {isGenerating ? undefined : "Send"}
          </PromptInputSubmit>
        </PromptInputFooter>
      </PromptInput>
    </div>
  )
}
