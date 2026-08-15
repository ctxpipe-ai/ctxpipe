import { useState } from "react"
import type { KnowledgeFile, RightTab, SceneKey, VariantKey } from "./mock"
import { seedWorkspaces } from "./mock"
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
  const [rightTab, setRightTab] = useState<RightTab | null>(
    variant === "C" ? null : "files",
  )
  const [selectedFile, setSelectedFile] = useState<KnowledgeFile | null>(null)
  const [openTabs, setOpenTabs] = useState<KnowledgeFile[]>([])
  const [treeCollapsed, setTreeCollapsed] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [selectionToken, setSelectionToken] = useState(
    `${scene}:${first?.id ?? ""}`,
  )
  const nextSelectionToken = `${scene}:${first?.id ?? ""}`
  if (selectionToken !== nextSelectionToken) {
    setSelectionToken(nextSelectionToken)
    setSelectedWorkspaceId(first?.id ?? null)
    setSelectedConversationId(first?.conversations[0]?.id ?? null)
    setExpandedIds(first ? [first.id] : [])
    setSelectedFile(null)
    setOpenTabs([])
    setTreeCollapsed(false)
    setPaletteOpen(false)
    setRightTab(variant === "C" ? null : "files")
  }

  const selected = workspaces.find((w) => w.id === selectedWorkspaceId)
  const conversation = selected?.conversations.find(
    (c) => c.id === selectedConversationId,
  )

  const onSelectWorkspace = (id: string) => {
    setSelectedWorkspaceId(id)
    const workspace = workspaces.find((item) => item.id === id)
    setSelectedConversationId(workspace?.conversations[0]?.id ?? null)
  }
  const onSelectConversation = (
    workspaceId: string,
    conversationId: string,
  ) => {
    setSelectedWorkspaceId(workspaceId)
    setSelectedConversationId(conversationId)
  }
  const onNewConversation = (workspaceId: string) => {
    const id = `conv_${workspaces.flatMap((w) => w.conversations).length + 1}`
    const name = "New conversation"
    setWorkspaces((current) =>
      current.map((workspace) =>
        workspace.id === workspaceId
          ? {
              ...workspace,
              conversations: [
                { id, name, lastBranch: "main" },
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
        conversations: [],
      },
      ...current,
    ])
    setSelectedWorkspaceId(id)
    setSelectedConversationId(null)
  }
  const onSelectFile = (file: KnowledgeFile) => {
    setSelectedFile(file)
    setTreeCollapsed(true)
  }
  const onOpenTab = (file: KnowledgeFile) => {
    setSelectedFile(file)
    setOpenTabs((tabs) =>
      tabs.some((tab) => tab.path === file.path) ? tabs : [...tabs, file],
    )
    setTreeCollapsed(true)
  }

  const common = {
    workspaces,
    selectedWorkspaceId,
    selectedConversationId,
    onSelectWorkspace,
    onSelectConversation,
    onNewConversation,
    onAddWorkspace,
    selectedFile,
    onSelectFile,
  }

  return (
    <div className="relative min-h-screen bg-zinc-950">
      {variant === "A" ? (
        <VariantNestedLastFive
          {...common}
          expandedIds={expandedIds}
          rightTab={rightTab ?? "files"}
          openTabs={openTabs}
          treeCollapsed={treeCollapsed}
          onToggleExpand={(id) =>
            setExpandedIds((ids) =>
              ids.includes(id)
                ? ids.filter((item) => item !== id)
                : [...ids, id],
            )
          }
          onRightTab={(tab) => setRightTab(tab)}
          onOpenTab={onOpenTab}
          onToggleTree={() => setTreeCollapsed((value) => !value)}
        />
      ) : null}
      {variant === "B" ? (
        <VariantWorkQueue
          {...common}
          rightTab={rightTab ?? "files"}
          onRightTab={(tab) => setRightTab(tab)}
        />
      ) : null}
      {variant === "C" ? (
        <VariantSingleWorkspace
          {...common}
          rightTab={rightTab}
          paletteOpen={paletteOpen}
          onRightTab={(tab) => setRightTab(tab)}
          onOpenTab={onOpenTab}
          onTogglePalette={() => setPaletteOpen((value) => !value)}
        />
      ) : null}
      <StateDump
        variant={variant}
        scene={scene}
        workspace={selected?.name ?? null}
        conversation={conversation?.name ?? null}
        branch={conversation?.lastBranch ?? null}
        tab={rightTab}
        file={selectedFile?.path ?? null}
      />
      <PrototypeSwitcher variant={variant} scene={scene} />
    </div>
  )
}
