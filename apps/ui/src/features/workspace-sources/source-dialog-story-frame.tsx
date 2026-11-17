import type { Decorator } from "@storybook/react-vite"
import type { CSSProperties } from "react"

/**
 * The story frame of the body of a source dialog (Add or Edit source, and the
 * Add to Workspaces step): the width of the dialog, and the
 * `--visual-viewport-height` that its modal gives to the content. Without
 * that value, a scope list that caps its height at a part of the viewport
 * grows without a limit.
 */
export const sourceDialogStoryFrame: Decorator = (Story) => (
  <div
    className="max-w-lg bg-zinc-950 p-4"
    style={{ "--visual-viewport-height": "100vh" } as CSSProperties}
  >
    <Story />
  </div>
)
