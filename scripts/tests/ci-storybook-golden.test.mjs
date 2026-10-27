import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import {
  isGoldenPlaySuccess,
  requiredStories,
  selectGoldenStories,
  selectPlayStories,
  shardStories,
} from "../ci/storybook-golden-select.mjs"

const root = fileURLToPath(new URL("../../", import.meta.url))

const required = [
  [
    "apps/ui/src/features/workspaces/WorkspaceChat.stories.tsx",
    "LateErrorDoesNotClobberSuccess",
  ],
  [
    "apps/ui/src/features/workspaces/WorkspaceChat.stories.tsx",
    "FirstTurnStreamsLive",
  ],
  [
    "apps/ui/src/features/workspaces/WorkspaceChat.stories.tsx",
    "FirstTurnFailureRestoresDraft",
  ],
  [
    "apps/ui/src/features/workspaces/WorkspaceChat.stories.tsx",
    "FollowUpShowsSandboxSetupFirst",
  ],
  [
    "apps/ui/src/features/workspaces/WorkspaceChat.stories.tsx",
    "LogKeepsStreamOrder",
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
    "apps/ui/src/features/workspaces/WorkspaceFileTree.stories.tsx",
    "DeletedFileStaysUntilMerged",
  ],
  [
    "apps/ui/src/features/workspaces/WorkspaceFileTree.stories.tsx",
    "ChangeMarkers",
  ],
  [
    "apps/ui/src/features/workspaces/WorkspaceChatChrome.stories.tsx",
    "CtaButtonStyle",
  ],
  [
    "apps/ui/src/features/workspaces/WorkspaceChatChrome.stories.tsx",
    "BranchLabel",
  ],
  [
    "apps/ui/src/features/workspaces/WorkspaceChatChrome.stories.tsx",
    "SyncCtaWithSubtleShowPr",
  ],
  [
    "apps/ui/src/features/workspaces/WorkspaceChatChrome.stories.tsx",
    "DirtyShowsOnlySync",
  ],
  [
    "apps/ui/src/features/chat/ConversationThread.stories.tsx",
    "PushEntryUnderCard",
  ],
  [
    "apps/ui/src/features/workspaces/WorkspaceSurface.stories.tsx",
    "PublishPrErrorToast",
  ],
  [
    "apps/ui/src/features/workspaces/WorkspaceSurface.stories.tsx",
    "DiffTriggerNoChanges",
  ],
  [
    "apps/ui/src/features/workspaces/WorkspaceSurface.stories.tsx",
    "PaneTabsStayInPlace",
  ],
  [
    "apps/ui/src/features/workspaces/WorkspacePane.stories.tsx",
    "TextTabsKeepPadding",
  ],
  [
    "apps/ui/src/features/workspaces/ConversationTitleButton.stories.tsx",
    "UneditedSaveKeepsAutomaticTitle",
  ],
  [
    "apps/ui/src/features/workspaces/ConversationTitleButton.stories.tsx",
    "EscapeReturnsFocus",
  ],
  [
    "apps/ui/src/features/workspaces/WorkspaceSurface.stories.tsx",
    "SharedPublishPending",
  ],
  [
    "apps/ui/src/features/workspaces/WorkspaceSurface.stories.tsx",
    "StableRequestBudget",
  ],
  [
    "apps/ui/src/features/workspaces/WorkspaceSurface.stories.tsx",
    "SyncAddsThreadEntry",
  ],
  [
    "apps/ui/src/features/workspaces/ConversationSyncEntry.stories.tsx",
    "SyncEntry",
  ],
  [
    "apps/ui/src/features/workspaces/ConversationSyncEntry.stories.tsx",
    "CreatePrEntry",
  ],
  [
    "apps/ui/src/features/workspaces/ConversationSyncEntry.stories.tsx",
    "ExistingPrEntry",
  ],
  [
    "apps/ui/src/features/workspaces/ConversationSyncEntry.stories.tsx",
    "CreatePrWithoutPrEntry",
  ],
  [
    "apps/ui/src/features/workspaces/ConversationSyncEntry.stories.tsx",
    "AgentPushEntry",
  ],
  [
    "apps/ui/src/features/workspaces/ConversationSyncEntry.stories.tsx",
    "SweepPushEntry",
  ],
  [
    "apps/ui/src/components/ui/LoadingIndicators.stories.tsx",
    "LoadingUnderReducedMotion",
  ],
  ["apps/ui/src/routes/-onboarding.stories.tsx", "DoubleClickMovesOneSlide"],
  [
    "apps/ui/src/features/chat/ConversationThread.stories.tsx",
    "ChatProgressDone",
  ],
  [
    "apps/ui/src/features/chat/ConversationThread.stories.tsx",
    "ChatProgressLogExpanded",
  ],
  [
    "apps/ui/src/features/chat/ConversationThread.stories.tsx",
    "ChatProgressSpacing",
  ],
  [
    "apps/ui/src/features/chat/ConversationThread.stories.tsx",
    "OpeningLogKeepsScroll",
  ],
  [
    "apps/ui/src/features/workspaces/WorkspaceCommandPalette.stories.tsx",
    "PaletteShortcutTogglesAndRestoresFocus",
  ],
  [
    "apps/ui/src/features/workspaces/WorkspaceCommandPalette.stories.tsx",
    "PaletteFiltersAtOnce",
  ],
  [
    "apps/ui/src/features/workspaces/WorkspaceCommandPalette.stories.tsx",
    "PaletteArrowKeysAndEnterKeepPane",
  ],
  [
    "apps/ui/src/features/workspaces/WorkspaceCommandPalette.stories.tsx",
    "PaletteEscapeClearsThenCloses",
  ],
  [
    "apps/ui/src/features/workspaces/WorkspaceCommandPalette.stories.tsx",
    "PaletteNoResults",
  ],
  [
    "apps/ui/src/features/workspaces/WorkspaceCommandPalette.stories.tsx",
    "PaletteLoadingKeepsPages",
  ],
  [
    "apps/ui/src/features/workspaces/WorkspaceCommandPalette.stories.tsx",
    "PaletteSkeletonHandsOverOnce",
  ],
  [
    "apps/ui/src/features/workspaces/WorkspaceCommandPalette.stories.tsx",
    "PaletteArrowKeysWalkEveryItem",
  ],
  [
    "apps/ui/src/features/workspaces/WorkspaceCommandPalette.stories.tsx",
    "PaletteHoverAndKeysShareOneHighlight",
  ],
  [
    "apps/ui/src/features/workspaces/WorkspaceCommandPalette.stories.tsx",
    "PaletteEnterAfterDeleteRunsFirstMatch",
  ],
  [
    "apps/ui/src/features/workspaces/WorkspaceCommandPalette.stories.tsx",
    "PaletteShortcutClosesAfterSyncRender",
  ],
  [
    "apps/ui/src/features/workspaces/WorkspaceSurface.stories.tsx",
    "DeleteWorkspaceShowsNoError",
  ],
  [
    "apps/ui/src/features/workspaces/WorkspaceSurface.stories.tsx",
    "DeleteLastWorkspaceShowsNoError",
  ],
  [
    "apps/ui/src/features/workspaces/WorkspaceSurface.stories.tsx",
    "DeleteFromConversationShowsNoError",
  ],
  [
    "apps/ui/src/features/workspaces/WorkspaceFileTree.stories.tsx",
    "NewPathsKeepExpandedFolders",
  ],
  [
    "apps/ui/src/features/workspaces/WorkspacePane.stories.tsx",
    "DefaultBranchUntilSandboxReady",
  ],
  ["apps/ui/src/routes/-home.stories.tsx", "Loading"],
  ["apps/ui/src/routes/-home.stories.tsx", "WorkspacesLoading"],
  ["apps/ui/src/routes/-home.stories.tsx", "Empty"],
  ["apps/ui/src/routes/-home.stories.tsx", "Populated"],
  ["apps/ui/src/routes/-home.stories.tsx", "ActivityLoading"],
  ["apps/ui/src/routes/-home.stories.tsx", "FirstMessageOpensConversation"],
  ["apps/ui/src/routes/-home.stories.tsx", "NoHistory"],
]

