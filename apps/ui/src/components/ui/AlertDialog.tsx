"use client"
import { IconAlertCircle, IconInfoCircle } from "@tabler/icons-react"
import React, { type ReactNode } from "react"
import { chain } from "react-aria"
import { type DialogProps, Heading } from "react-aria-components"
import { Button } from "@/components/ui/Button"
import { Dialog } from "@/components/ui/Dialog"

interface AlertDialogProps extends Omit<DialogProps, "children"> {
  title: string
  children: ReactNode
  variant?: "info" | "destructive"
  actionLabel: string
  cancelLabel?: string
  onAction?: () => void
}

export function AlertDialog({
  title,
  variant,
  cancelLabel,
  actionLabel,
  onAction,
  children,
  ...props
}: AlertDialogProps) {
  return (
    <Dialog role="alertdialog" {...props}>
      {({ close }) => (
        <>
          <Heading
            slot="title"
            className="text-xl font-semibold leading-6 my-0 text-zinc-100"
          >
            {title}
          </Heading>
          <div
            className={`w-6 h-6 absolute right-6 top-6 stroke-2 ${variant === "destructive" ? "text-destructive" : "text-blue-500"}`}
          >
            {variant === "destructive" ? (
              <IconAlertCircle aria-hidden />
            ) : (
              <IconInfoCircle aria-hidden />
            )}
          </div>
          <p className="mt-3 text-zinc-400">
            {children}
          </p>
          <div className="mt-6 flex justify-end gap-2">
            <Button
              variant="quiet"
              onPress={close}
              className="rounded-none !text-zinc-400 hover:!text-teal-500"
            >
              {cancelLabel || "Cancel"}
            </Button>
            <Button
              variant={variant === "destructive" ? "destructive" : "primary"}
              autoFocus
              onPress={chain(onAction, close)}
              className={
                variant !== "destructive"
                  ? "rounded-none !bg-teal-500 !text-black hover:!bg-teal-600"
                  : "rounded-none"
              }
            >
              {actionLabel}
            </Button>
          </div>
        </>
      )}
    </Dialog>
  )
}
