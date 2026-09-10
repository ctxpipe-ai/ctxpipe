import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../../", import.meta.url))

const required = [
  [
    "apps/ui/src/features/home/HomeComposer.stories.tsx",
    "FirstMessageSendsOnceInStrictMode",
  ],
  [
    "apps/ui/src/features/workspaces/WorkspaceChat.stories.tsx",
    "LateErrorDoesNotClobberSuccess",
  ],
  [
    "apps/ui/src/features/workspaces/WorkspaceChat.stories.tsx",
    "SocketCleansUpOnLeave",
  ],
  [
    "apps/ui/src/features/workspaces/WorkspaceChat.stories.tsx",
    "ReloadReconnects",
  ],
  [
    "apps/ui/src/features/workspaces/WorkspaceChat.stories.tsx",
    "RapidRouteChanges",
  ],
  [
    "apps/ui/src/features/workspaces/WorkspacePane.stories.tsx",
    "EditThenNavigate",
  ],
  [
    "apps/ui/src/features/workspaces/WorkspacePane.stories.tsx",
    "OutOfOrderSaves",
  ],
  [
    "apps/ui/src/features/workspaces/WorkspacePane.stories.tsx",
    "StableFilesRequestBudget",
  ],
  [
    "apps/ui/src/features/workspaces/WorkspaceFileTree.stories.tsx",
    "PierreKeyboardFocus",
  ],
  [
    "apps/ui/src/features/workspaces/WorkspaceSurface.stories.tsx",
    "SharedPublishPending",
  ],
  [
    "apps/ui/src/features/workspaces/WorkspaceSurface.stories.tsx",
    "StableRequestBudget",
  ],
]

test("required golden stories carry the workspace-golden tag", () => {
  for (const [file, name] of required) {
    const source = readFileSync(
      new URL(`../../${file}`, import.meta.url),
      "utf8",
    )
    const tagged = new RegExp(
      `export const ${name}: Story = \\{[\\s\\S]*?tags: \\["workspace-golden"\\]`,
    )
    assert.match(source, tagged, `${file} ${name} must tag workspace-golden`)
  }
})

test("CI requires the Storybook Playwright golden job without retries", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/ci.yaml", import.meta.url),
    "utf8",
  )
  assert.match(workflow, /name: Storybook Playwright golden journey/)
  assert.match(workflow, /node scripts\/ci\/storybook-golden\.mjs/)
  assert.doesNotMatch(workflow, /--retry/)
  const runner = readFileSync(
    new URL("../../scripts/ci/storybook-golden.mjs", import.meta.url),
    "utf8",
  )
  assert.match(runner, /includeTags/)
  assert.match(runner, /workspace-golden/)
  assert.doesNotMatch(runner, /--retry(?:ies)?(?:=|\s+)/)
  void root
})
