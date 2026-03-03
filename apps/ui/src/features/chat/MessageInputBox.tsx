"use client"

import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
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
    <div className="border-t border-zinc-800 px-4 py-3">
      <PromptInput
        className="w-full"
        onSubmit={(message) => handleSubmit(message)}
      >
        <PromptInputBody>
          <PromptInputTextarea placeholder="Ask anything..." />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputSubmit isDisabled={isDisabled}>
            Send
          </PromptInputSubmit>
        </PromptInputFooter>
      </PromptInput>
    </div>
  )
}
