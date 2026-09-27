import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from "bun:test"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { neonRates } from "../rates"
import { utcDays } from "../rows"
import { useEnv } from "../test-env"
import { rows } from "./neon"

const DAY = "2026-02-04"
const PROJECT = "delicate-dawn-54854667"
const launch = neonRates.launch
const scale = neonRates.scale

const server = setupServer()
useEnv({ NEON_API_KEY: "neon-key", NEON_ORG_ID: "org-ctxpipe" })

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" })
})
afterEach(() => {
  setSystemTime()
  server.resetHandlers()
})
afterAll(() => {
  server.close()
})

describe("neon rows", () => {
  test("maps daily consumption, converts units, and skips zeros", async () => {
    server.use(
      http.get("https://console.neon.tech/api/v2/consumption_history/v2/projects", ({ request }) => {
        const url = new URL(request.url)
        expect(url.searchParams.get("org_id")).toBe("org-ctxpipe")
        expect(url.searchParams.get("from")).toBe("2026-02-01T00:00:00.000Z")
        expect(url.searchParams.get("to")).toBe("2026-02-05T00:00:00.000Z")
        expect(url.searchParams.get("granularity")).toBe("daily")
        expect(url.searchParams.get("metrics")).toBe(
          "compute_unit_seconds,root_branch_bytes_month,child_branch_bytes_month,instant_restore_bytes_month,snapshot_storage_bytes_month,public_network_transfer_bytes,private_network_transfer_bytes,extra_branches_month",
        )
        expect(url.searchParams.get("limit")).toBe("100")
        expect(url.searchParams.get("cursor")).toBeNull()
        expect(request.headers.get("Authorization")).toBe("Bearer neon-key")
        return HttpResponse.json({
          projects: [
            {
              project_id: PROJECT,
              name: "prod-db",
              periods: [
                {
                  period_plan: "launch",
                  consumption: [
                    {
                      timeframe_start: "2026-02-04T00:00:00Z",
                      timeframe_end: "2026-02-05T00:00:00Z",
                      metrics: [
                        { metric_name: "compute_unit_seconds", value: 3600 },
                        { metric_name: "root_branch_bytes_month", value: 1_000_000_000 },
                        { metric_name: "child_branch_bytes_month", value: 500_000_000 },
                        { metric_name: "instant_restore_bytes_month", value: 200_000_000 },
                        { metric_name: "snapshot_storage_bytes_month", value: 100_000_000 },
                        { metric_name: "public_network_transfer_bytes", value: 2_000_000_000 },
                        { metric_name: "extra_branches_month", value: 744 },
                        { metric_name: "private_network_transfer_bytes", value: 0 },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        })
      }),
    )
    const extraBranchHours = 744 - launch.includedChildBranches * 24
    await expect(rows([DAY])).resolves.toEqual([
      {
        day: DAY,
        provider: "neon",
        sku: "compute",
        scope: "prod-db",
        usage: 1,
        unit: "cu_hour",
        costUsd: 1 * launch.computeUsdPerCuHour,
        source: "estimated",
      },
      {
        day: DAY,
        provider: "neon",
        sku: "storage_root",
        scope: "prod-db",
        usage: 1,
        unit: "gb_month",
        costUsd: 1 * launch.storageUsdPerGbMonth,
        source: "estimated",
      },
      {
        day: DAY,
        provider: "neon",
        sku: "storage_child",
        scope: "prod-db",
        usage: 0.5,
        unit: "gb_month",
        costUsd: 0.5 * launch.storageUsdPerGbMonth,
        source: "estimated",
      },
      {
        day: DAY,
        provider: "neon",
        sku: "instant_restore",
        scope: "prod-db",
        usage: 0.2,
        unit: "gb_month",
        costUsd: 0.2 * launch.instantRestoreUsdPerGbMonth,
        source: "estimated",
      },
      {
        day: DAY,
        provider: "neon",
        sku: "snapshot",
        scope: "prod-db",
        usage: 0.1,
        unit: "gb_month",
        costUsd: 0.1 * launch.snapshotUsdPerGbMonth,
        source: "estimated",
      },
      {
        day: DAY,
        provider: "neon",
        sku: "extra_branches",
        scope: "prod-db",
        usage: extraBranchHours / 744,
        unit: "branch_month",
        costUsd: (extraBranchHours / 744) * launch.extraBranchUsdPerMonth,
        source: "estimated",
      },
    ])
  })

  test("pages with cursor and falls back to the project id", async () => {
    const cursors: (string | null)[] = []
    server.use(
      http.get("https://console.neon.tech/api/v2/consumption_history/v2/projects", ({ request }) => {
        const cursor = new URL(request.url).searchParams.get("cursor")
        cursors.push(cursor)
        if (!cursor) {
          return HttpResponse.json({
            projects: [project(PROJECT, undefined, [{ metric_name: "compute_unit_seconds", value: 7200 }])],
            pagination: { cursor: PROJECT },
          })
        }
        return HttpResponse.json({
          projects: [project("other-project", undefined, [{ metric_name: "compute_unit_seconds", value: 3600 }])],
        })
      }),
    )
    const result = await rows([DAY])
    expect(cursors).toEqual([null, PROJECT])
    expect(result).toEqual([
      {
        day: DAY,
        provider: "neon",
        sku: "compute",
        scope: PROJECT,
        usage: 2,
        unit: "cu_hour",
        costUsd: 2 * launch.computeUsdPerCuHour,
        source: "estimated",
      },
      {
        day: DAY,
        provider: "neon",
        sku: "compute",
        scope: "other-project",
        usage: 1,
        unit: "cu_hour",
        costUsd: 1 * launch.computeUsdPerCuHour,
        source: "estimated",
      },
    ])
  })

  test("queries from the 1st of the earliest window month", async () => {
    setSystemTime(new Date("2026-09-26T12:00:00.000Z"))
    let from = ""
    let to = ""
    server.use(
      http.get("https://console.neon.tech/api/v2/consumption_history/v2/projects", ({ request }) => {
        const url = new URL(request.url)
        from = url.searchParams.get("from") ?? ""
        to = url.searchParams.get("to") ?? ""
        return HttpResponse.json({ projects: [] })
      }),
    )
    await expect(rows(utcDays(Date.now(), 3))).resolves.toEqual([])
    expect(from).toBe("2026-09-01T00:00:00.000Z")
    expect(to).toBe("2026-09-27T00:00:00.000Z")
  })

  test("charges only the part of a window day above the remaining public-transfer allowance", async () => {
    server.use(
      http.get("https://console.neon.tech/api/v2/consumption_history/v2/projects", () =>
        HttpResponse.json({
          projects: [
            projectDays("launch", [
              { day: "2026-02-01", metrics: [{ metric_name: "public_network_transfer_bytes", value: 400_000_000_000 }] },
              { day: DAY, metrics: [{ metric_name: "public_network_transfer_bytes", value: 150_000_000_000 }] },
            ]),
          ],
        }),
      ),
    )
    await expect(rows([DAY])).resolves.toEqual([
      {
        day: DAY,
        provider: "neon",
        sku: "egress",
        scope: "prod-db",
        usage: 50,
        unit: "GB",
        costUsd: 50 * launch.publicTransferUsdPerGb,
        source: "estimated",
      },
    ])
  })

  test("charges the full window day when the public-transfer allowance is already exhausted", async () => {
    server.use(
      http.get("https://console.neon.tech/api/v2/consumption_history/v2/projects", () =>
        HttpResponse.json({
          projects: [
            projectDays("launch", [
              { day: "2026-02-01", metrics: [{ metric_name: "public_network_transfer_bytes", value: 600_000_000_000 }] },
              { day: DAY, metrics: [{ metric_name: "public_network_transfer_bytes", value: 10_000_000_000 }] },
            ]),
          ],
        }),
      ),
    )
    await expect(rows([DAY])).resolves.toEqual([
      {
        day: DAY,
        provider: "neon",
        sku: "egress",
        scope: "prod-db",
        usage: 10,
        unit: "GB",
        costUsd: 10 * launch.publicTransferUsdPerGb,
        source: "estimated",
      },
    ])
  })

  test("resets monthly allowances at the 1st when the window spans two months", async () => {
    let from = ""
    let to = ""
    server.use(
      http.get("https://console.neon.tech/api/v2/consumption_history/v2/projects", ({ request }) => {
        const url = new URL(request.url)
        from = url.searchParams.get("from") ?? ""
        to = url.searchParams.get("to") ?? ""
        return HttpResponse.json({
          projects: [
            projectDays("launch", [
              { day: "2026-02-01", metrics: [{ metric_name: "public_network_transfer_bytes", value: 500_000_000_000 }] },
              { day: "2026-02-28", metrics: [{ metric_name: "public_network_transfer_bytes", value: 20_000_000_000 }] },
              { day: "2026-03-01", metrics: [{ metric_name: "public_network_transfer_bytes", value: 20_000_000_000 }] },
            ]),
          ],
        })
      }),
    )
    await expect(rows(["2026-02-28", "2026-03-01"])).resolves.toEqual([
      {
        day: "2026-02-28",
        provider: "neon",
        sku: "egress",
        scope: "prod-db",
        usage: 20,
        unit: "GB",
        costUsd: 20 * launch.publicTransferUsdPerGb,
        source: "estimated",
      },
    ])
    expect(from).toBe("2026-02-01T00:00:00.000Z")
    expect(to).toBe("2026-03-02T00:00:00.000Z")
  })

  test("uses Scale rates when period_plan is scale", async () => {
    const extraBranchHours = 744 - scale.includedChildBranches * 24
    server.use(
      http.get("https://console.neon.tech/api/v2/consumption_history/v2/projects", () =>
        HttpResponse.json({
          projects: [project(PROJECT, "prod-db", [{ metric_name: "compute_unit_seconds", value: 3600 }, { metric_name: "extra_branches_month", value: 744 }], "scale")],
        }),
      ),
    )
    await expect(rows([DAY])).resolves.toEqual([
      {
        day: DAY,
        provider: "neon",
        sku: "compute",
        scope: "prod-db",
        usage: 1,
        unit: "cu_hour",
        costUsd: 1 * scale.computeUsdPerCuHour,
        source: "estimated",
      },
      {
        day: DAY,
        provider: "neon",
        sku: "extra_branches",
        scope: "prod-db",
        usage: extraBranchHours / 744,
        unit: "branch_month",
        costUsd: (extraBranchHours / 744) * scale.extraBranchUsdPerMonth,
        source: "estimated",
      },
    ])
  })

  test("uses Launch compute, Scale extra-branch allowance, and Agent public-transfer allowance when period_plan is agent", async () => {
    const extraBranchHours = 744 - scale.includedChildBranches * 24
    server.use(
      http.get("https://console.neon.tech/api/v2/consumption_history/v2/projects", () =>
        HttpResponse.json({
          projects: [
            project(PROJECT, "prod-db", [
              { metric_name: "compute_unit_seconds", value: 3600 },
              { metric_name: "extra_branches_month", value: 744 },
              { metric_name: "public_network_transfer_bytes", value: 150_000_000_000 },
            ], "agent"),
          ],
        }),
      ),
    )
    await expect(rows([DAY])).resolves.toEqual([
      {
        day: DAY,
        provider: "neon",
        sku: "compute",
        scope: "prod-db",
        usage: 1,
        unit: "cu_hour",
        costUsd: 1 * launch.computeUsdPerCuHour,
        source: "estimated",
      },
      {
        day: DAY,
        provider: "neon",
        sku: "extra_branches",
        scope: "prod-db",
        usage: extraBranchHours / 744,
        unit: "branch_month",
        costUsd: (extraBranchHours / 744) * scale.extraBranchUsdPerMonth,
        source: "estimated",
      },
      {
        day: DAY,
        provider: "neon",
        sku: "egress",
        scope: "prod-db",
        usage: 50,
        unit: "GB",
        costUsd: 50 * scale.publicTransferUsdPerGb,
        source: "estimated",
      },
    ])
  })

  test("throws when period_plan is unknown", async () => {
    server.use(
      http.get("https://console.neon.tech/api/v2/consumption_history/v2/projects", () =>
        HttpResponse.json({
          projects: [project(PROJECT, "prod-db", [{ metric_name: "compute_unit_seconds", value: 3600 }], "enterprise")],
        }),
      ),
    )
    await expect(rows([DAY])).rejects.toThrow("unknown Neon period_plan: enterprise")
  })

  test("throws on a non-OK response", async () => {
    server.use(http.get("https://console.neon.tech/api/v2/consumption_history/v2/projects", () => new HttpResponse("nope", { status: 403 })))
    await expect(rows([DAY])).rejects.toThrow("Neon consumption HTTP 403: nope")
  })

  test("throws when projects is missing", async () => {
    server.use(http.get("https://console.neon.tech/api/v2/consumption_history/v2/projects", () => HttpResponse.json({})))
    await expect(rows([DAY])).rejects.toThrow("Neon consumption response was missing projects")
  })

  test("skips a malformed metric", async () => {
    server.use(
      http.get("https://console.neon.tech/api/v2/consumption_history/v2/projects", () =>
        HttpResponse.json({
          projects: [
            project(PROJECT, "prod-db", [
              { metric_name: "compute_unit_seconds", value: 3600 },
              { metric_name: "compute_unit_seconds", value: "x" },
              null,
              { metric_name: "not_a_metric", value: 99 },
            ]),
          ],
        }),
      ),
    )
    const result = await rows([DAY])
    expect(result).toEqual([
      {
        day: DAY,
        provider: "neon",
        sku: "compute",
        scope: "prod-db",
        usage: 1,
        unit: "cu_hour",
        costUsd: 1 * launch.computeUsdPerCuHour,
        source: "estimated",
      },
    ])
    expect(result.some((row) => row.sku === "subscription")).toBe(false)
  })

  test("throws when the JSON body is null", async () => {
    server.use(http.get("https://console.neon.tech/api/v2/consumption_history/v2/projects", () => HttpResponse.json(null)))
    await expect(rows([DAY])).rejects.toThrow("Neon consumption response was missing projects")
  })

  test("throws when the API key is missing", async () => {
    delete process.env.NEON_API_KEY
    await expect(rows([DAY])).rejects.toThrow("NEON_API_KEY is required")
  })
})

function project(id: string, name: string | undefined, metrics: unknown[], plan = "launch") {
  return {
    project_id: id,
    name,
    periods: [
      {
        period_plan: plan,
        consumption: [
          {
            timeframe_start: `${DAY}T00:00:00Z`,
            timeframe_end: "2026-02-05T00:00:00Z",
            metrics,
          },
        ],
      },
    ],
  }
}

function projectDays(plan: string, days: { day: string; metrics: unknown[] }[]) {
  return {
    project_id: PROJECT,
    name: "prod-db",
    periods: [
      {
        period_plan: plan,
        consumption: days.map((entry) => ({
          timeframe_start: `${entry.day}T00:00:00Z`,
          timeframe_end: `${entry.day}T00:00:00Z`,
          metrics: entry.metrics,
        })),
      },
    ],
  }
}
