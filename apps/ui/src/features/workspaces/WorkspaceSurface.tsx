import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { Component, type ReactNode, Suspense, useEffect, useState } from "react"
import { AppShell } from "@/components/AppShell"
import { cn } from "@/lib/utils"
import { type ParsedPane, parsePane, serializePane, visiblePane } from "./pane"
import {
  workspacePrepareNeedsPoll,
  workspaceProjectionReady,
} from "./projection"
import {
  touchWorkspace,
  workspaceConversationOptions,
  workspaceDetailOptions,
  workspaceKeys,
} from "./queries"
import type { WorkspaceDetail } from "./types"
import { WorkspaceChat } from "./WorkspaceChat"
import { WorkspaceHydrateProgress } from "./WorkspaceHydrateProgress"
import { WorkspacePane, WorkspacePaneTriggers } from "./WorkspacePane"
import { WorkspaceRouteError } from "./WorkspaceRouteError"

export function WorkspaceSurface(props: {
  orgSlug: string
  workspaceSlug: string
  conversationId?: string
  paneParam?: string
}) {
  return (
    <WorkspaceQueryErrorBoundary>
      <Suspense
        fallback={
          <AppShell>
            <p className="p-8 text-sm text-muted-foreground">
              Loading Workspace…
            </p>
          </AppShell>
        }
      >
        <WorkspaceSurfaceReady {...props} />
      </Suspense>
    </WorkspaceQueryErrorBoundary>
  )
}

class WorkspaceQueryErrorBoundary extends Component<
  { children: ReactNode },
  { error: unknown }
> {
  state: { error: unknown } = { error: null }

  static getDerivedStateFromError(error: unknown) {
    return { error }
  }

  render() {
    if (this.state.error) {
      return (
        <WorkspaceRouteError
          error={this.state.error}
          reset={() => this.setState({ error: null })}
        />
      )
    }
    return this.props.children
  }
}

function WorkspaceSurfaceReady(props: {
  orgSlug: string
  workspaceSlug: string
  conversationId?: string
  paneParam?: string
}) {
  const { orgSlug, workspaceSlug, conversationId, paneParam } = props
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { data: workspace } = useSuspenseQuery({
    ...workspaceDetailOptions(orgSlug, workspaceSlug),
    refetchInterval: (query) => {
      const data = query.state.data
      if (!data) return false
      return workspacePrepareNeedsPoll(data) ? 2000 : false
    },
  })

  const pane = parsePane(paneParam)
  const shownPane = visiblePane(pane)
  const [maximized, setMaximized] = useState(false)
  const [paneWidth, setPaneWidth] = useState(380)
  const [treeCollapsed, setTreeCollapsed] = useState(false)
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null)
  const [sessionFileTabs, setSessionFileTabs] = useState<string[]>([])

  const fileFromPane = pane?.kind === "file" ? pane.path : null
  const fileTabs =
    fileFromPane && !sessionFileTabs.includes(fileFromPane)
      ? [...sessionFileTabs, fileFromPane]
      : sessionFileTabs

  useEffect(() => {
    void touchWorkspace(orgSlug, workspaceSlug).then(() => {
      void queryClient.invalidateQueries({
        queryKey: workspaceKeys.list(orgSlug),
      })
    })
  }, [orgSlug, workspaceSlug, queryClient])

  const setPane = (next: ParsedPane | null) => {
    void navigate({
      to: conversationId
        ? "/$orgSlug/ws/$workspaceSlug/$conversationId"
        : "/$orgSlug/ws/$workspaceSlug",
      params: conversationId
        ? { orgSlug, workspaceSlug, conversationId }
        : { orgSlug, workspaceSlug },
      search: next ? { pane: serializePane(next) } : {},
      replace: true,
    })
  }

  if (workspace === null) {
    return (
      <AppShell>
        <main className="mx-auto max-w-lg px-6 py-16">
          <p className="font-mono text-xs uppercase tracking-[0.24em] text-teal-400">
            Workspace
          </p>
          <h1 className="mt-3 text-xl font-medium tracking-tight">
            Workspace not found
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            That slug is not used in this organisation. Changing a slug replaces
            the URL; the old slug is not kept as an alias.
          </p>
        </main>
      </AppShell>
    )
  }

  if (!workspaceProjectionReady(workspace)) {
    return (
      <AppShell>
        <WorkspaceHydrateProgress orgSlug={orgSlug} workspace={workspace} />
      </AppShell>
    )
  }

  if (conversationId) {
    return (
      <WorkspaceSurfaceShell
        orgSlug={orgSlug}
        workspace={workspace}
        conversationId={conversationId}
        shownPane={shownPane}
        maximized={maximized}
        paneWidth={paneWidth}
        treeCollapsed={treeCollapsed}
        selectedFilePath={selectedFilePath}
        fileTabs={fileTabs}
        setMaximized={setMaximized}
        setPaneWidth={setPaneWidth}
        setTreeCollapsed={setTreeCollapsed}
        setSelectedFilePath={setSelectedFilePath}
        setSessionFileTabs={setSessionFileTabs}
        setPane={setPane}
      />
    )
  }

  return (
    <WorkspaceSurfaceLayout
      orgSlug={orgSlug}
      workspace={workspace}
      conversationTitle="New conversation"
      shownPane={shownPane}
      maximized={maximized}
      paneWidth={paneWidth}
      treeCollapsed={treeCollapsed}
      selectedFilePath={selectedFilePath}
      fileTabs={fileTabs}
      setMaximized={setMaximized}
      setPaneWidth={setPaneWidth}
      setTreeCollapsed={setTreeCollapsed}
      setSelectedFilePath={setSelectedFilePath}
      setSessionFileTabs={setSessionFileTabs}
      setPane={setPane}
    />
  )
}

