"use client"

import Link from "fumadocs-core/link"
import { cn } from "fumadocs-ui/utils/cn"
import type { HTMLAttributes, ReactNode } from "react"
import { DocsIcon, docsIconForHref } from "./docs-icon"

type CardsProps = HTMLAttributes<HTMLDivElement>

export function Cards({ className, children, ...props }: CardsProps) {
  return (
    <div
      {...props}
      className={cn(
        "docs-card-grid grid grid-cols-2 gap-3 @container",
        className,
      )}
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
  const resolvedIcon = icon ?? (
    <DocsIcon name={docsIconForHref(href)} className="size-5" />
  )
  const content = (
    <>
      <div className="docs-card-heading">
        <span className="docs-card-icon">{resolvedIcon}</span>
        <DocsIcon name="arrow" className="docs-card-arrow size-4" />
      </div>
      <span className="docs-card-title">{title}</span>
      {description ? (
        <p className="docs-card-description">{description}</p>
      ) : null}
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
