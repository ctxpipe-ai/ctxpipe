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

export interface ButtonProps extends RACButtonProps, AnchorLinkProps {
  /** @default 'primary' */
  variant?: "primary" | "secondary" | "destructive" | "quiet"
}

const button = tv({
  extend: focusRing,
  base: "relative inline-flex items-center justify-center gap-2 border border-transparent dark:border-white/10 h-9 box-border px-3.5 py-0 [&:has(>svg:only-child)]:px-0 [&:has(>svg:only-child)]:h-8 [&:has(>svg:only-child)]:w-8 font-sans text-sm text-center transition rounded-lg cursor-default [-webkit-tap-highlight-color:transparent]",
  variants: {
    variant: {
      primary:
        "bg-primary text-primary-foreground hover:bg-primary/90 pressed:bg-primary/80",
      secondary:
        "border-border bg-secondary text-secondary-foreground hover:bg-secondary/80 pressed:bg-secondary/70",
      destructive:
        "bg-destructive text-destructive-foreground hover:bg-destructive/90 pressed:bg-destructive/80",
      quiet:
        "border-0 bg-transparent text-zinc-500 transition-[color,filter] hover:text-teal-500 hover:[filter:drop-shadow(0_0_8px_var(--color-teal-500))]",
    },
    isDisabled: {
      true: "border-transparent bg-muted text-muted-foreground forced-colors:text-[GrayText]",
    },
    isPending: {
      true: "text-transparent",
    },
  },
  defaultVariants: {
    variant: "primary",
  },
  compoundVariants: [
    {
      variant: "quiet",
      isDisabled: true,
      class: "bg-transparent dark:bg-transparent",
    },
  ],
})

export function Button(props: ButtonProps) {
  return (
    <RACButton
      {...props}
      className={composeRenderProps(props.className, (className, renderProps) =>
        button({ ...renderProps, variant: props.variant, className }),
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
                  props.variant === "secondary" || props.variant === "quiet"
                    ? "text-foreground"
                    : props.variant === "destructive"
                      ? "text-destructive-foreground"
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
