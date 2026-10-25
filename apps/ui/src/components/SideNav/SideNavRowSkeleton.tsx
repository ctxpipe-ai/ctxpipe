import type { ReactNode } from "react"

import { SkeletonText } from "@/components/ui/Skeleton"
import { cn } from "@/lib/utils"

import { sideNavLabelClassName, sideNavRowClassName } from "./sideNavStyles"

/** One SideNav row (icon gutter and label) while its data loads. */
export function SideNavRowSkeleton(props: {
  navExpanded: boolean
  gutter?: ReactNode
}) {
  return (
    <div className={sideNavRowClassName({ interactive: false })}>
      <span className="flex size-8 shrink-0 items-center justify-center">
        {props.gutter}
      </span>
      <SkeletonText
        className={cn(sideNavLabelClassName(props.navExpanded), "pr-3")}
        boneClassName="w-3/4"
      />
    </div>
  )
}
