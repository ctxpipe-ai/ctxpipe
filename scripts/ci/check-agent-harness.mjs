// Fails when the agent harness files drift apart. The shared content lives in
// AGENTS.md and .agents/; each harness directory is a thin adapter.
// - Codex reads only the first 32 KiB of the AGENTS.md files on the path from
//   the repo root to its working folder. The root AGENTS.md stays within
//   24 KiB, and each such chain (the root plus the nested files above and in a
//   folder) stays within 32 KiB.
// - .mcp.json (Claude Code), .codex/config.toml (Codex) and .cursor/mcp.json
//   (Cursor) list the same MCP server names. When two files give a server a
//   `url`, the URLs are the same. A stdio command can differ between harnesses
//   (Codex needs a bridge for some headers), so the check does not compare it.
// - .claude/skills and .cursor/skills are symlinks to .agents/skills.
import { execFileSync } from "node:child_process"
import { lstatSync, readFileSync, realpathSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const failures = []

const rootLimit = 24 * 1024
const totalLimit = 32 * 1024
const agentsFiles = execFileSync(
  "git",
  ["ls-files", "AGENTS.md", "**/AGENTS.md"],
  {
    cwd: root,
    encoding: "utf8",
  },
)
  .split("\n")
  .filter(Boolean)
const sizes = new Map(
  agentsFiles.map((file) => [file, readFileSync(join(root, file)).length]),
)
const rootSize = sizes.get("AGENTS.md") ?? 0
if (rootSize > rootLimit)
  failures.push(
    `AGENTS.md is ${rootSize} bytes; the limit is ${rootLimit}. Move text that only some tasks need to a doc behind a pointer, or shorten duplicated text.`,
  )
const folder = (file) => dirname(file).replace(/^\.$/, "")
for (const file of agentsFiles) {
  const chain = agentsFiles.filter((other) => {
    const above = folder(other)
    return (
      above === "" ||
      folder(file) === above ||
      folder(file).startsWith(`${above}/`)
    )
  })
  const total = chain.reduce((sum, other) => sum + (sizes.get(other) ?? 0), 0)
  if (total > totalLimit)
    failures.push(
      `Codex in ${folder(file) || "the repo root"} reads ${chain.join(" + ")} = ${total} bytes; it reads only ${totalLimit}. Shorten one of them.`,
    )
}

// Each MCP config as a map from server name to its url (undefined for stdio).
const jsonServers = (file) =>
  new Map(
    Object.entries(
      JSON.parse(readFileSync(join(root, file), "utf8")).mcpServers ?? {},
    ).map(([name, server]) => [name, server.url]),
  )
const tomlServers = (file) => {
  const servers = new Map()
  let current
  for (const line of readFileSync(join(root, file), "utf8").split("\n")) {
    const header = line.match(/^\s*\[([^\]]*)\]\s*(#.*)?$/)
    if (header) {
      const server = header[1].match(
        /^mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))$/,
      )
      current = server ? (server[1] ?? server[2]) : undefined
      if (current) servers.set(current, undefined)
      continue
    }
    const url = current && line.match(/^\s*url\s*=\s*"([^"]*)"/)
    if (url) servers.set(current, url[1])
  }
  return servers
}
const configs = new Map([
  [".mcp.json", jsonServers(".mcp.json")],
  [".codex/config.toml", tomlServers(".codex/config.toml")],
  [".cursor/mcp.json", jsonServers(".cursor/mcp.json")],
])
const names = new Set(
  [...configs.values()].flatMap((servers) => [...servers.keys()]),
)
for (const name of [...names].sort()) {
  const missing = [...configs]
    .filter(([, servers]) => !servers.has(name))
    .map(([file]) => file)
  if (missing.length > 0)
    failures.push(
      `The MCP server ${name} is missing from ${missing.join(", ")}. Add it, or remove it everywhere.`,
    )
  const urls = [...configs]
    .filter(([, servers]) => servers.get(name) !== undefined)
    .map(([file, servers]) => [file, servers.get(name)])
  if (new Set(urls.map(([, url]) => url)).size > 1)
    failures.push(
      `The MCP server ${name} has different URLs: ${urls.map(([file, url]) => `${file} ${url}`).join(", ")}. Use one URL.`,
    )
}

const skills = realpathSync(join(root, ".agents", "skills"))
for (const link of [".claude/skills", ".cursor/skills"]) {
  const path = join(root, link)
  let ok = false
  try {
    ok = lstatSync(path).isSymbolicLink() && realpathSync(path) === skills
  } catch {}
  if (!ok)
    failures.push(
      `${link} is not a symlink to .agents/skills. Make it one: ln -s ../.agents/skills ${link}`,
    )
}

if (failures.length > 0) {
  console.error(failures.join("\n"))
  process.exit(1)
}