test("required golden stories carry the workspace-golden tag and a play", () => {
  for (const [file, name] of required) {
    const source = readFileSync(
      new URL(`../../${file}`, import.meta.url),
      "utf8",
    )
    const tagged = new RegExp(
      `export const ${name}: Story = \\{[\\s\\S]*?tags: \\["workspace-golden"[\\],]`,
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
            exportName: "LateErrorDoesNotClobberSuccess",
            tags: ["workspace-golden"],
          },
        },
      }),
    /no play function/,
  )
})

test("inventory rejects two tagged stories with one name", () => {
  assert.throws(
    () =>
      selectGoldenStories({
        entries: {
          home: {
            exportName: "Loading",
            tags: ["workspace-golden", "play-fn"],
          },
          other: {
            exportName: "Loading",
            tags: ["workspace-golden", "play-fn"],
          },
        },
      }),
    /More than one golden story is named Loading/,
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
  // storybook-golden.mjs plays the stories with storybook-play.mjs.
  const runner = readFileSync(
    new URL("../../scripts/ci/storybook-play.mjs", import.meta.url),
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

test("the all-plays selection keeps every story with a play function, sorted", () => {
  const index = {
    entries: {
      b: { id: "b", type: "story", tags: ["play-fn"] },
      a: { id: "a", type: "story", tags: ["play-fn", "workspace-golden"] },
      c: { id: "c", type: "story", tags: [] },
      d: { id: "d", type: "docs", tags: ["play-fn"] },
    },
  }
  assert.deepEqual(
    selectPlayStories(index).map((story) => story.id),
    ["a", "b"],
  )
})

test("shards cover every story exactly once", () => {
  const stories = Array.from({ length: 10 }, (_, at) => ({ id: `s${at}` }))
  const shards = [1, 2, 3].map((at) => shardStories(stories, `${at}/3`))
  assert.deepEqual(
    shards
      .flat()
      .map((story) => story.id)
      .sort(),
    stories.map((story) => story.id).sort(),
  )
  assert.equal(shardStories(stories, undefined), stories)
  assert.throws(() => shardStories(stories, "0/3"))
  assert.throws(() => shardStories(stories, "4/3"))
  assert.throws(() => shardStories(stories, "x"))
})

test("CI runs every story with a play function in shards", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/ci.yaml", import.meta.url),
    "utf8",
  )
  assert.match(workflow, /name: Storybook Playwright all plays/)
  assert.match(workflow, /STORYBOOK_PLAYS: all/)
  assert.match(workflow, /SKIP_STORYBOOK_BUILD: "1"/)
  assert.match(
    workflow,
    /name: Storybook build\n(?:.*\n)*? {4}runs-on: blacksmith-4vcpu-ubuntu-2404/,
  )
  assert.match(workflow, /STORYBOOK_SHARD: \$\{\{ matrix\.shard \}\}\/4/)
})

test("every required golden story is exported with the workspace-golden tag", () => {
  const sources = execFileSync(
    "git",
    ["ls-files", "apps/ui/src/**/*.stories.tsx"],
    { cwd: root, encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean)
    .map((file) =>
      readFileSync(new URL(`../../${file}`, import.meta.url), "utf8"),
    )
  for (const name of requiredStories) {
    const tagged = new RegExp(
      `export const ${name}: Story = \\{[\\s\\S]*?tags: \\["workspace-golden"[\\],]`,
    )
    assert.ok(
      sources.some((source) => tagged.test(source)),
      `${name} is required but no story file exports it with workspace-golden`,
    )
  }
})

test("a failed run exits at once instead of waiting on the open server", () => {
  const runner = readFileSync(
    new URL("../ci/storybook-golden.mjs", import.meta.url),
    "utf8",
  )
  assert.match(runner, /catch \(error\) \{[\s\S]*process\.exit\(1\)/)
})

test("every script that ci.yaml runs for a Storybook job is a Storybook check input", async () => {
  const { inputs } = await import("../checks/storybook.mjs")
  const workflow = readFileSync(join(root, ".github/workflows/ci.yaml"), "utf8")
  const scripts = new Set(
    [...workflow.matchAll(/node (scripts\/ci\/storybook[\w-]*\.mjs)/g)].map(
      (match) => match[1],
    ),
  )
  assert.ok(scripts.size > 0)
  for (const script of scripts) assert.ok(inputs.includes(script), script)
})

test("every scripts/ci file that the golden runner reads at run time is a Storybook check input", async () => {
  const { inputs } = await import("../checks/storybook.mjs")
  const runner = readFileSync(
    join(root, "scripts/ci/storybook-golden.mjs"),
    "utf8",
  )
  const paths = new Set(
    [...runner.matchAll(/"(scripts\/ci\/[\w./-]+\.(?:mjs|json))"/g)].map(
      (match) => match[1],
    ),
  )
  assert.ok(paths.has("scripts/ci/failures/storybook-golden.json"))
  for (const path of paths) assert.ok(inputs.includes(path), path)
})
