import preview from "../../../../.storybook/preview"
import { ZendeskMark } from "./ZendeskMark"

const meta = preview.meta({
  title: "Components/Connections/Zendesk/Mark",
  component: ZendeskMark,
  parameters: { layout: "centered", review: { kind: "component" } },
  args: { className: "size-10 text-foreground" },
})

/**
 * Zendesk product mark, the logo that names the provider on connector cards and
 * dialogs: the mark alone at a large size.
 */
export const ProductMark = meta.story()
