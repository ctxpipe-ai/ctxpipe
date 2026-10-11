import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { listWorkspaceKnowledgeUnits } from "../../models/workspaces.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"

// OpenWorkflow keeps each step output in one jsonb value and loads all of
// them on each replay. The markdown bodies must not go into a step output.
it(
  "hydrate keeps each step output small for a large markdown repository",
  { timeout: 120_000 },
  async () => {
    const files = Array.from({ length: 300 }, (_, index) => ({
      path: `knowledge/document-${String(index).padStart(3, "0")}.md`,
      body: `# Document ${index}\n\n${"Body text of a large document. ".repeat(320)}\n`,
    }))
    const total = files.reduce((sum, file) => sum + file.body.length, 0)
    expect(total).toBeGreaterThan(2_000_000)
    await withNativeHydrationFixture({ files }, async (f) => {
      await f.publish()
      await withOrgIdContext(f.org, async () => {
        expect(
          (await listWorkspaceKnowledgeUnits(f.workspaceId)).units
            .map(({ path, body }) => ({ path, body }))
            .sort((a, b) => a.path.localeCompare(b.path)),
        ).toEqual(f.expected)
      })
      const steps = (
        await f.backend.listStepAttempts({
          workflowRunId: f.handle.workflowRun.id,
          limit: 1000,
        })
      ).data
      expect(steps.length).toBeGreaterThan(0)
      const sizes = steps.map((step) => ({
        name: step.stepName,
        bytes: JSON.stringify(step.output ?? null).length,
      }))
      expect(sizes.filter((step) => step.bytes > 100_000)).toEqual([])
    })
  },
)
