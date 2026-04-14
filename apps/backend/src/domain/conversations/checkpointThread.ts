/**
 * LangGraph checkpoints are keyed by `thread_id`. The UI uses opaque conversation
 * ids; without a user prefix, two org members sharing the same id would load the
 * same checkpoint state. Namespace by user so checkpoint data is always per-user.
 */
export function conversationCheckpointThreadId(input: {
  userId: string
  conversationId: string
}): string {
  return `${input.userId}:${input.conversationId}`
}
