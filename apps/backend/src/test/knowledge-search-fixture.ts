import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"

import type { SeededOrg } from "../../test/db.js"
import { withOrgDbContext } from "../db/client.js"
import { workspaceKnowledgeUnits, workspaces } from "../db/schema/workspaces.js"
import type { HydrateClaim } from "../domain/workspaces/hydrate.js"
import type { WorkspaceRevision } from "../domain/workspaces/revision.js"

/**
 * A small concept embedding with the 1024 dimensions of the knowledge plane:
 * synonyms share one dimension, so a paraphrase is near its source text.
 * Other words fall into hashed noise dimensions.
 */
const CONCEPTS: Record<string, number> = {
  outage: 0,
  downtime: 0,
  unavailable: 0,
  broken: 0,
  release: 1,
  deploy: 1,
  ship: 1,
}

export function embedText(text: string): number[] {
  const vector: number[] = new Array(1024).fill(0)
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    const concept = CONCEPTS[word]
    if (concept !== undefined) {
      vector[concept] = (vector[concept] ?? 0) + 5
      continue
    }
    let hash = 0
    for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
    const dim = 8 + (hash % 56)
    vector[dim] = (vector[dim] ?? 0) + 1
  }
  if (!vector.some((value) => value !== 0)) vector[63] = 1
  return vector
}

/** An msw server for the embeddings endpoint of `MODEL_PROVIDER_URL=https://search-model.test/v1`. */
export function embeddingModelServer(requests: string[] = []) {
  return setupServer(
    http.post(
      "https://search-model.test/v1/embeddings",
      async ({ request }) => {
        const body = (await request.json()) as { input: string[] }
        requests.push(...body.input)
        return HttpResponse.json({
          data: body.input.map((text, index) => ({
            index,
            embedding: embedText(text),
          })),
        })
      },
    ),
  )
}

type SeedUnit = {
  id: string
  workspaceId: string
  path: string
  kind?: string
  title: string
  source?: string | null
  updatedAt: string
  body: string
  claims?: Array<Partial<HydrateClaim>>
}

export async function seedKnowledgeWorkspace(
  org: string,
  id: string,
  sha: string,
) {
  await withOrgDbContext(org, (db) =>
    db.insert(workspaces).values({
      id,
      orgId: org,
      slug: id,
      displayName: "Knowledge search fixture",
      workspaceRepositoryUrl: `https://github.com/example/${id}`,
      activeProjectionSha: sha,
    }),
  )
}

/** The unit rows of the projection in Postgres (`workspace_knowledge_units`). */
export async function seedKnowledgeUnits(
  org: string,
  sha: string,
  seed: SeedUnit[],
) {
  await withOrgDbContext(org, (db) =>
    db.insert(workspaceKnowledgeUnits).values(
      seed.map((unit) => ({
        servingId: unit.id,
        orgId: org,
        workspaceId: unit.workspaceId,
        path: unit.path,
        kind: unit.kind ?? null,
        title: unit.title,
        source: unit.source ?? null,
        body: unit.body,
        projectionSha: sha,
        updatedAt: new Date(unit.updatedAt),
        claims: (unit.claims ?? []).map((claim) => ({
          to: "unit_elsewhere",
          predicate: "supersedes",
          confidence: null,
          validFrom: null,
          validTo: null,
          source: null,
          ...claim,
        })),
      })),
    ),
  )
}

/**
 * A Workspace with an active revision of `sha` and a ready index. The
 * knowledge plane serves it after a test writes its documents and completes
 * a knowledge run (`writePlaneDocuments`, `completeKnowledgeRun`).
 */
export async function seedServedWorkspace(input: {
  seed: Pick<SeededOrg, "orgId">
  slug: string
  sha: string
}): Promise<{ workspaceId: string; revision: WorkspaceRevision }> {
  const { seed, slug, sha } = input
  const workspaceId = `ws_served_${slug}_${Date.now().toString(36)}`
  const url = `https://git.example.test/acme/${slug}.git`
  const revision: WorkspaceRevision = {
    workspaceId,
    generation: 1,
    remote: { url, connectionId: null },
    defaultBranch: "main",
    sha,
    access: "read",
  }
  await withOrgDbContext(seed.orgId, (db) =>
    db.insert(workspaces).values({
      id: workspaceId,
      orgId: seed.orgId,
      slug,
      displayName: `Fixture ${slug}`,
      workspaceRepositoryUrl: url,
      desiredDefaultBranch: "main",
      activeProjectionSha: sha,
      activeRevision: revision,
      hydratePhases: {
        url,
        sha,
        revision,
        index: { revision, result: { kind: "ready" } },
      },
    }),
  )
  return { workspaceId, revision }
}
