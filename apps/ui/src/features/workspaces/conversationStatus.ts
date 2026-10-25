import type { ConversationLastTurn } from "@/features/chat/types"

export type ConversationStatus = "idle" | "working" | "unread" | "attention"

// The backend stops a turn after 2 hours (`maxTurnMs` in
// conversation-websocket-stream.ts). A "running" row older than that is lost.
const maxTurnMs = 2 * 60 * 60_000

/** True when the newest turn runs and is younger than the backend turn limit. */
export function isLiveRun(
  lastTurn: ConversationLastTurn | null | undefined,
  now: number = Date.now(),
): boolean {
  return lastTurn?.status === "running" && now - lastTurn.at <= maxTurnMs
}

/**
 * The status dot of a chat in the chat list. The newest turn decides it, so
 * a retry, an answer, or a new turn clears "attention" with no extra state.
 * Only a finished turn can be unread: it is unread when it ended after the
 * last time the user saw the chat. A chat that this browser never saw is read.
 * A "running" turn past the backend turn limit is lost, so it needs attention.
 */
export function conversationStatus(
  lastTurn: ConversationLastTurn | null | undefined,
  seenAt: number | undefined,
  now: number = Date.now(),
): ConversationStatus {
  if (!lastTurn) return "idle"
  switch (lastTurn.status) {
    case "running":
      return isLiveRun(lastTurn, now) ? "working" : "attention"
    case "interrupted":
    case "failed":
    case "aborted":
      return "attention"
    case "completed":
      return seenAt !== undefined && lastTurn.at > seenAt ? "unread" : "idle"
  }
}

/** The words for a status, for the accessible description and the tooltip. */
export function conversationStatusLabel(
  status: ConversationStatus,
  lastTurn: ConversationLastTurn | null | undefined,
): string {
  switch (status) {
    case "working":
      return "Working"
    case "unread":
      return "Finished. You have not opened it yet."
    case "attention":
      return lastTurn?.status === "interrupted"
        ? "Needs attention. The agent waits for you."
        : lastTurn?.status === "failed"
          ? "Needs attention. The turn failed."
          : "Needs attention. The turn stopped before it finished."
    case "idle":
      return "Idle"
  }
}
