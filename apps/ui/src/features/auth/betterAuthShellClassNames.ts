import type {
  AccountViewProps,
  AuthViewProps,
} from "@daveyplate/better-auth-ui"

/**
 * Shared @daveyplate/better-auth-ui shell styling for AccountView and OrganizationView:
 * house radius, teal active nav, ctx surfaces.
 */
export const betterAuthShellClassNames: NonNullable<
  AccountViewProps["classNames"]
> = {
  sidebar: {
    button:
      "rounded-md px-3 text-sm font-normal tracking-normal transition-colors hover:bg-white/[0.05]",
    buttonActive: "text-teal-400",
  },
  drawer: {
    menuItem: "rounded-md",
  },
  card: {
    base: "ctx-border ctx-surface rounded-md border-border shadow-none",
    footer: "rounded-md border-border bg-transparent shadow-none",
    cell: "rounded-md border border-border bg-transparent shadow-none",
    input:
      "!rounded-md border-border bg-transparent shadow-none focus-visible:border-teal-400/50 focus-visible:ring-1 focus-visible:ring-teal-400/35",
    button: "!rounded-md",
    outlineButton: "!rounded-md",
    primaryButton: "!rounded-md",
    secondaryButton: "!rounded-md",
    destructiveButton: "!rounded-md",
    skeleton: "rounded-md",
    dialog: {
      content: "rounded-md border-border",
      header: "",
      footer: "rounded-md",
    },
  },
}

/**
 * Shared @daveyplate/better-auth-ui auth page styling for Sign In / Sign Up:
 * house radius for cards, fields and buttons.
 */
export const betterAuthEmailPlaceholder = "you@company.com"

export const betterAuthAuthViewClassNames: NonNullable<
  AuthViewProps["classNames"]
> = {
  base: "ctx-border ctx-surface rounded-md border-border shadow-none",
  header: "rounded-md",
  content: "rounded-md",
  footer: "rounded-md border-border bg-transparent shadow-none",
  form: {
    input:
      "!rounded-md border-border bg-transparent shadow-none focus-visible:border-teal-400/50 focus-visible:ring-1 focus-visible:ring-teal-400/35",
    button: "!rounded-md",
    primaryButton: "!rounded-md",
    secondaryButton: "!rounded-md",
    outlineButton: "!rounded-md",
    providerButton: "!rounded-md",
  },
}
