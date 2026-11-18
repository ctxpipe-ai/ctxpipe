"use client"
import type React from "react"
import { type DialogProps, Dialog as RACDialog } from "react-aria-components"
import { twMerge } from "tailwind-merge"

/**
 * The content frame of a modal or a popover: the padding, the scroll and the
 * dialog role. Put it in a `Modal` (or a `Popover`), and start it with a
 * `DialogHeader`. Use `AlertDialog` for a confirm step.
 */
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

/** The top block of a `Dialog`: a `DialogTitle` above a `DialogDescription`. */
export function DialogHeader(props: React.ComponentProps<"div">) {
  return (
    <div
      {...props}
      className={twMerge("flex flex-col gap-2", props.className)}
    />
  )
}

/**
 * The title of a `Dialog`, as a plain `h2`. It does not name the dialog for a
 * screen reader: give the `Dialog` an `aria-labelledby`, or use a React Aria
 * `Heading` with `slot="title"`.
 */
export function DialogTitle(props: React.ComponentProps<"h2">) {
  return (
    <h2
      {...props}
      className={twMerge(
        "text-base font-semibold text-zinc-100",
        props.className,
      )}
    />
  )
}

/**
 * One muted paragraph below the `DialogTitle` that says what the dialog does
 * and what happens next.
 */
export function DialogDescription(props: React.ComponentProps<"p">) {
  return (
    <p
      {...props}
      className={twMerge("text-sm text-zinc-400", props.className)}
    />
  )
}
