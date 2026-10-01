// Railway list prices. confirm against the Railway billing page.
// checked 2026-09-26 https://railway.com/pricing
// checked 2026-09-26 https://docs.railway.com/reference/pricing
export const railwayCpuUsdPerVcpuMinute = 0.000463
export const railwayMemoryUsdPerGbMinute = 0.000231
export const railwayVolumeUsdPerGbMinute = 0.000003472222222
export const railwayEgressUsdPerGb = 0.05
// Backups bill at the volume rate (GB / minute). checked 2026-09-26 https://docs.railway.com/volumes/backups
export const railwayBackupUsdPerGbMinute = 0.000003472222222

// Neon paid usage-based plans today are Launch, Scale, and Agent (Enterprise is unknown here and must fail).
// Launch, Scale, and Agent have no monthly minimum. confirm against the Neon console billing page.
// checked 2026-09-26 https://neon.com/pricing
// checked 2026-09-26 https://neon.com/docs/introduction/plans
// checked 2026-09-26 https://neon.com/docs/introduction/usage-calculations
export type NeonPlan = keyof typeof neonRates
export const neonRates = {
  launch: {
    computeUsdPerCuHour: 0.106, // no included allowance
    storageUsdPerGbMonth: 0.35, // no included allowance
    instantRestoreUsdPerGbMonth: 0.2, // no included allowance
    snapshotUsdPerGbMonth: 0.09, // no included allowance
    publicTransferUsdPerGb: 0.1,
    publicTransferGbPerProjectMonth: 500,
    privateTransferUsdPerGb: 0.01, // no included allowance; Launch does not sell private networking
    extraBranchUsdPerMonth: 1.5,
    // extra_branches_month is all child branch-hours; free children = branches/project − 1 (root is always included).
    includedChildBranches: 9,
  },
  scale: {
    computeUsdPerCuHour: 0.222, // no included allowance
    storageUsdPerGbMonth: 0.35, // no included allowance
    instantRestoreUsdPerGbMonth: 0.2, // no included allowance
    snapshotUsdPerGbMonth: 0.09, // no included allowance
    publicTransferUsdPerGb: 0.1,
    publicTransferGbPerProjectMonth: 500,
    privateTransferUsdPerGb: 0.01, // no included allowance
    extraBranchUsdPerMonth: 1.5,
    includedChildBranches: 24,
  },
  // Agent: Launch compute, Scale prices otherwise; Agent public-transfer allowance is 100 GB/project (Launch/Scale: 500).
  // included child branches follow Scale (24); usage-calculations only lists 9/24, and Agent's "up to 1,000" is the per-project cap.
  // checked 2026-09-27 https://neon.com/docs/introduction/usage-calculations
  // checked 2026-09-27 https://neon.com/docs/introduction/agent-plan
  // checked 2026-09-27 https://neon.com/docs/introduction/plans
  // checked 2026-09-27 https://neon.com/pricing
  agent: {
    computeUsdPerCuHour: 0.106, // Launch rate; Scale is $0.222
    storageUsdPerGbMonth: 0.35,
    instantRestoreUsdPerGbMonth: 0.2,
    snapshotUsdPerGbMonth: 0.09,
    publicTransferUsdPerGb: 0.1,
    publicTransferGbPerProjectMonth: 100,
    privateTransferUsdPerGb: 0.01,
    extraBranchUsdPerMonth: 1.5,
    includedChildBranches: 24,
  },
}

// Standard storage only. Infrequent Access has no free tier and is not queried here.
// checked 2026-09-27 https://developers.cloudflare.com/r2/pricing
export const cloudflareR2StorageUsdPerGbMonth = 0.015
export const cloudflareR2ClassAUsdPerMillion = 4.5
export const cloudflareR2ClassBUsdPerMillion = 0.36
export const cloudflareR2FreeStorageGbMonth = 10
export const cloudflareR2FreeClassA = 1_000_000
export const cloudflareR2FreeClassB = 10_000_000
