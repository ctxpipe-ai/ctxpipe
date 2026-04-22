"use client"
import type { ComponentProps } from "react"
import type { ButtonProps as RACButtonProps } from "react-aria-components"
import { composeRenderProps, Button as RACButton } from "react-aria-components"
import { tv } from "tailwind-variants"
import { focusRing } from "@/lib/react-aria-utils"

type AnchorLinkProps = Pick<
  ComponentProps<"a">,
  "href" | "target" | "rel" | "download"
>

export interface ButtonProps
  extends Omit<RACButtonProps, "size">,
    AnchorLinkProps {
  /** @default 'primary' */
  variant?: "primary" | "secondary" | "destructive" | "quiet" | "ghost"
  /** @default 'default' */
  size?: "default" | "icon" | "icon-sm"
}

const button = tv({
  extend: focusRing,
  base: "relative inline-flex items-center justify-center gap-2 border border-transparent dark:border-white/10 h-9 box-border px-3.5 py-0 font-sans text-sm text-center transition rounded-lg cursor-default [-webkit-tap-highlight-color:transparent]",
  variants: {
    variant: {
      primary:
        "bg-primary text-primary-foreground hover:bg-primary/90 pressed:bg-primary/80",
      secondary:
        "border-border bg-secondary text-secondary-foreground hover:bg-secondary/80 pressed:bg-secondary/70",
      destructive:
        "bg-destructive font-medium text-white hover:bg-destructive/90 pressed:bg-destructive/80",
      quiet:
        "border-0 bg-transparent text-zinc-500 transition-[color,filter] hover:text-teal-500 hover:[filter:drop-shadow(0_0_8px_var(--color-teal-500))]",
      ghost:
        "border-0 bg-transparent text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground pressed:bg-foreground/[0.08]",
    },
    size: {
      default: "",
      icon: "h-9 w-9 min-w-9 shrink-0 px-0",
      "icon-sm": "h-8 w-8 min-w-8 shrink-0 px-0",
    },
    isDisabled: {
      true: "border-transparent bg-muted text-muted-foreground forced-colors:text-[GrayText] hover:bg-muted hover:text-muted-foreground",
    },
    isPending: {
      true: "text-transparent",
    },
  },
  defaultVariants: {
    variant: "primary",
    size: "default",
  },
  compoundVariants: [
    {
      variant: "quiet",
      isDisabled: true,
      class: "bg-transparent dark:bg-transparent",
    },
    {
      variant: "ghost",
      isDisabled: true,
      class:
        "bg-transparent hover:bg-transparent pressed:bg-transparent text-muted-foreground",
    },
  ],
})

export function Button(props: ButtonProps) {
  const { variant, size, className, ...rest } = props
  return (
    <RACButton
      {...rest}
      className={composeRenderProps(className, (cn, renderProps) =>
        button({ ...renderProps, variant, size, className: cn }),
      )}
    >
      {composeRenderProps(props.children, (children, { isPending }) => (
        <>
          {children}
          {isPending && (
            <span
              aria-hidden
              className="flex absolute inset-0 justify-center items-center"
            >
              <svg
                aria-hidden
                role="presentation"
                className={[
                  "h-4 w-4 animate-spin",
                  props.variant === "secondary" ||
                  props.variant === "quiet" ||
                  props.variant === "ghost"
                    ? "text-foreground"
                    : props.variant === "destructive"
                      ? "text-white"
                      : "text-primary-foreground",
                ].join(" ")}
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <circle
                  cx="12"
                  cy="12"
                  r="10"
                  strokeWidth="4"
                  fill="none"
                  className="opacity-25"
                />
                <circle
                  cx="12"
                  cy="12"
                  r="10"
                  strokeWidth="4"
                  strokeLinecap="round"
                  fill="none"
                  pathLength="100"
                  strokeDasharray="60 140"
                  strokeDashoffset="0"
                />
              </svg>
            </span>
          )}
        </>
      ))}
    </RACButton>
  )
}
