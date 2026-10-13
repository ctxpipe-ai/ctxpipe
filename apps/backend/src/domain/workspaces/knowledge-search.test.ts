import { describe, expect, it } from "vitest"
import { vectorScanSettings } from "./knowledge-search.js"

describe("vectorScanSettings", () => {
  it("uses iterative scan from pgvector 0.8", () => {
    for (const version of ["0.8.0", "0.8.2", "0.9.1", "0.10.0", "1.0.0"])
      expect(vectorScanSettings(version)).toEqual({
        iterativeScan: true,
        efSearch: 100,
      })
  })

  it("raises the candidate list before pgvector 0.8", () => {
    for (const version of ["0.7.4", "0.5.1", "0.7.0"])
      expect(vectorScanSettings(version)).toEqual({
        iterativeScan: false,
        efSearch: 1000,
      })
  })

  it("treats an unreadable version as an old one", () => {
    expect(vectorScanSettings(null)).toEqual({
      iterativeScan: false,
      efSearch: 1000,
    })
    expect(vectorScanSettings("dev")).toEqual({
      iterativeScan: false,
      efSearch: 1000,
    })
  })
})
