import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const DOCS = "apps/docs/content/docs"

const BASE = {
  [`${DOCS}/(guide)/getting-started/index.mdx`]:
    "---\ntitle: Start\n---\n\n## Who it is for\n\nText.\n",
  [`${DOCS}/(guide)/workspaces/settings.mdx`]:
    "---\ntitle: Settings\n---\n\n## The `Status` group\n\n## Upgrades\n\n## Upgrades\n",
  [`${DOCS}/self-hosting/(configuration)/configuration.mdx`]:
    "---\ntitle: Configuration\n---\n\n## Chat sandboxes\n",
  [`${DOCS}/(guide)/mcp/plugin.mdx`]:
    "---\ntitle: Plugin\ndraft: true\n---\n\nDraft.\n",
  "apps/docs/public/launch.gif": "GIF89a",
}

function check(files) {
  const root = mkdtempSync(join(tmpdir(), "ctxpipe-docs-links-"))
  try {
    for (const [name, text] of Object.entries({ ...BASE, ...files })) {
      mkdirSync(dirname(join(root, name)), { recursive: true })
      writeFileSync(join(root, name), text)
    }
    return spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("../ci/check-docs-links.mjs", import.meta.url)),
        root,
      ],
      { encoding: "utf8" },
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function page(body) {
  return {
    [`${DOCS}/(guide)/workspaces/chat.mdx`]: `---\ntitle: Chat\n---\n\n${body}\n`,
  }
}

test("links to pages, headings, and images that exist pass", () => {
  const result = check(
    page(
      [
        "See [Start](/docs/getting-started#who-it-is-for).",
        "See [Status](/docs/workspaces/settings#the-status-group).",
        "See [the second one](/docs/workspaces/settings#upgrades-1).",
        "See [sandboxes](/docs/self-hosting/configuration#chat-sandboxes).",
        "See [the Markdown copy](/docs/workspaces/settings.mdx).",
        '<Card href="/docs/workspaces/settings" title="Settings" />',
        '<ImageSlot src="/launch.gif" alt="Launch" />',
        "## Local heading",
        "Go [up](#local-heading).",
        "Read https://docs.ctxpipe.ai/docs/getting-started.",
      ].join("\n\n"),
    ),
  )
  assert.equal(result.status, 0, result.stderr)
})

test("a link to a missing page fails with the file and the line", () => {
  const result = check(page("Text.\n\nSee [gone](/docs/workspaces/gone)."))
  assert.equal(result.status, 1)
  assert.match(
    result.stderr,
    /\(guide\)\/workspaces\/chat\.mdx:7: \/docs\/workspaces\/gone: no such page/,
  )
})

test("a link to a missing heading fails", () => {
  const result = check(page("See [x](/docs/workspaces/settings#nothing)."))
  assert.equal(result.status, 1)
  assert.match(result.stderr, /#nothing: no such heading/)
})

test("a same-page link to a missing heading fails", () => {
  const result = check(page("Go [up](#nowhere)."))
  assert.equal(result.status, 1)
  assert.match(result.stderr, /#nowhere: no such heading/)
})

test("a link inside a code block or inline code is not checked", () => {
  const result = check(
    page(
      "```md\n[x](/docs/workspaces/gone)\n```\n\nWrite `[x](/docs/nothing)`.",
    ),
  )
  assert.equal(result.status, 0, result.stderr)
})

test("a link to a draft page fails", () => {
  const result = check(page("See [plugin](/docs/mcp/plugin)."))
  assert.equal(result.status, 1)
  assert.match(result.stderr, /\/docs\/mcp\/plugin: the page is a draft/)
})

test("a missing image fails", () => {
  const result = check(page('<ImageSlot src="/missing.png" alt="x" />'))
  assert.equal(result.status, 1)
  assert.match(
    result.stderr,
    /\/missing\.png: no such file in apps\/docs\/public/,
  )
})

test("a docs URL in app code or a README must name a page", () => {
  const result = check({
    "apps/ui/src/a.tsx": [
      // The fixture is TS source text, so the `$` and `{` stay apart here.
      "const ok = `$" + "{DOCS_URL}/docs/workspaces/settings#upgrades`",
      'const bad = "https://docs.ctxpipe.ai/docs/connections/gone"',
    ].join("\n"),
    "packages/cli/README.md":
      "See [docs](https://docs.ctxpipe.ai/docs/getting-started).\n",
  })
  assert.equal(result.status, 1)
  assert.match(
    result.stderr,
    /apps\/ui\/src\/a\.tsx:2: \/docs\/connections\/gone: no such page/,
  )
  assert.doesNotMatch(result.stderr, /a\.tsx:1/)
  assert.doesNotMatch(result.stderr, /README/)
})
