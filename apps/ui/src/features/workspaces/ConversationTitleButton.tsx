import { useEffect, useRef, useState } from "react"
import { Button as RACButton } from "react-aria-components"
import { focusVisibleClassName } from "@/lib/focus-styles"
import { cn } from "@/lib/utils"
import { ConversationNameInput } from "./ConversationNameInput"

/**
 * The conversation title in the chat header. Pressing it turns the title into
 * an input. Enter or blur saves the name, and Escape cancels. An empty or
 * unchanged name does nothing.
 */
export function ConversationTitleButton(props: {
  orgSlug: string
  conversationId: string
  name: string
  onRenamed: (name: string) => void
}) {
  const [isEditing, setIsEditing] = useState(false)
  // Enter and Escape return focus to the title button. A blur does not.
  const restoreFocus = useRef(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!isEditing && restoreFocus.current) {
      restoreFocus.current = false
      buttonRef.current?.focus()
    }
  }, [isEditing])

  if (!isEditing) {
    return (
      <RACButton
        ref={buttonRef}
        aria-label={`Rename conversation: ${props.name}`}
        onPress={() => setIsEditing(true)}
        className={cn(
          "min-w-0 rounded-md text-left hover:text-teal-400",
          focusVisibleClassName,
        )}
      >
        <span className="block truncate">{props.name}</span>
      </RACButton>
    )
  }
  return (
    <ConversationNameInput
      orgSlug={props.orgSlug}
      conversationId={props.conversationId}
      name={props.name}
      onRenamed={props.onRenamed}
      onDone={(options) => {
        restoreFocus.current = options.restoreFocus
        setIsEditing(false)
      }}
      className="field-sizing-content min-w-[8ch]"
      errorClassName="absolute top-full left-0"
    />
  )
}
