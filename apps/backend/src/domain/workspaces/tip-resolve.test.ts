import { expect, it } from "vitest"
import { shouldEnqueueCronHydrate } from "./tip-resolve.js"

it("does not enqueue cron hydrate before a writable migration-export SHA exists", () => {
  expect(
    shouldEnqueueCronHydrate({
      migrationExportSha: null,
      desiredSha: "abc",
      activeProjectionSha: null,
      writeStatus: "writable",
    }),
  ).toBe(false)
  expect(
    shouldEnqueueCronHydrate({
      migrationExportSha: null,
      desiredSha: "abc",
      activeProjectionSha: null,
      writeStatus: "read_only",
    }),
  ).toBe(true)
  expect(
    shouldEnqueueCronHydrate({
      migrationExportSha: "export",
      desiredSha: "abc",
      activeProjectionSha: null,
      writeStatus: "writable",
    }),
  ).toBe(true)
  expect(
    shouldEnqueueCronHydrate({
      migrationExportSha: "export",
      desiredSha: "abc",
      activeProjectionSha: "abc",
      writeStatus: "writable",
    }),
  ).toBe(false)
})
