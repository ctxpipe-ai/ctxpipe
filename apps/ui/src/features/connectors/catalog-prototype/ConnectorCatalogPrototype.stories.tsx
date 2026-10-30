/**
 * PROTOTYPE, throwaway. Lives only on branch prototype/connector-catalog.
 * Do not merge into main.
 *
 * Question (CTX-1078): what should "Add connection" look like with 10+
 * connectors? The real Connectors page, one story for each scenario. The
 * play opens the catalog. The bar at the bottom (or Alt + ← →) cycles:
 * Current dialog, A, B, C. The variant is a story arg, so the URL keeps it
 * (`&args=variant:B`), and the last choice carries to the next scenario.
 */
import type { Decorator, Meta, StoryObj } from "@storybook/react-vite"
import { Toaster } from "sonner"
import { useArgs } from "storybook/preview-api"
import { expect, userEvent, waitFor, within } from "storybook/test"

import { orgPageDecorators } from "../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import { ConnectorsPageContent } from "../../../routes/$orgSlug.connectors"
import {
  CATALOG_VARIANTS,
  CatalogPrototypeContext,
  type CatalogVariantKey,
} from "./prototype-variant"
import { PrototypeSwitcher } from "./PrototypeSwitcher"
import { ORG, type Scenario, scenarioMsw, scenarios } from "./scenarios"

const STORAGE_KEY = "ctxpipe-prototype-catalog-variant"

function storedVariant(): CatalogVariantKey {
  const stored =
    typeof localStorage === "undefined"
      ? null
      : localStorage.getItem(STORAGE_KEY)
  return CATALOG_VARIANTS.find((variant) => variant.key === stored)?.key ?? "A"
}

type PrototypeArgs = { variant: CatalogVariantKey }

const withVariant: Decorator = function WithVariant(Story, context) {
  const [args, updateArgs] = useArgs<PrototypeArgs>()
  const scenario = context.parameters.scenario as Scenario
  const variant = args.variant ?? "A"
  return (
    <CatalogPrototypeContext.Provider
      value={{ variant, facts: scenario.facts }}
    >
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
    </CatalogPrototypeContext.Provider>
  )
}

const meta = {
  title: "Pages/Prototype/Connector catalog",
  render: () => <ConnectorsPageContent orgSlug={ORG} />,
  decorators: [withVariant, ...orgPageDecorators],
  parameters: {
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgConnectors",
      orgSlug: ORG,
    } satisfies StoryRouteParams,
  },
  argTypes: {
    variant: {
      control: "inline-radio",
      options: CATALOG_VARIANTS.map((variant) => variant.key),
    },
  },
  args: { variant: storedVariant() },
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
    play: async ({ canvasElement }) => {
      const body = within(canvasElement.ownerDocument.body)
      // The story router renders its first route after an async load.
      await waitFor(
        () =>
          expect(
            body.getByRole("button", { name: "Add connection" }),
          ).toBeEnabled(),
        { timeout: 15_000 },
      )
      await userEvent.click(
        body.getByRole("button", { name: "Add connection" }),
      )
      await waitFor(() =>
        expect(
          body.getByRole("heading", { name: "Add connection" }),
        ).toBeVisible(),
      )
    },
  }
}

export const NewOrg = scenarioStory(scenarios.newOrg)
export const BusyOrg = scenarioStory(scenarios.busyOrg)
export const SelfHost = scenarioStory(scenarios.selfHost)
