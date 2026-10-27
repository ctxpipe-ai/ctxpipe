import { useMutation } from "@tanstack/react-query"
import { useRef, useState } from "react"
import { Input, TextField } from "react-aria-components"

import { focusVisibleClassName } from "@/lib/focus-styles"
import { cn } from "@/lib/utils"

import { renameConversation } from "./queries"

/**
 * The input that renames a conversation. Enter or blur saves the name, and
 * Escape cancels. An empty or unchanged name does nothing. The chat header and
 * the chat list both show it.
 *
 * `onDone` runs when the edit ends. `restoreFocus` is true after Enter or
 * Escape, so the caller can return focus to its own control. A blur does not
 * ask for focus.
 */
export function ConversationNameInput(props: {
  orgSlug: string
  conversationId: string
  name: string
  onRenamed: (name: string) => void
  onDone: (options: { restoreFocus: boolean }) => void
  className?: string
  errorClassName?: string
}) {
  const [draft, setDraft] = useState(props.name)
  // Escape unmounts the input, and the unmount must not save.
  const cancelled = useRef(false)
  // The name when the edit started. The automatic title can change `props.name`
  // while the input is open, and an unedited draft must not save the old name.
  const startName = useRef(props.name)
  const restoreFocus = useRef(false)
  const rename = useMutation({
    mutationFn: (name: string) =>
      renameConversation(props.orgSlug, props.conversationId, name),
    onSuccess: (updated) => {
      props.onRenamed(updated.name)
      props.onDone({ restoreFocus: restoreFocus.current })
    },
  })
  const stop = () => {
    rename.reset()
    props.onDone({ restoreFocus: restoreFocus.current })
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
          className={cn(
            "max-w-full rounded-sm bg-transparent font-[inherit] text-[length:inherit] leading-[inherit] text-foreground ring-1 ring-teal-500/60",
            focusVisibleClassName,
            props.className,
          )}
        />
      </TextField>
      {rename.error ? (
        <p
          role="alert"
          className={cn(
            "z-20 mt-1 rounded-md bg-zinc-800 px-2 py-1 text-xs font-normal text-red-400 shadow-md",
            props.errorClassName,
          )}
        >
          {rename.error.message}. The name did not change. Rename the
          conversation again.
        </p>
      ) : null}
    </div>
  )
}
