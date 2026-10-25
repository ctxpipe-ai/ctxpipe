import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"

import { withOrgDbContext } from "../db/client.js"
import {
  workspaceKnowledgeChunks,
  workspaceKnowledgeUnits,
  workspaces,
} from "../db/schema/workspaces.js"
import type { HydrateClaim } from "../domain/workspaces/hydrate.js"
import { knowledgeChunkRows } from "../domain/workspaces/knowledge-chunks.js"

/**
 * A small concept embedding: synonyms share one dimension, so a paraphrase
 * is near its source text. Other words fall into hashed noise dimensions.
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
  const vector: number[] = new Array(2000).fill(0)
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

export type SeedUnit = {
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

export async function seedKnowledgeUnits(
  org: string,
  sha: string,
  seed: SeedUnit[],
) {
  await withOrgDbContext(org, async (db) => {
    await db.insert(workspaceKnowledgeUnits).values(
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
    )
    for (const unit of seed) {
      const rows = knowledgeChunkRows(
        [{ servingId: unit.id, body: unit.body, title: unit.title }],
        "fixture-model",
      )
      await db.insert(workspaceKnowledgeChunks).values(
        rows.map((row) => ({
          ...row,
          workspaceId: unit.workspaceId,
          orgId: org,
          embedding: embedText(row.text),
        })),
      )
    }
  })
}
