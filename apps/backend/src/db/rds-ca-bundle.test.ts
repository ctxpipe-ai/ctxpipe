import { createHash, X509Certificate } from "node:crypto"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

/*
 * The backend and worker images trust this bundle through NODE_EXTRA_CA_CERTS
 * (apps/backend/Dockerfile, Dockerfile.worker), so that the OpenWorkflow
 * driver can verify Aurora (CTX-1217, sandbox rehearsal 1). A change of the
 * file must be a new download of the AWS bundle, not an edit.
 */

const bundle = readFileSync(
  fileURLToPath(new URL("../../certs/rds-global-bundle.pem", import.meta.url)),
  "utf8",
)

function certificates(pem: string): X509Certificate[] {
  return (
    pem.match(
      /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
    ) ?? []
  ).map((block) => new X509Certificate(block))
}

describe("RDS CA bundle", () => {
  it("is the global bundle of https://truststore.pki.rds.amazonaws.com", () => {
    expect(createHash("sha256").update(bundle).digest("hex")).toBe(
      "90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b",
    )
  })

  it("holds only Amazon RDS CA certificates, with the us-west-2 roots", () => {
    const all = certificates(bundle)

    expect(all.length).toBeGreaterThan(0)
    for (const certificate of all) {
      expect(certificate.ca).toBe(true)
      expect(certificate.subject).toMatch(/O=Amazon Web Services/)
    }
    const usWest2 = all
      .map((certificate) => /CN=(.+)/.exec(certificate.subject)?.[1] ?? "")
      .filter((name) => name.startsWith("Amazon RDS us-west-2 Root CA"))
    expect(usWest2.sort()).toEqual([
      "Amazon RDS us-west-2 Root CA ECC384 G1",
      "Amazon RDS us-west-2 Root CA RSA2048 G1",
      "Amazon RDS us-west-2 Root CA RSA4096 G1",
    ])
  })
})
