"use client"
import React from "react"
import { type DialogProps, Dialog as RACDialog } from "react-aria-components"
import { twMerge } from "tailwind-merge"
import { Button } from "@/components/ui/Button"
import { IconX } from "@tabler/icons-react"

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

export function DialogContent(
  props: React.ComponentProps<"div"> & { showCloseButton?: boolean },
) {
  const { className, children, showCloseButton = false, ...rest } = props
  return (
    <div
      {...rest}
      className={twMerge(
        "relative rounded-xl border border-zinc-800 bg-zinc-950/95 p-6",
        className,
      )}
    >
      {children}
      {showCloseButton ? (
        <Button
          className="absolute right-3 top-3"
          variant="quiet"
          aria-label="Close"
        >
          <IconX />
        </Button>
      ) : null}
    </div>
  )
}

export function DialogHeader(props: React.ComponentProps<"div">) {
  return <div {...props} className={twMerge("flex flex-col gap-2", props.className)} />
}

export function DialogTitle(props: React.ComponentProps<"h2">) {
  return (
    <h2
      {...props}
      className={twMerge("text-base font-semibold text-zinc-100", props.className)}
    />
  )
}

export function DialogDescription(props: React.ComponentProps<"p">) {
  return (
    <p {...props} className={twMerge("text-sm text-zinc-400", props.className)} />
  )
}
