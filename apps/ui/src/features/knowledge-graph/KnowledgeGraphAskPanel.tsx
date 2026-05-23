import { useChat } from "@ai-sdk/react"
import {
  IconFocusCentered,
  IconMessageCircle,
  IconX,
} from "@tabler/icons-react"
import type { UIMessage } from "ai"
import { useEffect, useMemo, useRef, useState } from "react"
import { ConversationThread } from "@/features/chat/ConversationThread"
import { createTransport } from "@/features/chat/chatTransport"
import { MessageInputBox } from "@/features/chat/MessageInputBox"
import { createObjectId } from "@/lib/id"
import { cn } from "@/lib/utils"
import { PanelLabel } from "./FloatingPanel"
import type { KnowledgeGraphNode } from "./types"

type KnowledgeGraphFocusPayload = {
  nodeIds?: unknown
  reason?: unknown
  fitView?: unknown
}

type NodeSearchEntry = {
  id: string
  haystack: string
  name: string
}

type NodeSearchIndex = {
  entriesById: Map<string, NodeSearchEntry>
  tokenToIds: Map<string, string[]>
}

const LOCAL_FOCUS_LIMIT = 24
/** Debounce local graph focus derived from streamed text (avoids heavy re-renders each token). */
const STREAM_FOCUS_DEBOUNCE_MS = 1200
const STOP_WORDS = new Set([
  "about",
  "again",
  "also",
  "and",
  "are",
  "backend",
  "does",
  "during",
  "explain",
  "for",
  "from",
  "graph",
  "have",
  "how",
  "into",
  "key",
  "learn",
  "more",
  "node",
  "nodes",
  "should",
  "show",
  "system",
  "that",
  "the",
  "this",
  "use",
  "what",
  "when",
  "where",
  "which",
  "with",
])

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_./:-]+/g, " ")
    .trim()
}

function tokensFromText(value: string): string[] {
  const normalized = normalizeText(value)
  if (!normalized) return []
  return [
    ...new Set(
      normalized
        .split(/\s+/)
        .filter((token) => token.length >= 2 && !STOP_WORDS.has(token)),
    ),
  ]
}

function latestAssistantTextAfterLastUser(messages: UIMessage[]): string {
  const latestUserIndex = messages.findLastIndex(
    (message) => message.role === "user",
  )
  if (latestUserIndex < 0) return ""
  for (let i = messages.length - 1; i > latestUserIndex; i--) {
    const message = messages[i]
    if (message?.role !== "assistant") continue
    return message.parts
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n")
  }
  return ""
}

function buildNodeSearchIndex(nodes: KnowledgeGraphNode[]): NodeSearchIndex {
  const entriesById = new Map<string, NodeSearchEntry>()
  const tokenToIds = new Map<string, string[]>()
  for (const node of nodes) {
    const entry = {
      id: node.id,
      name: normalizeText(node.name ?? ""),
      haystack: normalizeText(
        [node.id, node.kind, node.name ?? "", node.summary ?? ""].join(" "),
      ),
    }
    entriesById.set(entry.id, entry)

    const nodeTokens = new Set<string>()
    for (const token of tokensFromText(entry.haystack)) {
      nodeTokens.add(token)
      const maxPrefixLength = Math.min(token.length, 12)
      for (let length = 3; length <= maxPrefixLength; length++) {
        nodeTokens.add(token.slice(0, length))
      }
    }
    for (const token of nodeTokens) {
      const ids = tokenToIds.get(token)
      if (ids) ids.push(entry.id)
      else tokenToIds.set(token, [entry.id])
    }
  }
  return { entriesById, tokenToIds }
}

function matchKnowledgeGraphNodes(
  index: NodeSearchIndex,
  text: string,
): string[] {
  const query = normalizeText(text)
  const tokens = tokensFromText(text)
  if (!query || tokens.length === 0) return []

  const candidateIds = new Set<string>()
  for (const token of tokens) {
    const lookup = token.length > 12 ? token.slice(0, 12) : token
    const ids = index.tokenToIds.get(lookup)
    if (!ids) continue
    for (const id of ids) candidateIds.add(id)
  }
  if (candidateIds.size === 0) return []

  const scored: Array<{ id: string; score: number }> = []
  for (const id of candidateIds) {
    const node = index.entriesById.get(id)
    if (!node) continue
    let score = 0
    if (node.haystack.includes(query)) score += 8
    if (node.name && query.includes(node.name)) score += 10
    for (const token of tokens) {
      if (node.haystack.includes(token)) score += token.length >= 4 ? 2 : 1
    }
    if (score > 0) scored.push({ id: node.id, score })
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, LOCAL_FOCUS_LIMIT)
    .map((item) => item.id)
}

