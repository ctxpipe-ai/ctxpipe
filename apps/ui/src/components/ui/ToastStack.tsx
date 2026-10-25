"use client"

import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react"
import { cn } from "@/lib/utils"

/** The space between two open toasts, and the step of the closed stack (px). */
const GAP = 12
const PEEK = 10
/** The closed stack shows the front toast and two edges behind it. */
const VISIBLE = 3

/**
 * The heights of the toast bodies, by id. A ResizeObserver reads them, so
 * the content sets each height and the stack follows a change of text.
 */
function useHeights(list: RefObject<HTMLOListElement | null>, key: string) {
  const [heights, setHeights] = useState<Record<string, number>>({})
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- `key` names the toasts, so a new toast gets observed
  useEffect(() => {
    const node = list.current
    if (!node) return
    const observer = new ResizeObserver((entries) => {
      setHeights((previous) => {
        let next = previous
        for (const entry of entries) {
          const target = entry.target as HTMLElement
          const id = target.dataset.toastId
          if (id && next[id] !== target.offsetHeight)
            next = { ...next, [id]: target.offsetHeight }
        }
        return next
      })
    })
    for (const body of node.querySelectorAll<HTMLElement>("[data-toast-id]"))
      observer.observe(body)
    return () => observer.disconnect()
  }, [list, key])
  return heights
}

/**
 * A stack of toasts in the page flow (CTX-894, CTX-939). The stack is as high
 * as the front toast, so it never covers the block below it, and it holds no
 * space when it has no toast. The caller shows and hides it in a view
 * transition, so the blocks below move with transforms (DESIGN.md Motion).
 * The front toast shows in full; the others are edges behind it. Hover or
 * focus in the stack opens it, so each toast shows in full above the front
 * one and Tab reaches each control. Only transforms and opacity move, and the
 * reduced-motion rule stops them.
 */
export function ToastStack(props: {
  label: string
  /** The class names of the stack: the caller names it for a view transition. */
  className?: string
  toasts: ReadonlyArray<{ id: string; content: ReactNode }>
}) {
  const { label, toasts, className } = props
  const list = useRef<HTMLOListElement>(null)
  // The pointer opens the stack; focus opens it with `:focus-within`.
  const [hovered, setHovered] = useState(false)
  const heights = useHeights(list, toasts.map((toast) => toast.id).join("\n"))
  if (toasts.length === 0) return null
  const frontHeight = heights[toasts[0]?.id ?? ""] ?? 0
  let offset = 0
  return (
    <section
      aria-label={label}
      className={cn("relative z-40", className)}
      // The edges behind the front toast need room under it.
      style={{ paddingBottom: (Math.min(toasts.length, VISIBLE) - 1) * PEEK }}
    >
      <ol
        ref={list}
        data-open={hovered || undefined}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        className="group/stack relative"
      >
        {toasts.map((toast, index) => {
          const openY = offset
          offset += (heights[toast.id] ?? 0) + GAP
          const front = index === 0
          const style = {
            zIndex: toasts.length - index,
            "--toast-closed-y": `${index * PEEK}px`,
            "--toast-open-y": `${openY}px`,
            "--toast-closed-scale": `${1 - index * 0.03}`,
            "--toast-closed-height": `${frontHeight}px`,
          } as CSSProperties
          return (
            <li
              key={toast.id}
              style={style}
              data-front={front || undefined}
              className={[
                "rounded-md border border-white/15 bg-zinc-800 text-foreground shadow-lg shadow-black/40",
                "origin-top translate-y-(--toast-closed-y) scale-(--toast-closed-scale) ease-out transition-[translate,scale,opacity]",
                "group-data-open/stack:translate-y-(--toast-open-y) group-data-open/stack:scale-100 group-focus-within/stack:translate-y-(--toast-open-y) group-focus-within/stack:scale-100",
                // The space under an open toast keeps the hover, so the stack
                // stays open while the pointer moves to the next toast.
                "before:absolute before:inset-x-0 before:top-full before:h-3",
                front
                  ? "relative"
                  : [
                      "absolute inset-x-0 top-0 h-(--toast-closed-height) overflow-hidden",
                      "group-data-open/stack:h-auto group-data-open/stack:overflow-visible group-focus-within/stack:h-auto group-focus-within/stack:overflow-visible",
                      index >= VISIBLE
                        ? "opacity-0 group-data-open/stack:opacity-100 group-focus-within/stack:opacity-100"
                        : "",
                    ].join(" "),
              ].join(" ")}
            >
              <div
                data-toast-id={toast.id}
                className={
                  front
                    ? undefined
                    : "opacity-0 transition-opacity ease-out group-data-open/stack:opacity-100 group-focus-within/stack:opacity-100"
                }
              >
                {toast.content}
              </div>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
