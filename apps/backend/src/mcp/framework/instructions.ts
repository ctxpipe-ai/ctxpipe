import { listCallOrgs } from "./call-org.js"
import { listOrgWorkspaceSlugs } from "./call-workspace.js"

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
].join("\n")

export type InstructionOrg = { slug: string; workspaces: readonly string[] }

/**
 * Rules, then each org with its Workspace slugs. When the list does not fit,
 * it stops at a whole slug and tells the agent to call list_workspaces.
 */
export function buildServerInstructions(
  orgs: readonly InstructionOrg[],
): string {
  const header = "\n\nOrgs and Workspaces (org: workspace slugs):"
  if (orgs.length === 0) return INSTRUCTION_RULES
  const total = orgs.reduce((sum, org) => sum + org.workspaces.length, 0)
  const more = (left: number) =>
    `\n[and ${left} more Workspaces: call list_workspaces]`
  // Room for the longest possible "more" line.
  const budget =
    INSTRUCTIONS_MAX_CHARS - 1 - more(total).length - INSTRUCTION_RULES.length
  let body = header
  let shown = 0
  outer: for (const org of orgs) {
    const prefix = `\n- ${org.slug}:`
    if (body.length + prefix.length > budget) break
    body += prefix
    let first = true
    for (const workspace of org.workspaces) {
      const part = `${first ? " " : ", "}${workspace}`
      if (body.length + part.length > budget) break outer
      body += part
      first = false
      shown += 1
    }
    if (org.workspaces.length === 0) body += " (no Workspaces)"
  }
  const text = `${INSTRUCTION_RULES}${body}`
  return shown < total ? `${text}${more(total - shown)}` : text
}

/** Instructions for the principal of the current request. */
export async function loadServerInstructions(): Promise<string> {
  const orgs = await listCallOrgs()
  return buildServerInstructions(
    await Promise.all(
      orgs.map(async (org) => ({
        slug: org.slug,
        workspaces: await listOrgWorkspaceSlugs(org),
      })),
    ),
  )
}
