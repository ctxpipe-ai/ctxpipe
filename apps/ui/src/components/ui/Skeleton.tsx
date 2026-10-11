import {
  type ComponentProps,
  type CSSProperties,
  createContext,
  type ReactNode,
  Suspense,
  use,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
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

/**
 * The hold timers start this much before the CSS wait ends, so timer jitter
 * cannot let a visible skeleton go without its hold.
 */
const HOLD_LEAD_MS = 50

/** A skeleton that mounts this soon after the last one left continues it. */
const HAND_OVER_MS = 100

const boneClassName =
  "ctx-loading-motion ctx-skeleton-wait relative inline-block overflow-hidden rounded-md bg-zinc-800/50 before:absolute before:inset-0 before:-translate-x-full before:animate-[shimmer_1.5s_ease-in-out_infinite] before:bg-linear-to-r before:from-transparent before:via-white/5 before:to-transparent"

/** Skeletons of one thing, where one skeleton hands over to the next. */
type Chain = { mounted: number; lastSeen: number; visibleAt: number }

const SkeletonRegionContext = createContext<Map<string, Chain> | null>(null)
const SkeletonChainContext = createContext<Chain | null>(null)

function chainIn(region: Map<string, Chain> | null, id: string | undefined) {
  if (!region || id === undefined) return null
  let chain = region.get(id)
  if (!chain) {
    chain = { mounted: 0, lastSeen: Number.NEGATIVE_INFINITY, visibleAt: 0 }
    region.set(id, chain)
  }
  return chain
}

/**
 * Holds the hand-over chains of one area. Put it above both the first
 * skeleton and the skeleton that follows it.
 */
export function SkeletonRegion(props: { children: ReactNode }) {
  const [region] = useState(() => new Map<string, Chain>())
  return (
    <SkeletonRegionContext.Provider value={region}>
      {props.children}
    </SkeletonRegionContext.Provider>
  )
}

/**
 * Marks a skeleton as one step of the chain `id`. A skeleton that follows
 * another skeleton of the same chain (in the same commit, or within
 * `HAND_OVER_MS`) shows when the first one shows, so a hand-over does not
 * start the delay again. Skeletons of other chains keep their own delay.
 */
export function SkeletonChain(props: { id: string; children: ReactNode }) {
  const chain = chainIn(useContext(SkeletonRegionContext), props.id)
  return (
    <SkeletonChainContext.Provider value={chain}>
      {props.children}
    </SkeletonChainContext.Provider>
  )
}

/** The time left (ms) on this element's CSS wait, or null if unknown. */
function cssWaitLeft(element: Element) {
  if (typeof element.getAnimations !== "function") return null
  const wait = element
    .getAnimations()
    .find(
      (animation) =>
        animation instanceof CSSAnimation &&
        animation.animationName === "ctx-skeleton-wait",
    )
  if (!wait) return 0
  const end = Number(wait.effect?.getComputedTiming().endTime ?? 0)
  return Math.max(0, end - Number(wait.currentTime ?? 0))
}

/**
 * The wait (ms) before this skeleton shows, and a ref for its element. CSS
 * runs the wait. Outside a chain, or for a new load, it is the full delay.
 * The chain takes its show time from the real CSS animation, which starts at
 * first paint (also for server HTML), not at hydration.
 */
function useSkeletonWait<T extends Element>() {
  const chain = useContext(SkeletonChainContext)
  const element = useRef<T>(null)
  const [wait] = useState(() => {
    if (!chain || typeof window === "undefined") return SKELETON_DELAY_MS
    const now = performance.now()
    const continues = chain.mounted > 0 || now - chain.lastSeen < HAND_OVER_MS
    chain.lastSeen = now
    if (!continues) {
      chain.visibleAt = now + SKELETON_DELAY_MS
      return SKELETON_DELAY_MS
    }
    const left = chain.visibleAt - now
    // A small difference keeps the server markup during hydration.
    return left > SKELETON_DELAY_MS - 50
      ? SKELETON_DELAY_MS
      : Math.max(0, Math.round(left))
  })
  useLayoutEffect(() => {
    if (!chain) return
    chain.mounted += 1
    const left = element.current ? cssWaitLeft(element.current) : null
    if (left !== null) {
      chain.visibleAt = Math.min(chain.visibleAt, performance.now() + left)
    }
    return () => {
      chain.mounted -= 1
      chain.lastSeen = performance.now()
    }
  }, [chain])
  return { wait, element }
}

function waitStyle(wait: number, style?: CSSProperties) {
  if (wait === SKELETON_DELAY_MS) return style
  return { ...style, "--skeleton-wait": `${wait}ms` } as CSSProperties
}

export function Skeleton({
  className,
  style,
  ...props
}: ComponentProps<"span">) {
  const { wait, element } = useSkeletonWait<HTMLSpanElement>()
  return (
    <span
      role="presentation"
      data-skeleton=""
      className={cn(boneClassName, className)}
      style={waitStyle(wait, style)}
      {...props}
      ref={element}
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
  const { wait, element } = useSkeletonWait<HTMLDivElement>()
  return (
    <div
      ref={element}
      className={cn("ctx-loading-motion ctx-skeleton-wait", props.className)}
      style={waitStyle(wait)}
    >
      {props.children}
    </div>
  )
}

/**
 * When the skeleton of `chain` shows (performance time). Read it in a layout
 * effect: the bones set it in their own layout effects, which run first.
 */
function visibleAtOf(chain: Chain | null) {
  return chain && chain.mounted > 0
    ? chain.visibleAt
    : performance.now() + SKELETON_DELAY_MS
}

/**
 * Keep a query-driven skeleton up for `SKELETON_MIN_MS` after it became
 * visible. Use it as `useSkeletonHold(query.isPending) ? <Skeleton… /> : …`.
 * Give the `SkeletonChain` id when the skeleton is in a chain, so the hold
 * starts when the chain shows.
 */
export function useSkeletonHold(pending: boolean, chainId?: string) {
  const chain = chainIn(useContext(SkeletonRegionContext), chainId)
  const [shownAt, setShownAt] = useState<number | null>(null)
  // Before paint, like the CSS wait, so the hold starts no later than the
  // skeleton shows.
  useLayoutEffect(() => {
    if (pending) {
      if (shownAt !== null) return
      const visibleAt = visibleAtOf(chain)
      const left = visibleAt - performance.now()
      if (left <= 0) {
        setShownAt(visibleAt)
        return
      }
      const id = setTimeout(
        () => setShownAt(visibleAt),
        Math.max(0, left - HOLD_LEAD_MS),
      )
      return () => clearTimeout(id)
    }
    if (shownAt === null) return
    const id = setTimeout(
      () => setShownAt(null),
      Math.max(0, shownAt + SKELETON_MIN_MS - performance.now()),
    )
    return () => clearTimeout(id)
  }, [pending, shownAt, chain])
  return pending || shownAt !== null
}

/**
 * The minimum show time of a `SkeletonSuspense` fallback, as a small store:
 * the fallback starts it, and the content reads it with
 * `useSyncExternalStore`.
 */
function createHold() {
  let promise: Promise<void> | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  const listeners = new Set<() => void>()
  return {
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    read: () => promise,
    start(visibleAt: number) {
      promise = new Promise((resolve) => {
        timer = setTimeout(
          resolve,
          Math.max(0, visibleAt + SKELETON_MIN_MS - performance.now()),
        )
      })
      for (const listener of listeners) listener()
    },
    dispose: () => clearTimeout(timer),
  }
}

type Hold = ReturnType<typeof createHold>

/**
 * `Suspense` with a skeleton fallback that follows the loading-state rule:
 * when the fallback became visible, the content waits until the fallback has
 * shown for `SKELETON_MIN_MS`. Give the `SkeletonChain` id when the fallback
 * is in a chain.
 */
export function SkeletonSuspense(props: {
  fallback: ReactNode
  chain?: string
  children: ReactNode
}) {
  const [hold] = useState(createHold)
  useEffect(() => hold.dispose, [hold])
  return (
    <Suspense
      fallback={
        <SkeletonFallback hold={hold} chain={props.chain}>
          {props.fallback}
        </SkeletonFallback>
      }
    >
      <SkeletonGate hold={hold}>{props.children}</SkeletonGate>
    </Suspense>
  )
}

function SkeletonFallback(props: {
  hold: Hold
  chain?: string
  children: ReactNode
}) {
  const { hold } = props
  const chain = chainIn(useContext(SkeletonRegionContext), props.chain)
  // A layout effect runs before paint, and CSS starts the wait at paint, so
  // the hold starts no later than the skeleton shows.
  useLayoutEffect(() => {
    const visibleAt = visibleAtOf(chain)
    const id = setTimeout(
      () => hold.start(visibleAt),
      Math.max(0, visibleAt - performance.now() - HOLD_LEAD_MS),
    )
    return () => clearTimeout(id)
  }, [hold, chain])
  return props.children
}

function SkeletonGate(props: { hold: Hold; children: ReactNode }) {
  const pending = useSyncExternalStore(
    props.hold.subscribe,
    props.hold.read,
    () => null,
  )
  if (pending) use(pending)
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
