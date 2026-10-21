import type { ConversationStatus } from "./conversationStatus"

/**
 * The status of one chat in the chat list: a gray dot (idle), a small blue
 * spinner (working), a green dot (finished, unread), or an orange dot (needs
 * attention). The `label` is the words for a screen reader and the tooltip.
 * The spinner stands still with reduced motion, and the label still tells.
 */
export function ConversationStatusDot(props: {
  status: ConversationStatus
  label: string
  id: string
  className?: string
}) {
  const { status, label, id, className } = props
  return (
    <span
      title={label}
      data-status={status}
      className={["flex items-center justify-center", className ?? ""].join(
        " ",
      )}
    >
      {status === "working" ? (
        <span
          aria-hidden
          className="size-3 rounded-full border-2 border-blue-400/30 border-t-blue-400 motion-safe:animate-spin"
        />
      ) : (
        <span
          aria-hidden
          className={[
            "size-2 rounded-full",
            status === "unread"
              ? "bg-green-400"
              : status === "attention"
                ? "bg-orange-400"
                : "bg-zinc-600",
          ].join(" ")}
        />
      )}
      <span id={id} className="sr-only">
        {label}
      </span>
    </span>
  )
}