function parseFocusPayload(data: unknown): {
  nodeIds: string[]
  reason: string | null
  fitView: boolean
} | null {
  if (!data || typeof data !== "object") return null
  const payload = data as KnowledgeGraphFocusPayload
  if (!Array.isArray(payload.nodeIds)) return null
  const nodeIds = payload.nodeIds.filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  )
  if (nodeIds.length === 0) return null
  return {
    nodeIds,
    reason: typeof payload.reason === "string" ? payload.reason : null,
    fitView: payload.fitView !== false,
  }
}

function displayNodeName(node: KnowledgeGraphNode): string {
  return node.name?.trim() || node.id
}

function topNodeKinds(nodes: KnowledgeGraphNode[]): string[] {
  const counts = new Map<string, number>()
  for (const node of nodes) {
    const kind = node.kind || "Unknown"
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([kind]) => kind)
}

function buildSuggestedQuestions({
  nodes,
  search,
  selectedNode,
}: {
  nodes: KnowledgeGraphNode[]
  search: string
  selectedNode: KnowledgeGraphNode | null
}): string[] {
  const suggestions: string[] = []
  const add = (question: string) => {
    if (!suggestions.includes(question)) suggestions.push(question)
  }

  if (selectedNode) {
    add(
      `Explain ${displayNodeName(selectedNode)} and the most important nodes connected to it.`,
    )
  }

  const trimmedSearch = search.trim()
  if (trimmedSearch) {
    add(`Summarize the ${trimmedSearch} area and highlight the key nodes.`)
  }

  const kinds = topNodeKinds(nodes)
  if (kinds[0]) {
    add(`Which ${kinds[0]} nodes should I inspect first, and why?`)
  }
  if (kinds[0] && kinds[1]) {
    add(`How do ${kinds[0]} and ${kinds[1]} relate in this graph?`)
  }

  add("Give me a high-level map of the main areas in this knowledge graph.")
  add("What dependencies or relationships look most important here?")
  add("What should I inspect first if I want to understand this repo quickly?")

  return suggestions.slice(0, 3)
}

export function KnowledgeGraphAskButton(props: {
  active: boolean
  className?: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      aria-pressed={props.active}
      className={cn(
        "inline-flex h-10 items-center gap-2 border border-zinc-800/95 bg-zinc-950/85 px-3 text-[12px] font-medium text-zinc-400 shadow-xl shadow-black/30 backdrop-blur transition-colors hover:border-zinc-700 hover:bg-zinc-900/90 hover:text-teal-300",
        props.active && "border-teal-500/45 bg-teal-500/10 text-teal-200",
        props.className,
      )}
    >
      <IconMessageCircle className="h-3.5 w-3.5" aria-hidden />
      Ask
    </button>
  )
}

