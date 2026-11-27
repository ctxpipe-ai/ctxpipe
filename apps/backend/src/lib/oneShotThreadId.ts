import { randomUUID } from "node:crypto"

/**
 * The thread id of a model call that is not part of a conversation, such as a
 * title or a commit subject. TanStack AI 1.x needs a `threadId` on every
 * `chat()`, and each such call is a thread of its own, named for telemetry.
 */
export function oneShotThreadId(name: string): string {
  return `${name}:${randomUUID()}`
}
