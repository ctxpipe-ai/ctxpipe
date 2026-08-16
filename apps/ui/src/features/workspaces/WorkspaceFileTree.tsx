import type { WorkspaceFileTreeNode } from "./types"

export function WorkspaceFileTree(props: {
  nodes: WorkspaceFileTreeNode[]
  selectedPath: string | null
  onSelect: (path: string) => void
  onOpenTab: (path: string) => void
}) {
  return (
    <ul className="space-y-0.5">
      {props.nodes.map((node) => (
        <FileTreeItem
          key={node.path}
          node={node}
          depth={0}
          selectedPath={props.selectedPath}
          onSelect={props.onSelect}
          onOpenTab={props.onOpenTab}
        />
      ))}
    </ul>
  )
}

function FileTreeItem(props: {
  node: WorkspaceFileTreeNode
  depth: number
  selectedPath: string | null
  onSelect: (path: string) => void
  onOpenTab: (path: string) => void
}) {
  const isFile = !props.node.children
  const selected = props.selectedPath === props.node.path
  return (
    <li>
      {isFile ? (
        <button
          type="button"
          className={[
            "block w-full truncate rounded-lg px-2 py-1 text-left font-mono text-xs",
            selected
              ? "bg-zinc-800 text-foreground"
              : "text-muted-foreground hover:bg-zinc-900 hover:text-foreground",
          ].join(" ")}
          style={{ paddingLeft: `${0.5 + props.depth * 0.75}rem` }}
          onClick={() => props.onSelect(props.node.path)}
          onDoubleClick={() => props.onOpenTab(props.node.path)}
        >
          {props.node.name}
        </button>
      ) : (
        <div>
          <p
            className="truncate px-2 py-1 font-mono text-xs text-muted-foreground"
            style={{ paddingLeft: `${0.5 + props.depth * 0.75}rem` }}
          >
            {props.node.name}
          </p>
          <ul className="space-y-0.5">
            {props.node.children?.map((child) => (
              <FileTreeItem
                key={child.path}
                node={child}
                depth={props.depth + 1}
                selectedPath={props.selectedPath}
                onSelect={props.onSelect}
                onOpenTab={props.onOpenTab}
              />
            ))}
          </ul>
        </div>
      )}
    </li>
  )
}