function WorkspaceSurfaceShell(props: {
  orgSlug: string
  workspace: WorkspaceDetail
  conversationId: string
  shownPane: ParsedPane | null
  maximized: boolean
  paneWidth: number
  treeCollapsed: boolean
  selectedFilePath: string | null
  fileTabs: string[]
  setMaximized: React.Dispatch<React.SetStateAction<boolean>>
  setPaneWidth: React.Dispatch<React.SetStateAction<number>>
  setTreeCollapsed: React.Dispatch<React.SetStateAction<boolean>>
  setSelectedFilePath: React.Dispatch<React.SetStateAction<string | null>>
  setSessionFileTabs: React.Dispatch<React.SetStateAction<string[]>>
  setPane: (next: ParsedPane | null) => void
}) {
  const { data } = useSuspenseQuery(
    workspaceConversationOptions(
      props.orgSlug,
      props.conversationId,
      props.workspace.id,
    ),
  )
  const conversationTitle = data?.conversation.name ?? "New conversation"

  return (
    <WorkspaceSurfaceLayout {...props} conversationTitle={conversationTitle} />
  )
}

function WorkspaceSurfaceLayout(props: {
  orgSlug: string
  workspace: WorkspaceDetail
  conversationId?: string
  conversationTitle: string
  shownPane: ParsedPane | null
  maximized: boolean
  paneWidth: number
  treeCollapsed: boolean
  selectedFilePath: string | null
  fileTabs: string[]
  setMaximized: React.Dispatch<React.SetStateAction<boolean>>
  setPaneWidth: React.Dispatch<React.SetStateAction<number>>
  setTreeCollapsed: React.Dispatch<React.SetStateAction<boolean>>
  setSelectedFilePath: React.Dispatch<React.SetStateAction<string | null>>
  setSessionFileTabs: React.Dispatch<React.SetStateAction<string[]>>
  setPane: (next: ParsedPane | null) => void
}) {
  return (
    <AppShell>
      <WorkspaceSurfaceColumns {...props} />
    </AppShell>
  )
}

function WorkspaceSurfaceColumns(props: {
  orgSlug: string
  workspace: WorkspaceDetail
  conversationId?: string
  conversationTitle: string
  shownPane: ParsedPane | null
  maximized: boolean
  paneWidth: number
  treeCollapsed: boolean
  selectedFilePath: string | null
  fileTabs: string[]
  setMaximized: React.Dispatch<React.SetStateAction<boolean>>
  setPaneWidth: React.Dispatch<React.SetStateAction<number>>
  setTreeCollapsed: React.Dispatch<React.SetStateAction<boolean>>
  setSelectedFilePath: React.Dispatch<React.SetStateAction<string | null>>
  setSessionFileTabs: React.Dispatch<React.SetStateAction<string[]>>
  setPane: (next: ParsedPane | null) => void
}) {
  const {
    orgSlug,
    workspace,
    conversationId,
    conversationTitle,
    shownPane,
    maximized,
    paneWidth,
    treeCollapsed,
    selectedFilePath,
    fileTabs,
    setMaximized,
    setPaneWidth,
    setTreeCollapsed,
    setSelectedFilePath,
    setSessionFileTabs,
    setPane,
  } = props

  const paneOpen = Boolean(shownPane)

  return (
    <div className="flex min-h-screen min-w-0" data-workspace-surface="">
      {/*
        Column visibility is CSS:
        - maximised → hide chat
        - pane open below lg → hide chat (single column)
        - otherwise show chat
      */}
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1",
          maximized ? "hidden" : paneOpen ? "max-lg:hidden" : null,
        )}
      >
        <WorkspaceChat
          orgSlug={orgSlug}
          workspace={workspace}
          conversationId={conversationId}
          headerExtra={
            shownPane ? null : (
              <WorkspacePaneTriggers onOpen={(next) => setPane(next)} />
            )
          }
        />
      </div>
      {shownPane ? (
        <WorkspacePane
          orgSlug={orgSlug}
          workspace={workspace}
          pane={shownPane}
          fileTabs={fileTabs}
          selectedFilePath={selectedFilePath}
          treeCollapsed={treeCollapsed}
          maximized={maximized}
          width={paneWidth}
          conversationTitle={conversationTitle}
          onPane={(next) => setPane(next)}
          onClose={() => {
            setMaximized(false)
            setPane(null)
          }}
          onToggleMaximize={() => setMaximized((value) => !value)}
          onRestoreConversation={() => {
            setMaximized(false)
            // Below lg the tools pane owns the viewport — restore means close it.
            if (
              typeof window !== "undefined" &&
              window.matchMedia("(max-width: 1023px)").matches
            ) {
              setPane(null)
            }
          }}
          onResize={setPaneWidth}
          onSelectFile={(path) => {
            setSelectedFilePath(path)
            setPane({ kind: "files" })
          }}
          onOpenFileTab={(path) => {
            setSessionFileTabs((tabs) =>
              tabs.includes(path) ? tabs : [...tabs, path],
            )
            setSelectedFilePath(path)
            setPane({ kind: "file", path })
          }}
          onCloseFileTab={(path) => {
            setSessionFileTabs((tabs) => tabs.filter((item) => item !== path))
            if (shownPane.kind === "file" && shownPane.path === path) {
              setPane({ kind: "files" })
            }
          }}
          onToggleTree={() => setTreeCollapsed((value) => !value)}
        />
      ) : null}
    </div>
  )
}
