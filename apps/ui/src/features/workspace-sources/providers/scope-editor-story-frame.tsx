import type { Decorator } from "@storybook/react-vite"
import type { CSSProperties } from "react"

/**
 * The story frame of a scope editor: the width of the source dialog, and the
 * `--visual-viewport-height` that its modal gives to the content. Without
 * that value, a list that caps its height at a part of the viewport grows
 * without a limit.
 */
export const scopeEditorStoryFrame: Decorator = (Story) => (
  <div
    className="max-w-lg bg-zinc-950 p-4"
    style={{ "--visual-viewport-height": "100vh" } as CSSProperties}
  >
    <Story />
  </div>
)
