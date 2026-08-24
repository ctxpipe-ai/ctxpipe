import { IconPlus } from "@tabler/icons-react"
import { SideNavTooltip } from "@/components/SideNav/SideNavTooltip"
import {
  sideNavIconGutterClassName,
  sideNavRowClassName,
} from "@/components/SideNav/sideNavStyles"
import { Button } from "@/components/ui/Button"
import { focusVisibleClassName } from "@/lib/focus-styles"
import { cn } from "@/lib/utils"

export function WorkspaceNavHeading(props: {
  expanded: boolean
  onAddWorkspace: () => void
}) {
  const { expanded, onAddWorkspace } = props

  if (!expanded) {
    return (
      <SideNavTooltip label="Add Workspace" enabled>
        <button
          type="button"
          aria-label="Add Workspace"
          onClick={onAddWorkspace}
          className={sideNavRowClassName({ active: false })}
        >
          <span className={sideNavIconGutterClassName}>
            <IconPlus stroke={1.4} aria-hidden />
          </span>
        </button>
      </SideNavTooltip>
    )
  }

  return (
    <div className="group/wsh mx-1.5 mt-2.5 mb-0.5 flex h-8 w-[calc(100%-0.75rem)] items-center">
      <p className="min-w-0 flex-1 truncate px-2 text-[10px] font-normal uppercase tracking-tighter text-muted-foreground">
        Workspaces
      </p>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Add Workspace"
        onPress={onAddWorkspace}
        className={cn(
          "h-6 w-6 min-w-6 text-zinc-500 opacity-0 transition-opacity",
          "group-hover/wsh:opacity-100 group-focus-within/wsh:opacity-100",
          focusVisibleClassName,
        )}
      >
        <IconPlus className="size-4" stroke={1.4} aria-hidden />
      </Button>
    </div>
  )
}
