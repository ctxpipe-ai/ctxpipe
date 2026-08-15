import { useEffect, useState } from "react"
import type { KnowledgeFile, PaneTab, SceneKey, VariantKey } from "./mock"
import { KNOWLEDGE_FILES, seedWorkspaces } from "./mock"
import { PrototypeSwitcher } from "./PrototypeSwitcher"
import { StateDump } from "./stubs"
import { VariantNestedLastFive } from "./VariantNestedLastFive"
import { VariantSingleWorkspace } from "./VariantSingleWorkspace"
import { VariantWorkQueue } from "./VariantWorkQueue"

export function WorkspaceUiPrototype(props: {
  variant: VariantKey
  scene: SceneKey
}) {
  const { variant, scene } = props
  const [workspaces, setWorkspaces] = useState(() => seedWorkspaces(scene))
  const [sceneToken, setSceneToken] = useState(scene)
  if (sceneToken !== scene) {
    setSceneToken(scene)
    setWorkspaces(seedWorkspaces(scene))
  }

  const first = workspaces[0] ?? null
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(
    first?.id ?? null,
  )
  const [selectedConversationId, setSelectedConversationId] = useState<
    string | null
  >(first?.conversations[0]?.id ?? null)
  const [expandedIds, setExpandedIds] = useState<string[]>(
    first ? [first.id] : [],
  )
  const [visibleCounts, setVisibleCounts] = useState<Record<string, number>>({})
  const [paneTab, setPaneTab] = useState<PaneTab>({ type: "files" })
  const [fileTabs, setFileTabs] = useState<KnowledgeFile[]>([])
  const [selectedFile, setSelectedFile] = useState<KnowledgeFile | null>(null)
  const [treeCollapsed, setTreeCollapsed] = useState(false)
  const [paneOpen, setPaneOpen] = useState(true)
  const [paneMaximized, setPaneMaximized] = useState(false)
  const [paneWidth, setPaneWidth] = useState(380)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [rightTab, setRightTab] = useState<
    "files" | "graph" | "settings" | null
  >(variant === "C" ? null : "files")
  const [selectionToken, setSelectionToken] = useState(
    `${scene}:${first?.id ?? ""}`,
  )
  const nextSelectionToken = `${scene}:${first?.id ?? ""}`
  if (selectionToken !== nextSelectionToken) {
    setSelectionToken(nextSelectionToken)
    setSelectedWorkspaceId(first?.id ?? null)
    setSelectedConversationId(first?.conversations[0]?.id ?? null)
    setExpandedIds(first ? [first.id] : [])
    setVisibleCounts({})
    setSelectedFile(null)
    setFileTabs([])
    setTreeCollapsed(false)
    setPaletteOpen(false)
    setPaneOpen(true)
    setPaneMaximized(false)
    setPaneTab({ type: "files" })
    setRightTab(variant === "C" ? null : "files")
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        setPaletteOpen((open) => !open)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const selected = workspaces.find((item) => item.id === selectedWorkspaceId)
  const conversation = selected?.conversations.find(
    (item) => item.id === selectedConversationId,
  )

  const onToggleWorkspace = (id: string) => {
    setSelectedWorkspaceId(id)
    if (workspaces.length <= 1) return
    setExpandedIds((ids) =>
      ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id],
    )
    const workspace = workspaces.find((item) => item.id === id)
    if (
      !workspace?.conversations.some(
        (item) => item.id === selectedConversationId,
      )
    ) {
      setSelectedConversationId(null)
    }
  }
  const onSelectConversation = (
    workspaceId: string,
    conversationId: string,
  ) => {
    setSelectedWorkspaceId(workspaceId)
    setSelectedConversationId(conversationId)
    setExpandedIds((ids) =>
      ids.includes(workspaceId) ? ids : [...ids, workspaceId],
    )
    setPaneMaximized(false)
  }
  const onNewConversation = (workspaceId: string) => {
    const id = `conv_${workspaces.flatMap((item) => item.conversations).length + 1}`
    setWorkspaces((current) =>
      current.map((workspace) =>
        workspace.id === workspaceId
          ? {
              ...workspace,
              conversations: [
                { id, name: "New conversation", lastBranch: "main" },
                ...workspace.conversations,
              ],
            }
          : workspace,
      ),
    )
    setSelectedWorkspaceId(workspaceId)
    setSelectedConversationId(id)
    setExpandedIds((ids) =>
      ids.includes(workspaceId) ? ids : [...ids, workspaceId],
    )
    setPaneMaximized(false)
  }
  const onAddWorkspace = () => {
    const id = `ws_new_${workspaces.length + 1}`
    setWorkspaces((current) => [
      {
        id,
        name: "New Workspace",
        repo: "acme/new-context",
        readonly: false,
        readonlyReason: null,
        linkedRepos: [],
        conversations: [],
      },
      ...current,
    ])
    setSelectedWorkspaceId(id)
    setSelectedConversationId(null)
    setExpandedIds((ids) => [...ids, id])
  }
  const onLoadMore = (workspaceId: string) => {
    setVisibleCounts((current) => ({
      ...current,
      [workspaceId]: (current[workspaceId] ?? 5) + 5,
    }))
  }
  const onSelectFile = (file: KnowledgeFile) => {
    setSelectedFile(file)
  }
  const onOpenFileTab = (file: KnowledgeFile) => {
    setSelectedFile(file)
    setFileTabs((tabs) =>
      tabs.some((tab) => tab.path === file.path) ? tabs : [...tabs, file],
    )
    setPaneTab({ type: "file", path: file.path })
    setPaneOpen(true)
  }
  const onCloseFileTab = (path: string) => {
    setFileTabs((tabs) => tabs.filter((tab) => tab.path !== path))
    if (paneTab.type === "file" && paneTab.path === path) {
      setPaneTab({ type: "files" })
    }
  }
  const onOpenPane = (tab: PaneTab) => {
    setPaneTab(tab)
    setPaneOpen(true)
    setPaneMaximized(false)
  }

  const common = {
    workspaces,
    selectedWorkspaceId,
    selectedConversationId,
    onSelectConversation,
    onNewConversation,
    onAddWorkspace,
    selectedFile,
    onSelectFile,
  }

  return (
    <div className="relative min-h-screen bg-background">
      {variant === "A" ? (
        <VariantNestedLastFive
          {...common}
          expandedIds={expandedIds}
          visibleCounts={visibleCounts}
          paneTab={paneTab}
          fileTabs={fileTabs}
          treeCollapsed={treeCollapsed}
          paneOpen={paneOpen}
          paneMaximized={paneMaximized}
          paneWidth={paneWidth}
          paletteOpen={paletteOpen}
          onToggleWorkspace={onToggleWorkspace}
          onLoadMore={onLoadMore}
          onPaneTab={(tab) => {
            setPaneTab(tab)
            if (tab.type === "file") {
              setSelectedFile(
                KNOWLEDGE_FILES.find((file) => file.path === tab.path) ?? null,
              )
            }
          }}
          onOpenFileTab={onOpenFileTab}
          onCloseFileTab={onCloseFileTab}
          onToggleTree={() => setTreeCollapsed((value) => !value)}
          onOpenPane={onOpenPane}
          onClosePane={() => {
            setPaneOpen(false)
            setPaneMaximized(false)
          }}
          onToggleMaximize={() => setPaneMaximized((value) => !value)}
          onRestoreConversation={() => setPaneMaximized(false)}
          onResizePane={setPaneWidth}
          onTogglePalette={() => setPaletteOpen((value) => !value)}
        />
      ) : null}
      {variant === "B" ? (
        <VariantWorkQueue
          {...common}
          onSelectWorkspace={onToggleWorkspace}
          rightTab={rightTab ?? "files"}
          onRightTab={(tab) => setRightTab(tab)}
        />
      ) : null}
      {variant === "C" ? (
        <VariantSingleWorkspace
          {...common}
          onSelectWorkspace={onToggleWorkspace}
          rightTab={rightTab}
          paletteOpen={paletteOpen}
          onRightTab={(tab) => setRightTab(tab)}
          onOpenTab={onOpenFileTab}
          onTogglePalette={() => setPaletteOpen((value) => !value)}
        />
      ) : null}
      <StateDump
        variant={variant}
        scene={scene}
        workspace={selected?.name ?? null}
        conversation={conversation?.name ?? null}
        branch={conversation?.lastBranch ?? null}
        tab={paneTab.type === "file" ? paneTab.path : paneTab.type}
        file={selectedFile?.path ?? null}
        pane={paneOpen ? (paneMaximized ? "max" : "open") : "closed"}
        tree={treeCollapsed ? "hidden" : "shown"}
      />
      <PrototypeSwitcher variant={variant} scene={scene} />
    </div>
  )
}