export function KnowledgeGraphAskPanel(props: {
  orgSlug: string
  open: boolean
  onOpenChange: (open: boolean) => void
  selectedNode: KnowledgeGraphNode | null
  nodes: KnowledgeGraphNode[]
  highlightedNodeCount: number
  search: string
  seed: string | null
  onSeedConsumed: () => void
  onFocus: (input: { nodeIds: string[]; fitView: boolean }) => void
  onFitFocus: () => void
  onClearFocus: () => void
}) {
  const [draftSeed, setDraftSeed] = useState<string | null>(null)
  const [conversationId] = useState(() => createObjectId("conv"))
  const contextRef = useRef<string | null>(null)
  const lastAutoFocusKeyRef = useRef("")
  const streamFocusTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  )
  const { nodes, onFocus, onSeedConsumed, seed } = props
  const suggestedQuestions = useMemo(() => {
    if (!props.open) return []
    return buildSuggestedQuestions({
      nodes,
      search: props.search,
      selectedNode: props.selectedNode,
    })
  }, [nodes, props.open, props.search, props.selectedNode])

  const transport = useMemo(
    () =>
      createTransport({
        orgSlug: props.orgSlug,
        conversationId,
        source: "knowledge-graph",
        getMessageContext: () => contextRef.current,
      }),
    [props.orgSlug, conversationId],
  )

  const { messages, sendMessage, status, stop, error } = useChat({
    id: conversationId,
    transport,
    onData: ({ type, data }) => {
      if (type !== "data-kg-focus") return
      const focus = parseFocusPayload(data)
      if (!focus) return
      lastAutoFocusKeyRef.current = focus.nodeIds.join("\0")
      onFocus({ nodeIds: focus.nodeIds, fitView: focus.fitView })
    },
  })

  const isStreaming = status === "submitted" || status === "streaming"
  const nodeSearchIndex = useMemo(
    () => (props.open || isStreaming ? buildNodeSearchIndex(nodes) : null),
    [isStreaming, nodes, props.open],
  )

  useEffect(() => {
    if (!seed) return
    setDraftSeed(seed)
    onSeedConsumed()
  }, [seed, onSeedConsumed])

  const promptContext = () => {
    const lines: string[] = []
    if (props.selectedNode) {
      lines.push(
        `Selected node: ${props.selectedNode.name ?? props.selectedNode.id} (${props.selectedNode.kind}, id=${props.selectedNode.id}).`,
      )
    }
    if (props.search.trim()) {
      lines.push(`Current graph search: ${props.search.trim()}.`)
    }
    return lines.join("\n") || null
  }

  const handleSendMessage = ({ text }: { text: string }) => {
    contextRef.current = promptContext()
    lastAutoFocusKeyRef.current = ""
    if (streamFocusTimeoutRef.current) {
      clearTimeout(streamFocusTimeoutRef.current)
      streamFocusTimeoutRef.current = null
    }
    props.onClearFocus()
    void sendMessage({ text })
  }

  useEffect(() => {
    if (!isStreaming || !nodeSearchIndex) return

    if (streamFocusTimeoutRef.current) {
      clearTimeout(streamFocusTimeoutRef.current)
    }

    streamFocusTimeoutRef.current = setTimeout(() => {
      streamFocusTimeoutRef.current = null
      const streamedText = latestAssistantTextAfterLastUser(messages)
      const localFocusIds = matchKnowledgeGraphNodes(
        nodeSearchIndex,
        streamedText,
      )
      const key = localFocusIds.join("\0")
      if (localFocusIds.length === 0 || key === lastAutoFocusKeyRef.current)
        return

      lastAutoFocusKeyRef.current = key
      onFocus({ nodeIds: localFocusIds, fitView: true })
    }, STREAM_FOCUS_DEBOUNCE_MS)

    return () => {
      if (streamFocusTimeoutRef.current) {
        clearTimeout(streamFocusTimeoutRef.current)
        streamFocusTimeoutRef.current = null
      }
    }
  }, [isStreaming, messages, nodeSearchIndex, onFocus])

  if (!props.open) return null

  return (
    <aside className="pointer-events-auto absolute right-0 top-0 z-20 flex h-[100dvh] w-[560px] max-w-[94vw] flex-col border-l border-zinc-800/95 bg-zinc-950/95 shadow-2xl shadow-black/50 backdrop-blur-md">
      <div className="flex shrink-0 items-start justify-between gap-3 border-b border-zinc-800/95 p-4">
        <div>
          <PanelLabel className="mb-1 flex items-center gap-1.5">
            Ask the graph
          </PanelLabel>
          <p className="text-[12px] leading-snug text-zinc-500">
            Explore your knowledge graph by asking questions.
          </p>
        </div>
        <button
          type="button"
          onClick={() => props.onOpenChange(false)}
          aria-label="Close graph chat"
          className="flex h-8 w-8 shrink-0 items-center justify-center border border-zinc-800/95 bg-zinc-950/90 text-zinc-500 transition-colors hover:border-zinc-700 hover:bg-zinc-900 hover:text-zinc-100"
        >
          <IconX className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <ConversationThread
          messages={messages}
          error={error ?? null}
          status={status}
          contentClassName="max-w-none px-6 py-5 [&_.ctx-streamdown_ol]:pl-6 [&_.ctx-streamdown_ul]:pl-6 [&_.ctx-streamdown_li]:pl-1"
        />

        {messages.length === 0 ? (
          <div className="shrink-0 space-y-2 border-t border-zinc-800/80 px-4 py-3 text-[13px] text-zinc-500">
            <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-zinc-600">
              Try asking
            </p>
            {suggestedQuestions.map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => handleSendMessage({ text: example })}
                disabled={isStreaming}
                className="block w-full border border-zinc-800/80 px-2.5 py-2 text-left text-zinc-400 transition-colors hover:border-zinc-700 hover:bg-white/5 hover:text-zinc-100"
              >
                {example}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {props.highlightedNodeCount > 0 ? (
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-zinc-800/80 px-4 py-2 text-[12px] text-zinc-500">
          <span>
            <span className="font-mono uppercase tracking-[0.16em] text-teal-400">
              Focus
            </span>{" "}
            {props.highlightedNodeCount.toLocaleString()} node
            {props.highlightedNodeCount === 1 ? "" : "s"} highlighted
          </span>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={props.onFitFocus}
              className="inline-flex items-center gap-1.5 text-zinc-400 transition-colors hover:text-teal-200"
            >
              <IconFocusCentered className="h-3 w-3" aria-hidden />
              Fit
            </button>
            <button
              type="button"
              onClick={props.onClearFocus}
              className="text-zinc-500 transition-colors hover:text-zinc-200"
            >
              Clear
            </button>
          </div>
        </div>
      ) : null}

      <MessageInputBox
        layout="thread"
        sendMessage={handleSendMessage}
        status={status}
        onStop={stop}
        isDisabled={isStreaming}
        placeholder="Ask about this graph…"
        draftSeed={draftSeed}
        onDraftSeedConsumed={() => setDraftSeed(null)}
        contentClassName="max-w-none"
      />
    </aside>
  )
}
