import { IconBrandGithub } from "@tabler/icons-react"
import { PlaceholderScopeEditor } from "../PlaceholderScopeEditor"
import type { SourceProviderUi } from "../source-provider-ui"

/** GitHub source UI. The GitHub provider work (phase 2) adds its editor. */
export const githubSourceUi: SourceProviderUi = {
  Icon: IconBrandGithub,
  ScopeEditor: PlaceholderScopeEditor,
}
