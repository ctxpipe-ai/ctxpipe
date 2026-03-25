import type { AccountViewProps } from "@daveyplate/better-auth-ui"

/**
 * Styling for @daveyplate/better-auth-ui OrganizationView to match ctxpipe shell:
 * square corners, teal active nav, ctx surfaces.
 */
export const organizationViewClassNames: NonNullable<
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
    /** Per-member row (better-auth-ui MemberCell inner Card) */
    cell: "rounded-none border border-border bg-transparent shadow-none",
    input:
      "!rounded-none border-border bg-transparent shadow-none focus-visible:border-teal-400/50 focus-visible:ring-1 focus-visible:ring-teal-400/35",
    /** Shared by SettingsActionButton, MemberCell menu trigger, InviteMemberDialog */
    button: "!rounded-none",
    outlineButton: "!rounded-none",
    primaryButton: "!rounded-none",
    destructiveButton: "!rounded-none",
    skeleton: "rounded-none",
    dialog: {
      content: "rounded-none border-border",
      header: "",
      footer: "rounded-none",
    },
  },
}
