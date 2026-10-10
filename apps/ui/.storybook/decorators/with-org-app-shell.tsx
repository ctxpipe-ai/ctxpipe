import type { Decorator } from "@storybook/react-vite"
import { AppShell } from "@/components/AppShell"

/** Org product pages: shell lives on `/$orgSlug`, not on the leaf. */
export const withOrgAppShell: Decorator = (Story) => (
  <AppShell>
    <Story />
  </AppShell>
)
