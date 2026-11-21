import preview from "../../../../.storybook/preview"
import { PagerdutyMark } from "./PagerdutyMark"

const meta = preview.meta({
  title: "Components/Connections/PagerDuty/Mark",
  component: PagerdutyMark,
  parameters: { layout: "centered", review: { kind: "component" } },
  args: { className: "size-10 text-foreground" },
})

/**
 * PagerDuty product mark, the logo that names the provider on connector cards
 * and dialogs: the mark alone at a large size.
 */
export const ProductMark = meta.story()
