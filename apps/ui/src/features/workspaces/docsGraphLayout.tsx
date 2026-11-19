import type { Decorator } from "@storybook/react-vite"

import {
  type FixedGraphLayout,
  FixedGraphLayoutContext,
} from "@/features/knowledge-graph/fixedGraphLayout"

/**
 * The positions of the points of `docsWorkspaceGraph` at the end of its
 * reduced-motion layout (300 steps).
 */
const docsWorkspaceGraphLayout: FixedGraphLayout = {
  "knowledge/billing/ledger.md": [2011.9, 2017.6],
  "knowledge/billing/invoices.md": [2004.1, 2024.5],
  "knowledge/billing/tax.md": [2000.4, 2021.2],
  "knowledge/auth/session.md": [2013, 2013.3],
  "knowledge/auth/members.md": [2003, 2010.1],
  "knowledge/auth/sso.md": [2014.9, 1989.3],
  "knowledge/search/index.md": [2009, 2003.3],
  "knowledge/search/query.md": [2020.1, 1981.8],
  "knowledge/search/ranking.md": [2025.4, 1991.2],
  "knowledge/connectors/github.md": [2020.6, 2003.8],
  "knowledge/connectors/notion.md": [2028.5, 2004.5],
  "knowledge/connectors/linear.md": [2033.1, 2004.4],
  "knowledge/chat/composer.md": [2008, 2020.1],
  "knowledge/chat/sandbox.md": [2024.9, 2001.8],
  "knowledge/chat/tools.md": [2011.9, 2000.2],
  "knowledge/hydrate/projection.md": [2024.5, 1982.6],
  "knowledge/hydrate/claims.md": [2010.4, 2009.3],
  "knowledge/hydrate/git.md": [2035.1, 1993.3],
  "knowledge/settings/workspace.md": [2004.8, 2014.6],
  "knowledge/settings/slug.md": [1999.4, 2016.4],
  "knowledge/scratch/orphan.md": [1993.7, 2021.3],
  "knowledge/platform/api.md": [2029.3, 1995.3],
  "knowledge/platform/worker.md": [2040, 1993.5],
  "knowledge/platform/postgres.md": [2033.5, 1982],
  "knowledge/platform/falkordb.md": [2031.6, 1975],
  "knowledge/platform/embeddings.md": [2030.3, 1971.9],
  "knowledge/platform/codesearch.md": [2028, 1998.9],
  "knowledge/ops/jobs.md": [2037.9, 1986.7],
}

/**
 * Shows `docsWorkspaceGraph` at fixed positions, with no layout. A layout in
 * the screenshot container runs on a CPU renderer and took up to 30 s.
 */
export const withDocsGraphLayout: Decorator = (Story) => (
  <FixedGraphLayoutContext.Provider value={docsWorkspaceGraphLayout}>
    <Story />
  </FixedGraphLayoutContext.Provider>
)
