import {
  type ComponentProps,
  type ReactNode,
  type RefObject,
  Suspense,
  use,
  useEffect,
  useRef,
  useState,
} from "react"
import { cn } from "@/lib/utils"

/**
 * Loading-state rule for every skeleton (DESIGN.md "Loading states"):
 * a bone keeps its box but stays invisible for `SKELETON_DELAY_MS`, so a fast
 * load shows no skeleton. A skeleton that becomes visible stays for at least
 * `SKELETON_MIN_MS`, so it does not flash.
 */
export const SKELETON_DELAY_MS = 1000
export const SKELETON_MIN_MS = 300

const boneClassName =
  "ctx-loading-motion relative inline-block overflow-hidden rounded-md bg-zinc-800/50 before:absolute before:inset-0 before:-translate-x-full before:animate-[shimmer_1.5s_ease-in-out_infinite] before:bg-linear-to-r before:from-transparent before:via-white/5 before:to-transparent"

function useDelayElapsed() {
  const [elapsed, setElapsed] = useState(false)
  useEffect(() => {
    const id = setTimeout(() => setElapsed(true), SKELETON_DELAY_MS)
    return () => clearTimeout(id)
  }, [])
  return elapsed
}

export function Skeleton({ className, ...props }: ComponentProps<"span">) {
  const visible = useDelayElapsed()
  return (
    <span
      role="presentation"
      data-skeleton={visible ? "visible" : "waiting"}
      className={cn(boneClassName, !visible && "invisible", className)}
      {...props}
    />
  )
}

/**
 * Wait text inside a skeleton (for example "Loading your files"). It follows
 * the same delay as the bones, so a fast load shows nothing.
 */
export function SkeletonReveal(props: {
  className?: string
  children: ReactNode
}) {
  const visible = useDelayElapsed()
  return (
    <div className={cn(!visible && "invisible", props.className)}>
      {props.children}
    </div>
  )
}

/**
 * Keep a query-driven skeleton up for `SKELETON_MIN_MS` after it became
 * visible. Use it as `useSkeletonHold(query.isPending) ? <Skeleton… /> : …`.
 */
export function useSkeletonHold(pending: boolean) {
  const [shownAt, setShownAt] = useState<number | null>(null)
  useEffect(() => {
    if (pending) {
      if (shownAt !== null) return
      const id = setTimeout(() => setShownAt(Date.now()), SKELETON_DELAY_MS)
      return () => clearTimeout(id)
    }
    if (shownAt === null) return
    const id = setTimeout(
      () => setShownAt(null),
      Math.max(0, shownAt + SKELETON_MIN_MS - Date.now()),
    )
    return () => clearTimeout(id)
  }, [pending, shownAt])
  return pending || shownAt !== null
}

/**
 * `Suspense` with a skeleton fallback that follows the loading-state rule:
 * when the fallback became visible, the content waits until the fallback has
 * shown for `SKELETON_MIN_MS`.
 */
export function SkeletonSuspense(props: {
  fallback: ReactNode
  children: ReactNode
}) {
  const hold = useRef<Promise<void> | null>(null)
  return (
    <Suspense
      fallback={
        <SkeletonFallback hold={hold}>{props.fallback}</SkeletonFallback>
      }
    >
      <SkeletonGate hold={hold}>{props.children}</SkeletonGate>
    </Suspense>
  )
}

function SkeletonFallback(props: {
  hold: RefObject<Promise<void> | null>
  children: ReactNode
}) {
  const { hold } = props
  useEffect(() => {
    const id = setTimeout(() => {
      hold.current = new Promise((resolve) =>
        setTimeout(resolve, SKELETON_MIN_MS),
      )
    }, SKELETON_DELAY_MS)
    return () => clearTimeout(id)
  }, [hold])
  return props.children
}

function SkeletonGate(props: {
  hold: RefObject<Promise<void> | null>
  children: ReactNode
}) {
  if (props.hold.current) use(props.hold.current)
  return props.children
}

/**
 * A bone inside one text line box, so the row has the height of the text it
 * stands in for. Put the text size (for example `text-sm`) in `className` and
 * the bone width in `boneClassName`.
 */
export function SkeletonText(props: {
  className?: string
  boneClassName?: string
}) {
  return (
    <span className={cn("flex h-lh items-center", props.className)}>
      <Skeleton className={cn("h-3 w-2/3", props.boneClassName)} />
    </span>
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
