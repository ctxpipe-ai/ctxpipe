/**
 * PROTOTYPE, throwaway (see prototype-variant.ts). Workspace settings on the
 * real Workspace page, one story for each scenario. The bar at the bottom
 * (or Alt + ← →) cycles: Current page, A, B, C. The variant is a story arg,
 * so the URL keeps it (`&args=variant:B`), and the last choice carries to the
 * next scenario.
 */
import type { Decorator, Meta, StoryObj } from "@storybook/react-vite"
import { Toaster } from "sonner"
import { useArgs } from "storybook/preview-api"

import { orgPageDecorators } from "../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import { WorkspaceSurface } from "../WorkspaceSurface"
import {
  SETTINGS_VARIANTS,
  SettingsPrototypeContext,
  type SettingsVariantKey,
} from "./prototype-variant"
import { PrototypeSwitcher } from "./PrototypeSwitcher"
import { ORG, type Scenario, scenarioMsw, scenarios, WS } from "./scenarios"

const STORAGE_KEY = "ctxpipe-prototype-settings-variant"

function storedVariant(): SettingsVariantKey {
  const stored =
    typeof localStorage === "undefined"
      ? null
      : localStorage.getItem(STORAGE_KEY)
  return SETTINGS_VARIANTS.find((variant) => variant.key === stored)?.key ?? "A"
}

type PrototypeArgs = {
  orgSlug: string
  workspaceSlug: string
  paneParam: string
  variant: SettingsVariantKey
}

const withVariant: Decorator = function WithVariant(Story, context) {
  const [args, updateArgs] = useArgs<PrototypeArgs>()
  const scenario = (context.parameters.scenario as Scenario | undefined) ?? {
    name: "",
    about: "",
  }
  const variant = args.variant ?? "A"
  return (
    <SettingsPrototypeContext.Provider value={variant}>
      <Story />
      <Toaster position="top-center" theme="dark" />
      <PrototypeSwitcher
        current={variant}
        scenario={scenario}
        onChange={(key) => {
          localStorage.setItem(STORAGE_KEY, key)
          updateArgs({ variant: key })
        }}
      />
    </SettingsPrototypeContext.Provider>
  )
}

const meta = {
  title: "Pages/Prototype/Workspace settings",
  component: WorkspaceSurface,
  decorators: [withVariant, ...orgPageDecorators],
  parameters: {
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: ORG,
      workspaceSlug: WS,
      pane: "settings",
    } satisfies StoryRouteParams,
  },
  argTypes: {
    variant: {
      control: "inline-radio",
      options: SETTINGS_VARIANTS.map((variant) => variant.key),
    },
  },
  args: {
    orgSlug: ORG,
    workspaceSlug: WS,
    paneParam: "settings",
    variant: storedVariant(),
  },
} satisfies Meta<PrototypeArgs>

export default meta

type Story = StoryObj<typeof meta>

function scenarioStory(scenario: Scenario): Story {
  return {
    name: scenario.name,
    parameters: {
      scenario,
      docs: { description: { story: scenario.about } },
      msw: { handlers: scenarioMsw(scenario) },
    },
  }
}

export const BusyDay = scenarioStory(scenarios.busyDay)
export const UpToDate = scenarioStory(scenarios.upToDate)
export const ReingestRunning = scenarioStory(scenarios.reingestRunning)
export const MergePullRequest = scenarioStory(scenarios.mergePullRequest)
export const UpgradeFailed = scenarioStory(scenarios.upgradeFailed)
export const ReadOnly = scenarioStory(scenarios.readOnly)
export const ChangesByPullRequest = scenarioStory(
  scenarios.changesByPullRequest,
)
export const WriteCheckFailed = scenarioStory(scenarios.writeCheckFailed)
export const GraphProblems = scenarioStory(scenarios.graphProblems)
export const RepositoryMoving = scenarioStory(scenarios.repositoryMoving)
export const LongHistory = scenarioStory(scenarios.longHistory)
export const MemberView = scenarioStory(scenarios.memberView)
export const Loading = scenarioStory(scenarios.loading)
export const LoadErrors = scenarioStory(scenarios.loadErrors)
