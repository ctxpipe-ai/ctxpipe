import type { ChatMessage } from "@/features/chat/types"

import type {
  ChangedFile,
  ConversationSync,
  ConversationTurnChanges,
} from "./types"

type ChangedFolder = {
  folder: string
  additions: number
  deletions: number
  files: ChangedFile[]
}

export function groupChangedFilesByFolder(
  files: ChangedFile[],
): ChangedFolder[] {
  const byFolder = new Map<string, ChangedFolder>()
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path))
  for (const file of sorted) {
    const slash = file.path.lastIndexOf("/")
    const folder = slash === -1 ? "" : file.path.slice(0, slash)
    const group = byFolder.get(folder) ?? {
      folder,
      additions: 0,
      deletions: 0,
      files: [],
    }
    group.additions += file.additions
    group.deletions += file.deletions
    group.files.push(file)
    byFolder.set(folder, group)
  }
  return [...byFolder.values()].sort((a, b) => a.folder.localeCompare(b.folder))
}

export function formatLineCount(count: number): string {
  if (count < 1_000) return String(count)
  const thousands = count / 1_000
  return `${thousands < 10 ? thousands.toFixed(1) : Math.round(thousands)}k`
}

/** The run id that persistence puts on each reply message of a run. */
function messageRunId(message: ChatMessage): string | undefined {
  const tanstack = (message.metadata as { tanstack?: unknown } | undefined)
    ?.tanstack as { run?: { id?: unknown }; runId?: unknown } | undefined
  const id = tanstack?.run?.id ?? tanstack?.runId
  return typeof id === "string" && id ? id : undefined
}

/**
 * The last shown message of each run and of each user turn. The keys are the
 * ids the thread shows (it joins replies that follow each other into the
 * first one).
 */
function lastShownMessages(messages: ChatMessage[]) {
  const lastForRun = new Map<string, string>()
  const lastForUserTurn = new Map<number, string>()
  let shownId: string | undefined
  let previousRole: ChatMessage["role"] | undefined
  let userTurn = 0
  for (const message of messages) {
    const joined = message.role === "assistant" && previousRole === "assistant"
    if (!joined) shownId = message.id
    previousRole = message.role
    if (message.role === "user") userTurn += 1
    if (!shownId) continue
    const runId = messageRunId(message)
    if (runId) lastForRun.set(runId, shownId)
    if (userTurn > 0) lastForUserTurn.set(userTurn, shownId)
  }
  return { lastForRun, lastForUserTurn }
}

function placeAfter<T>(
  records: T[],
  placeOf: (record: T) => string | undefined,
): Map<string, T[]> {
  const placed = new Map<string, T[]>()
  for (const record of records) {
    const id = placeOf(record)
    if (!id) continue
    placed.set(id, [...(placed.get(id) ?? []), record])
  }
  return placed
}

/**
 * Places each turn's card after the last shown message of its run. A run
 * with no message that carries its id (a failed turn, or a reply that is
 * still live) goes after the last message of its user turn. Places each Sync
 * after the last shown message of its user turn.
 */
export function placeThreadRecords(
  messages: ChatMessage[],
  records: { turns: ConversationTurnChanges[]; syncs: ConversationSync[] },
): {
  turns: Map<string, ConversationTurnChanges[]>
  syncs: Map<string, ConversationSync[]>
} {
  const { lastForRun, lastForUserTurn } = lastShownMessages(messages)
  return {
    turns: placeAfter(
      records.turns,
      (record) =>
        lastForRun.get(record.runId) ?? lastForUserTurn.get(record.turn),
    ),
    syncs: placeAfter(records.syncs, (sync) => lastForUserTurn.get(sync.turn)),
  }
}
