import { expect, test } from "bun:test"
import { METRIC_GROUP_BY } from "./railway"

test("metrics are grouped by service and region", () => {
  expect([...METRIC_GROUP_BY]).toEqual(["SERVICE_ID", "REGION"])
})
