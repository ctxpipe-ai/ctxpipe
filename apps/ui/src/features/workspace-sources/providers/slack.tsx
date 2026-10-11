import { IconBrandSlack } from "@tabler/icons-react"
import type { SourceProviderUi } from "../source-provider-ui"

/** Slack source UI. The Slack provider work (phase 2) adds its editor. */
export const slackSourceUi: SourceProviderUi = {
  Icon: IconBrandSlack,
  ScopeEditor: null,
}
