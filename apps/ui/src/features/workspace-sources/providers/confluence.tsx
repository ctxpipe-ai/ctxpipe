import { ConfluenceMark } from "@/features/connectors/components/ConfluenceMark"
import { PlaceholderScopeEditor } from "../PlaceholderScopeEditor"
import type { SourceProviderUi } from "../source-provider-ui"

/** Confluence source UI. The Confluence provider work (phase 2) adds its editor. */
export const confluenceSourceUi: SourceProviderUi = {
  Icon: ({ className }) => (
    <ConfluenceMark className={className} variant="outline" />
  ),
  ScopeEditor: PlaceholderScopeEditor,
}
