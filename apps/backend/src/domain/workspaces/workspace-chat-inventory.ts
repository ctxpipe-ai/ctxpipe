import type { TanstackLikeHandle } from "./job-sandbox.js"

export const WORKSPACE_CHAT_INVENTORY_PATH =
  ".ctxpipe/workspace-inventory.md" as const

export const WORKSPACE_CHAT_INSTRUCTIONS_PATH = ".ctxpipe/CHAT.md" as const

export const WORKSPACE_CHAT_INSTRUCTIONS = `For questions about what is in this repository, what the workspace contains, or a file map, read ${WORKSPACE_CHAT_INVENTORY_PATH} and answer in one shot. Do not run ls, find, glob, or grep tours to rediscover the tree.
`

const INVENTORY_PATH_LIMIT = 200
const EXCERPT_BYTES = 4096

export function renderWorkspaceInventoryMarkdown(input: {
  paths: string[]
  agentsExcerpt?: string
  readmeExcerpt?: string
}): string {
  const paths = input.paths
    .map((path) => path.trim())
    .filter((path) => path.length > 0)
    .slice(0, INVENTORY_PATH_LIMIT)
  const lines = [
    "# Workspace inventory",
    "",
    "Org-scoped checkout paths (not a host filesystem dump).",
    "",
    "## Files",
    ...paths.map((path) => `- ${path}`),
  ]
  if (input.agentsExcerpt?.trim()) {
    lines.push("", "## AGENTS.md", "", input.agentsExcerpt.trim())
  }
  if (input.readmeExcerpt?.trim()) {
    lines.push("", "## README", "", input.readmeExcerpt.trim())
  }
  return `${lines.join("\n")}\n`
}

export async function writeChatSandboxInventory(input: {
  handle: TanstackLikeHandle
}): Promise<void> {
  const listed = await sandboxExec(
    input.handle,
    "sh -c 'git ls-files 2>/dev/null | head -n 200'",
  )
  let paths = listed.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  if (paths.length === 0) {
    const fallback = await sandboxExec(
      input.handle,
      'sh -c \'find . -maxdepth 3 -type f ! -path "./.git/*" ! -path "./node_modules/*" | sed "s|^\\\\./||" | head -n 200\'',
    )
    paths = fallback.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
  }
  const agents = await sandboxExec(
    input.handle,
    `sh -c 'head -c ${EXCERPT_BYTES} AGENTS.md 2>/dev/null || true'`,
  )
  const readme = await sandboxExec(
    input.handle,
    `sh -c 'head -c ${EXCERPT_BYTES} README.md 2>/dev/null || head -c ${EXCERPT_BYTES} README 2>/dev/null || true'`,
  )
  const markdown = renderWorkspaceInventoryMarkdown({
    paths,
    agentsExcerpt: agents.stdout,
    readmeExcerpt: readme.stdout,
  })
  await input.handle.fs.mkdir(".ctxpipe")
  await input.handle.fs.write(WORKSPACE_CHAT_INVENTORY_PATH, markdown)
}

async function sandboxExec(
  handle: TanstackLikeHandle,
  command: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const exec = handle.process?.exec
  if (!exec) {
    throw new Error("Chat sandbox handle cannot exec")
  }
  return exec(command)
}
