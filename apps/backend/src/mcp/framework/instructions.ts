import { isValidSlug } from "../../domain/workspaces/slug.js"
import { DOCS_URL } from "../../lib/docs-url.js"
import { listOrgWorkspaceSlugs } from "./call-workspace.js"
import { listToolOrgs } from "./tool-org.js"

/** Total limit for the server instructions (ADR-051 §5). */
export const INSTRUCTIONS_MAX_CHARS = 2_048
/** Some clients keep only the start; the rules must stand alone in it. */
export const INSTRUCTIONS_HEAD_CHARS = 512

/**
 * Rules come first and fit in the first 512 characters, so a client that
 * cuts the instructions still gets them.
 */
export const INSTRUCTION_RULES = [
  "ctxpipe is your organization's context: curated knowledge and code in the organization's other repositories.",
  "Rules:",
  "1. ctxpipe serves the default branch; do not use it for your current repository. Use your own tools there and pass its git remote URL in excludeRepositories.",
  "2. Call these tools in parallel where possible: send independent searches and reads in one turn.",
  "3. Search knowledge before a design choice. Name one org in each call. Cite refs.",
  `4. How to use ctxpipe: ${DOCS_URL}/llms.txt`,
].join("\n")

type InstructionOrg = { slug: string; workspaces: readonly string[] }

/**
 * Rules, then each org with its Workspace slugs, under 2,048 characters.
 *
 * - Only slugs that pass `isValidSlug` go in. A slug is text that a user
 *   chose, so it must not carry line breaks or other text into the
 *   instructions.
 * - Each org line comes first; then the Workspaces fill the room one at a
 *   time for each org in turn, so a large org cannot hide the others.
 * - When the list does not fit, it stops at a whole slug and tells the
 *   agent to call list_workspaces.
 */
export function buildServerInstructions(
  orgs: readonly InstructionOrg[],
): string {
  const valid = orgs
    .filter((org) => isValidSlug(org.slug))
    .map((org) => ({
      slug: org.slug,
      workspaces: org.workspaces.filter((slug) => isValidSlug(slug)),
    }))
  if (valid.length === 0) return INSTRUCTION_RULES
  const header = "\n\nOrgs and Workspaces (org: workspace slugs):"
  const total = valid.reduce((sum, org) => sum + org.workspaces.length, 0)
  const more = (orgsLeft: number, workspacesLeft: number) =>
    `\n[and ${[
      orgsLeft > 0 ? `${orgsLeft} more orgs` : "",
      workspacesLeft > 0 ? `${workspacesLeft} more Workspaces` : "",
    ]
      .filter(Boolean)
      .join(", ")}: call list_workspaces]`
  // Room for the longest possible "more" line.
  const limit = INSTRUCTIONS_MAX_CHARS - 1 - more(valid.length, total).length
  let used = INSTRUCTION_RULES.length + header.length

  const lines: Array<{ prefix: string; shown: string[]; all: string[] }> = []
  for (const org of valid) {
    const prefix = `\n- ${org.slug}:`
    const empty = org.workspaces.length === 0 ? " (no Workspaces)" : ""
    if (used + prefix.length + empty.length > limit) break
    used += prefix.length + empty.length
    lines.push({ prefix: prefix + empty, shown: [], all: [...org.workspaces] })
  }
  const open = new Set(lines.filter((line) => line.all.length > 0))
  while (open.size > 0) {
    for (const line of [...open]) {
      const next = line.all[line.shown.length]
      const part = `${line.shown.length === 0 ? " " : ", "}${next}`
      if (next === undefined || used + part.length > limit) {
        open.delete(line)
        continue
      }
      used += part.length
      line.shown.push(next)
      if (line.shown.length === line.all.length) open.delete(line)
    }
  }

  const shown = lines.reduce((sum, line) => sum + line.shown.length, 0)
  const listedOrgs = new Set(lines.map((line) => line.prefix))
  const body = lines
    .map((line) =>
      line.shown.length > 0
        ? `${line.prefix} ${line.shown.join(", ")}`
        : line.prefix,
    )
    .join("")
  const hiddenOrgs = valid.length - listedOrgs.size
  const hiddenWorkspaces = total - shown
  return `${INSTRUCTION_RULES}${header}${body}${
    hiddenOrgs > 0 || hiddenWorkspaces > 0
      ? more(hiddenOrgs, hiddenWorkspaces)
      : ""
  }`
}

/** Instructions for the principal of the current request. */
export async function loadServerInstructions(): Promise<string> {
  const orgs = await listToolOrgs()
  return buildServerInstructions(
    await Promise.all(
      orgs.map(async (org) => ({
        slug: org.slug,
        workspaces: await listOrgWorkspaceSlugs(org),
      })),
    ),
  )
}
