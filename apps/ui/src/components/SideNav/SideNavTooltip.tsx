import type { ReactElement } from "react"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/Tooltip"

/** Right-side label tooltip for collapsed SideNav rows. */
export function SideNavTooltip(props: {
  label: string
  enabled: boolean
  children: ReactElement
}) {
  const { label, enabled, children } = props
  if (!enabled) return children

  return (
    <TooltipProvider delay={200}>
      <Tooltip>
        {/* Compose onto the row control — do not wrap in an extra <button>
            (that was squashing collapsed icon hit targets). */}
        <TooltipTrigger render={children} nativeButton={false} />
        <TooltipContent
          side="right"
          sideOffset={6}
          // No border — bordered popups clash with the rotated arrow seam.
          className="border-0 bg-zinc-800 text-zinc-100 shadow-md"
          arrowClassName="bg-zinc-800 fill-zinc-800"
        >
          {label}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
