import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import {
  isGoldenPlaySuccess,
  requiredStories,
  selectGoldenStories,
} from "../ci/storybook-golden-select.mjs"

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

test("required golden stories carry the workspace-golden tag and a play", () => {
  for (const [file, name] of required) {
    const source = readFileSync(
      new URL(`../../${file}`, import.meta.url),
      "utf8",
    )
    const tagged = new RegExp(
      `export const ${name}: Story = \\{[\\s\\S]*?tags: \\["workspace-golden"\\]`,
    )
    const play = new RegExp(
      `export const ${name}: Story = \\{[\\s\\S]*?\\bplay:`,
    )
    assert.match(source, tagged, `${file} ${name} must tag workspace-golden`)
    assert.match(source, play, `${file} ${name} must declare a play function`)
  }
})

test("inventory rejects a tagged required story without play-fn", () => {
  assert.throws(
    () =>
      selectGoldenStories({
        entries: {
          remap: {
            exportName: "FirstMessageSendsOnceInStrictMode",
            tags: ["workspace-golden"],
          },
        },
      }),
    /no play function/,
  )
})

test("inventory accepts only tagged required stories that list play-fn", () => {
  const index = {
    entries: Object.fromEntries(
      requiredStories.map((name) => [
        name,
        { exportName: name, tags: ["workspace-golden", "play-fn"] },
      ]),
    ),
  }
  assert.deepEqual(
    selectGoldenStories(index).map((story) => story.exportName),
    requiredStories,
  )
})

test("only the played phase counts as golden success", () => {
  assert.equal(isGoldenPlaySuccess("played"), true)
  assert.equal(isGoldenPlaySuccess("completed"), false)
  assert.equal(isGoldenPlaySuccess("rendering"), false)
  assert.equal(isGoldenPlaySuccess(undefined), false)
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
  const select = readFileSync(
    new URL("../../scripts/ci/storybook-golden-select.mjs", import.meta.url),
    "utf8",
  )
  assert.match(select, /workspace-golden/)
  assert.match(select, /play-fn/)
  assert.match(runner, /playwright/)
  assert.match(runner, /phase === "played"/)
  assert.doesNotMatch(runner, /phase === "completed"/)
  assert.doesNotMatch(runner, /--retry(?:ies)?(?:=|\s+)/)
  void root
})
