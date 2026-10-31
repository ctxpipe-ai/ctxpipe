"use client"
import type React from "react"
import { type DialogProps, Dialog as RACDialog } from "react-aria-components"
import { twMerge } from "tailwind-merge"

export function Dialog(props: DialogProps) {
  return (
    <RACDialog
      {...props}
      className={twMerge(
        "outline outline-0 box-border p-6 [[data-placement]>&]:p-4 max-h-[inherit] overflow-auto relative",
        props.className,
      )}
    />
  )
}

export function DialogHeader(props: React.ComponentProps<"div">) {
  return (
    <div
      {...props}
      className={twMerge("flex flex-col gap-2", props.className)}
    />
  )
}

export function DialogTitle(props: React.ComponentProps<"h2">) {
  return (
    <h2
      {...props}
      className={twMerge(
        "text-base font-medium text-zinc-100",
        props.className,
      )}
    />
  )
}

export function DialogDescription(props: React.ComponentProps<"p">) {
  return (
    <p
      {...props}
      className={twMerge("text-sm text-zinc-400", props.className)}
    />
  )
}
