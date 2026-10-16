import { useMutation } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"
import { Input, Button as RACButton, TextField } from "react-aria-components"
import { focusVisibleClassName } from "@/lib/focus-styles"
import { cn } from "@/lib/utils"
import { renameConversation } from "./queries"

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
  const [draft, setDraft] = useState(props.name)
  // Escape unmounts the input, and the unmount must not save.
  const cancelled = useRef(false)
  // The name when the edit started. The automatic title can change `props.name`
  // while the input is open, and an unedited draft must not save the old name.
  const startName = useRef(props.name)
  // Enter and Escape return focus to the title button. A blur does not.
  const restoreFocus = useRef(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!isEditing && restoreFocus.current) {
      restoreFocus.current = false
      buttonRef.current?.focus()
    }
  }, [isEditing])
  const rename = useMutation({
    mutationFn: (name: string) =>
      renameConversation(props.orgSlug, props.conversationId, name),
    onSuccess: (updated) => {
      props.onRenamed(updated.name)
      setIsEditing(false)
    },
  })
  const stop = () => {
    rename.reset()
    setIsEditing(false)
  }
  const save = () => {
    if (cancelled.current || rename.isPending) return
    const name = draft.trim()
    if (!name || name === startName.current) {
      stop()
      return
    }
    rename.mutate(name)
  }

  if (!isEditing) {
    return (
      <RACButton
        ref={buttonRef}
        aria-label={`Rename conversation: ${props.name}`}
        onPress={() => {
          cancelled.current = false
          startName.current = props.name
          setDraft(props.name)
          setIsEditing(true)
        }}
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
    <div className="flex min-w-0 flex-col">
      <TextField
        aria-label="Conversation name"
        value={draft}
        onChange={setDraft}
        isReadOnly={rename.isPending}
        isInvalid={rename.isError}
        className="min-w-0"
      >
        <Input
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          onBlur={rename.isError ? stop : save}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault()
              restoreFocus.current = true
              // The blur handler is the one save path.
              event.currentTarget.blur()
            } else if (event.key === "Escape") {
              event.preventDefault()
              cancelled.current = true
              restoreFocus.current = true
              stop()
            }
          }}
          className="field-sizing-content min-w-[8ch] max-w-full rounded-sm bg-transparent font-[inherit] text-[length:inherit] leading-[inherit] text-foreground outline-none ring-1 ring-teal-500/60 focus-visible:ring-teal-500"
        />
      </TextField>
      {rename.error ? (
        <p
          role="alert"
          className="absolute top-full left-0 z-20 mt-1 rounded-md bg-zinc-800 px-2 py-1 text-xs font-normal text-red-400 shadow-md"
        >
          {rename.error.message}
        </p>
      ) : null}
    </div>
  )
}
