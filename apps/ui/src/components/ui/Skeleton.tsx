import type { ComponentProps } from "react"
import { cn } from "@/lib/utils"

const boneClassName =
  "relative inline-block overflow-hidden rounded-md bg-zinc-800 before:absolute before:inset-0 before:-translate-x-full before:animate-[shimmer_1.5s_ease-in-out_infinite] before:bg-linear-to-r before:from-transparent before:via-white/10 before:to-transparent"

export function Skeleton({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      role="presentation"
      className={cn(boneClassName, className)}
      {...props}
    />
  )
}

export function SkeletonLine({ className, ...props }: ComponentProps<"span">) {
  return <Skeleton className={cn("h-3 w-2/3", className)} {...props} />
}

export function SkeletonRow(props: {
  lines?: 1 | 2
  size?: "nav" | "catalog"
  className?: string
}) {
  const { lines = 1, size = "nav", className } = props
  if (size === "catalog") {
    return (
      <div className={cn("flex items-center gap-3 px-1 py-3", className)}>
        <Skeleton className="size-9 shrink-0" />
        <div className="min-w-0 flex-1 space-y-2">
          <SkeletonLine className="h-4 w-40" />
          {lines === 2 ? <SkeletonLine className="h-3 w-24" /> : null}
        </div>
      </div>
    )
  }
  return (
    <div className={cn("flex h-8 items-center gap-2 px-2", className)}>
      <Skeleton className="size-4 shrink-0" />
      <div className="min-w-0 flex-1 space-y-1">
        <SkeletonLine className="h-3 w-3/4" />
        {lines === 2 ? <SkeletonLine className="h-2.5 w-1/2" /> : null}
      </div>
    </div>
  )
}

export function PageBodySkeleton(props: { label: string; className?: string }) {
  return (
    <div className={cn("w-full max-w-2xl", props.className)} aria-busy>
      <span className="sr-only">{props.label}</span>
      <SkeletonLine className="h-3 w-24" />
      <SkeletonLine className="mt-4 h-7 w-52" />
      <SkeletonLine className="mt-3 h-4 w-full max-w-md" />
      <div className="mt-10">
        <SkeletonRow size="catalog" />
        <SkeletonRow size="catalog" />
        <SkeletonRow size="catalog" />
      </div>
    </div>
  )
}

/** @deprecated Use `Skeleton`. */
export const ShimmerPlaceholder = Skeleton
