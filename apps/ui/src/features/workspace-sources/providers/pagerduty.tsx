import { PagerdutyMark } from "@/features/connectors/components/PagerdutyMark"
import { PlaceholderScopeEditor } from "../PlaceholderScopeEditor"
import type { SourceProviderUi } from "../source-provider-ui"

/** PagerDuty source UI. The PagerDuty provider work (phase 2) adds its editor. */
export const pagerdutySourceUi: SourceProviderUi = {
  Icon: PagerdutyMark,
  ScopeEditor: PlaceholderScopeEditor,
}
