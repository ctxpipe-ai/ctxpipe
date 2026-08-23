import { FileTree, useFileTree, useFileTreeSearch } from "@pierre/trees/react"
import { IconLayoutSidebarLeftCollapse, IconSearch } from "@tabler/icons-react"
import { ClientOnly } from "@tanstack/react-router"
import { type CSSProperties, useEffect, useMemo, useRef } from "react"
import { Button } from "@/components/ui/Button"
import { Menu, MenuItem, MenuTrigger } from "@/components/ui/Menu"
import { cn } from "@/lib/utils"
import {
  destinationAfterMove,
  isMoveIntoSelf,
  parentDirectory,
} from "./fileTreeMutations"
import type { WorkspaceGitStatusItem } from "./types"

const TREE_HEADER_CLASS = "flex h-8 shrink-0 items-center gap-1 px-1"
const TREE_HEADER_ICON_CLASS =
  "size-6 min-h-6 min-w-6 p-0 leading-none [&_svg]:block"
const ADDITIONS_COLOR = "#34d399"
const DELETIONS_COLOR = "#f87171"

const TREE_UNSAFE_CSS = `
  :host {
    background-color: transparent;
    border-color: transparent;
  }
  [data-file-tree-search-container]:not([data-open="true"]) {
    display: none;
  }
`

const TREE_HOST_STYLE = {
  height: "100%",
  minHeight: 0,
  display: "block",
  background: "transparent",
  "--trees-bg-override": "transparent",
  "--trees-theme-sidebar-bg": "transparent",
  "--trees-theme-input-bg": "var(--color-zinc-900)",
  "--trees-theme-list-active-selection-bg": "var(--color-zinc-800)",
  "--trees-theme-list-hover-bg": "var(--color-zinc-900)",
  "--trees-theme-focus-ring":
    "color-mix(in srgb, var(--color-teal-400) 60%, transparent)",
  "--trees-padding-inline-override": "8px",
} as CSSProperties

export type WorkspaceFileTreeItem = {
  kind: "directory" | "file"
  name: string
  path: string
}

export function workspaceFilePathFromHoverNodes(
  nodes: readonly unknown[],
  files: ReadonlySet<string>,
): string | null {
  for (const node of nodes) {
    if (!node || typeof node !== "object" || !("getAttribute" in node)) continue
    const getAttribute = Reflect.get(node, "getAttribute")
    if (typeof getAttribute !== "function") continue
    const path = getAttribute.call(node, "data-item-path")
    if (typeof path === "string" && files.has(path)) return path
  }
  return null
}

function lineCountDecoration(item: WorkspaceGitStatusItem | undefined) {
  if (!item) return null
  const additions = item.additions ?? 0
  const deletions = item.deletions ?? 0
  if (additions === 0 && deletions === 0) return null
  const parts = [
    ...(additions > 0
      ? [{ text: `+${additions}`, color: ADDITIONS_COLOR }]
      : []),
    ...(deletions > 0
      ? [{ text: `−${deletions}`, color: DELETIONS_COLOR }]
      : []),
  ]
  return {
    text: parts.map((part) => part.text).join(" "),
    title: `${additions} added, ${deletions} deleted`,
    parts,
  }
}

export function WorkspaceFileTree(props: {
  paths: readonly string[]
  selectedPath: string | null
  gitStatus?: readonly WorkspaceGitStatusItem[]
  writable: boolean
  onSelect: (path: string) => void
  onPin?: (path: string) => void
  onRequestCreate?: (kind: "file" | "folder", parentPath: string | null) => void
  onRequestDelete?: (item: WorkspaceFileTreeItem) => void
  onRename?: (from: string, to: string) => void
  onMove?: (from: string, toDirectory: string | null) => void
  onHideTree?: () => void
  onHoverFile?: (path: string) => void
}) {
  return (
    <ClientOnly fallback={<FileTreeSsrFallback {...props} />}>
      <WorkspaceFileTreeClient {...props} />
    </ClientOnly>
  )
}

