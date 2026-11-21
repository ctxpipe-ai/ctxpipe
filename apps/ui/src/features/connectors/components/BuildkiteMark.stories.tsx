import preview from "../../../../.storybook/preview"
import { BuildkiteMark } from "./BuildkiteMark"

const meta = preview.meta({
  title: "Components/Connections/Buildkite/Mark",
  component: BuildkiteMark,
  parameters: { layout: "centered" },
  args: { className: "size-10 text-foreground" },
})

/**
 * Buildkite mark, the logo in the ink color that names Buildkite on its
 * connector card and setup dialog: the mark alone, enlarged.
 */
export const ProductMark = meta.story({
  parameters: {
    review: {
      kind: "component",
    },
  },
})
