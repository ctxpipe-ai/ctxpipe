"use client"

import type { HTMLAttributes, ReactNode } from "react"
import { useCallback, useRef } from "react"
import Link from "fumadocs-core/link"
import { cn } from "fumadocs-ui/utils/cn"

type CardsProps = HTMLAttributes<HTMLDivElement>

export function Cards({ className, children, ...props }: CardsProps) {
  const gridRef = useRef<HTMLDivElement>(null)

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const grid = gridRef.current
    if (!grid) return

    const cards = grid.querySelectorAll<HTMLElement>(".card-pixel")
    cards.forEach((card) => {
      const rect = card.getBoundingClientRect()
      card.style.setProperty("--mouse-x", `${e.clientX - rect.left}px`)
      card.style.setProperty("--mouse-y", `${e.clientY - rect.top}px`)
    })
  }, [])

  const handleMouseLeave = useCallback(() => {
    const grid = gridRef.current
    if (!grid) return

    const cards = grid.querySelectorAll<HTMLElement>(".card-pixel")
    cards.forEach((card) => {
      card.style.removeProperty("--mouse-x")
      card.style.removeProperty("--mouse-y")
    })
  }, [])

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: mousemove/leave only update per-card CSS variables for spotlight styling.
    <div
      {...props}
      ref={gridRef}
      className={cn("docs-card-grid grid grid-cols-2 gap-3 @container", className)}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      {children}
    </div>
  )
}

type CardProps = Omit<HTMLAttributes<HTMLElement>, "title"> & {
  icon?: ReactNode
  title: ReactNode
  description?: ReactNode
  href?: string
  external?: boolean
}

export function Card({
  icon,
  title,
  description,
  href,
  external,
  children,
  className,
  ...props
}: CardProps) {
  const content = (
    <>
      {icon ? <div className="docs-card-icon">{icon}</div> : null}
      <span className="docs-card-title">{title}</span>
      {description ? <p className="docs-card-description">{description}</p> : null}
      {children ? <div className="docs-card-body">{children}</div> : null}
    </>
  )

  const classes = cn(
    "card-pixel hairline flex flex-col gap-2 border-border/60 bg-card/30 p-4 @max-lg:col-span-full",
    className,
  )

  if (href) {
    return (
      <Link
        {...props}
        href={href}
        external={external}
        data-card
        className={classes}
      >
        {content}
      </Link>
    )
  }

  return (
    <div {...props} data-card className={classes}>
      {content}
    </div>
  )
}
