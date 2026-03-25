import type { AccountViewProps } from "@daveyplate/better-auth-ui"

/**
 * Shared @daveyplate/better-auth-ui shell styling for AccountView and OrganizationView:
 * square corners, teal active nav, ctx surfaces.
 */
export const betterAuthShellClassNames: NonNullable<
  AccountViewProps["classNames"]
> = {
  sidebar: {
    button:
      "rounded-none px-3 text-sm font-normal tracking-normal transition-colors hover:bg-white/[0.05]",
    buttonActive: "text-teal-400",
  },
  drawer: {
    menuItem: "rounded-none",
  },
  card: {
    base: "ctx-border ctx-surface rounded-none border-border shadow-none",
    footer: "rounded-none border-border bg-transparent shadow-none",
    cell: "rounded-none border border-border bg-transparent shadow-none",
    input:
      "!rounded-none border-border bg-transparent shadow-none focus-visible:border-teal-400/50 focus-visible:ring-1 focus-visible:ring-teal-400/35",
    button: "!rounded-none",
    outlineButton: "!rounded-none",
    primaryButton: "!rounded-none",
    secondaryButton: "!rounded-none",
    destructiveButton: "!rounded-none",
    skeleton: "rounded-none",
    dialog: {
      content: "rounded-none border-border",
      header: "",
      footer: "rounded-none",
    },
  },
}
