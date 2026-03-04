"use client"

import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input"

export function MessageInputBox(props: {
  sendMessage: (params: { text: string }) => void
  isDisabled?: boolean
}) {
  const { sendMessage, isDisabled } = props

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
            isDisabled={isDisabled}
            className={
              "px-4 border-teal-500 text-white border w-auto rounded-md shadow-[0_0_12px_--theme(--color-teal-500/0.35)] hover:bg-teal-500/10 hover:shadow-[0_0_20px_--theme(--color-teal-500/0.55)] focus-visible:shadow-[0_0_20px_--theme(--color-teal-500/0.55)] transition-shadow"
            }
          >
            Send
          </PromptInputSubmit>
        </PromptInputFooter>
      </PromptInput>
    </div>
  )
}