function FileTreeSsrFallback(props: {
  paths: readonly string[]
  selectedPath: string | null
  onHideTree?: () => void
  onHoverFile?: (path: string) => void
}) {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className={TREE_HEADER_CLASS}>
        <span className="min-w-0 flex-1" />
        {props.onHideTree ? (
          <Button
            variant="quiet"
            size="icon-sm"
            aria-label="Hide tree"
            onPress={props.onHideTree}
            className={TREE_HEADER_ICON_CLASS}
          >
            <IconLayoutSidebarLeftCollapse
              className="size-4"
              stroke={1.6}
              aria-hidden
            />
          </Button>
        ) : null}
      </div>
      <ul
        aria-label="Workspace files"
        className="min-h-0 flex-1 overflow-auto px-1 pb-2 font-mono text-xs leading-6 text-zinc-300"
      >
        {props.paths.map((path) => {
          const name = path.split("/").pop() ?? path
          const selected = props.selectedPath === path
          return (
            <li
              key={path}
              className={cn(
                "truncate rounded-sm px-1",
                selected && "bg-zinc-800 text-zinc-100",
              )}
              onMouseEnter={() => props.onHoverFile?.(path)}
            >
              {name}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function WorkspaceFileTreeClient(props: {
  paths: readonly string[]
  selectedPath: string | null
  gitStatus?: readonly WorkspaceGitStatusItem[]
  writable: boolean
  onSelect: (path: string) => void
  onPin?: (path: string) => void
  onRequestCreate?: (kind: "file" | "folder", parentPath: string | null) => void
  onRequestDelete?: (item: WorkspaceFileTreeItem) => void
  onRename?: (from: string, to: string) => void
  onMove?: (from: string, toDirectory: string | null) => void
  onHideTree?: () => void
  onHoverFile?: (path: string) => void
}) {
  const fileSet = useMemo(() => new Set(props.paths), [props.paths])
  const onSelectRef = useRef(props.onSelect)
  onSelectRef.current = props.onSelect
  const onHoverFileRef = useRef(props.onHoverFile)
  onHoverFileRef.current = props.onHoverFile
  const onPinRef = useRef(props.onPin)
  onPinRef.current = props.onPin
  const fileSetRef = useRef(fileSet)
  fileSetRef.current = fileSet
  const writableRef = useRef(props.writable)
  writableRef.current = props.writable
  const onRenameRef = useRef(props.onRename)
  onRenameRef.current = props.onRename
  const onMoveRef = useRef(props.onMove)
  onMoveRef.current = props.onMove
  const onRequestCreateRef = useRef(props.onRequestCreate)
  onRequestCreateRef.current = props.onRequestCreate
  const onRequestDeleteRef = useRef(props.onRequestDelete)
  onRequestDeleteRef.current = props.onRequestDelete
  const gitStatusByPathRef = useRef(new Map<string, WorkspaceGitStatusItem>())
  gitStatusByPathRef.current = new Map(
    (props.gitStatus ?? []).map((item) => [item.path, item]),
  )
  const pierreGitStatus = useMemo(
    () => (props.gitStatus ?? []).map(({ path, status }) => ({ path, status })),
    [props.gitStatus],
  )

  const { model } = useFileTree({
    paths: props.paths,
    search: true,
    unsafeCSS: TREE_UNSAFE_CSS,
    flattenEmptyDirectories: true,
    density: "compact",
    icons: { set: "standard", colored: false },
    gitStatus: pierreGitStatus,
    initialSelectedPaths: props.selectedPath ? [props.selectedPath] : [],
    renderRowDecoration: ({ item }) => {
      if (item.kind !== "file") return null
      return lineCountDecoration(gitStatusByPathRef.current.get(item.path))
    },
    dragAndDrop: {
      canDrag: () => writableRef.current,
      canDrop: (event) => {
        if (!writableRef.current) return false
        const directory = event.target.directoryPath
        return !event.draggedPaths.some((path) =>
          isMoveIntoSelf(path, directory),
        )
      },
      onDropComplete: (event) => {
        const directory = event.target.directoryPath
        for (const from of event.draggedPaths) {
          const to = destinationAfterMove(from, directory)
          if (!to || to === from) continue
          onMoveRef.current?.(from, directory)
        }
      },
    },
    renaming: {
      canRename: () => writableRef.current,
      onRename: (event) => {
        if (event.sourcePath === event.destinationPath) return
        onRenameRef.current?.(event.sourcePath, event.destinationPath)
      },
    },
    onSelectionChange: (selectedPaths) => {
      const file = [...selectedPaths]
        .reverse()
        .find((path) => fileSetRef.current.has(path))
      if (file) onSelectRef.current(file)
    },
  })

  const search = useFileTreeSearch(model)

  useEffect(() => {
    model.resetPaths(props.paths)
  }, [model, props.paths])

  useEffect(() => {
    model.setGitStatus(pierreGitStatus)
  }, [model, pierreGitStatus])

  useEffect(() => {
    if (!props.selectedPath) return
    if (model.getSelectedPaths().includes(props.selectedPath)) return
    for (const path of model.getSelectedPaths()) {
      model.getItem(path)?.deselect()
    }
    model.getItem(props.selectedPath)?.select()
  }, [model, props.selectedPath])

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className={TREE_HEADER_CLASS}>
        <span className="min-w-0 flex-1" />
        <Button
          variant="quiet"
          size="icon-sm"
          aria-label={search.isOpen ? "Close search" : "Search files"}
          aria-pressed={search.isOpen}
          preventFocusOnPress
          onPress={() => {
            if (search.isOpen) search.close()
            else search.open()
          }}
          className={cn(
            TREE_HEADER_ICON_CLASS,
            search.isOpen && "text-teal-500",
          )}
        >
          <IconSearch className="size-4" stroke={1.6} aria-hidden />
        </Button>
        {props.onHideTree ? (
          <Button
            variant="quiet"
            size="icon-sm"
            aria-label="Hide tree"
            onPress={props.onHideTree}
            className={TREE_HEADER_ICON_CLASS}
          >
            <IconLayoutSidebarLeftCollapse
              className="size-4"
              stroke={1.6}
              aria-hidden
            />
          </Button>
        ) : null}
      </div>
      <FileTree
        model={model}
        className="block h-full min-h-0 min-w-0 flex-1"
        style={TREE_HOST_STYLE}
        aria-label="Workspace files"
        onMouseOver={(event) => {
          const path = workspaceFilePathFromHoverNodes(
            event.nativeEvent.composedPath(),
            fileSetRef.current,
          )
          if (path) onHoverFileRef.current?.(path)
        }}
        onDoubleClick={() => {
          const file = model
            .getSelectedPaths()
            .find((path) => fileSetRef.current.has(path))
          if (file) onPinRef.current?.(file)
        }}
        renderContextMenu={(item, context) => (
          <WorkspaceFileTreeMenu
            item={item}
            writable={props.writable}
            onClose={context.close}
            onCreate={(kind) => {
              context.close()
              const parentPath =
                item.kind === "directory"
                  ? item.path
                  : parentDirectory(item.path)
              onRequestCreateRef.current?.(kind, parentPath)
            }}
            onRename={() => {
              context.close({ restoreFocus: false })
              model.startRenaming(item.path)
            }}
            onDelete={() => {
              context.close()
              onRequestDeleteRef.current?.(item)
            }}
          />
        )}
      />
    </div>
  )
}

function WorkspaceFileTreeMenu(props: {
  item: WorkspaceFileTreeItem
  writable: boolean
  onClose: () => void
  onCreate: (kind: "file" | "folder") => void
  onRename: () => void
  onDelete: () => void
}) {
  const triggerStyle = {
    position: "fixed",
    width: 1,
    height: 1,
    opacity: 0,
    pointerEvents: "none",
  } as CSSProperties

  return (
    <div data-file-tree-context-menu-root="true">
      <MenuTrigger
        isOpen
        onOpenChange={(open) => {
          if (!open) props.onClose()
        }}
        placement="bottom start"
        popoverClassName="rounded-lg border-zinc-800 bg-zinc-900"
      >
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`${props.item.name} actions`}
          className="sr-only"
          style={triggerStyle}
        />
        <Menu
          aria-label={`${props.item.name} actions`}
          disabledKeys={
            props.writable ? [] : ["new-file", "new-folder", "rename", "delete"]
          }
        >
          <MenuItem
            id="new-file"
            textValue="New file"
            onAction={() => props.onCreate("file")}
          >
            New file
          </MenuItem>
          <MenuItem
            id="new-folder"
            textValue="New folder"
            onAction={() => props.onCreate("folder")}
          >
            New folder
          </MenuItem>
          <MenuItem id="rename" textValue="Rename" onAction={props.onRename}>
            Rename
          </MenuItem>
          <MenuItem id="delete" textValue="Delete" onAction={props.onDelete}>
            Delete
          </MenuItem>
        </Menu>
      </MenuTrigger>
    </div>
  )
}
