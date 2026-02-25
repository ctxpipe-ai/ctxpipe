export type Repository = {
  id: string
  orgId: string
  zoektRepoId: number
  name: string
  gitUrl: string
  indexReady: boolean
  lastIngestedHash: string | null
  createdAt: string
  updatedAt: string
}
