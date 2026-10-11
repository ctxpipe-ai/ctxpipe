import { LinearMark } from "@/features/connectors/components/LinearMark"
import { PlaceholderScopeEditor } from "../PlaceholderScopeEditor"
import type { SourceProviderUi } from "../source-provider-ui"

/** Linear source UI. The Linear provider work (phase 2) adds its editor. */
export const linearSourceUi: SourceProviderUi = {
  Icon: LinearMark,
  ScopeEditor: PlaceholderScopeEditor,
}
