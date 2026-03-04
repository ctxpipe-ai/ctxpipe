import type { ComponentProps } from "react"
import { twMerge } from "tailwind-merge"

function CornerCross({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={twMerge("pointer-events-none absolute size-3", className)}
    >
      <svg
        viewBox="0 0 12 12"
        className="size-full text-zinc-700"
        stroke="currentColor"
        strokeWidth={1.5}
        aria-hidden
      >
        <title>Corner decoration</title>
        <line x1={6} y1={0} x2={6} y2={12} />
        <line x1={0} y1={6} x2={12} y2={6} />
      </svg>
    </span>
  )
}

function Card({
  className,
  size = "default",
  children,
  ...props
}: ComponentProps<"div"> & { size?: "default" | "sm" }) {
  return (
    <div
      data-slot="card"
      data-size={size}
      className={twMerge(
        "relative ring-zinc-800 ring-1 bg-card text-card-foreground gap-6 text-sm has-[>img:first-child]:pt-0 data-[size=sm]:gap-4 data-[size=sm]:py-4 *:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl group/card flex flex-col",
        className,
      )}
      {...props}
    >
      <CornerCross className="left-0 top-0 -translate-x-[calc(50%+0.5px)] -translate-y-[calc(50%+0.5px)]" />
      <CornerCross className="right-0 top-0 translate-x-[calc(50%+0.5px)] -translate-y-[calc(50%+0.5px)]" />
      <CornerCross className="bottom-0 left-0 -translate-x-[calc(50%+0.5px)] translate-y-[calc(50%+0.5px)]" />
      <CornerCross className="bottom-0 right-0 translate-x-[calc(50%+0.5px)] translate-y-[calc(50%+0.5px)]" />
      {children}
    </div>
  )
}

function CardHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={twMerge(
        "gap-1 rounded-t-xl px-6 group-data-[size=sm]/card:px-4 [.border-b]:pb-6 group-data-[size=sm]/card:[.border-b]:pb-4 group/card-header @container/card-header grid auto-rows-min items-start has-data-[slot=card-action]:grid-cols-[1fr_auto] has-data-[slot=card-description]:grid-rows-[auto_auto]",
        className,
      )}
      {...props}
    />
  )
}

function CardTitle({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={twMerge(
        "text-base leading-normal font-medium group-data-[size=sm]/card:text-sm",
        className,
      )}
      {...props}
    />
  )
}

function CardDescription({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={twMerge("text-muted-foreground text-sm", className)}
      {...props}
    />
  )
}

function CardAction({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={twMerge(
        "col-start-2 row-span-2 row-start-1 self-start justify-self-end",
        className,
      )}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={twMerge("px-6 group-data-[size=sm]/card:px-4", className)}
      {...props}
    />
  )
}

function CardFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={twMerge(
        "rounded-b-xl px-6 group-data-[size=sm]/card:px-4 [.border-t]:pt-6 group-data-[size=sm]/card:[.border-t]:pt-4 flex items-center",
        className,
      )}
      {...props}
    />
  )
}

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
}
