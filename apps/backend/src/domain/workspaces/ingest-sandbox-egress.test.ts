import { execFile } from "node:child_process"
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { describe, expect, it } from "vitest"

import {
  assertNoMetadataEndpoint,
  ingestCredentialRules,
} from "./ingest-sandbox-egress.js"

const backendHost = "app.example.test"

describe("ingestCredentialRules", () => {
  it("allows Git fetch of a plain git repository only for the source fetch, on port 443, with no credential, and adds the token only to GitHub (CTX-815)", () => {
    const egress = {
      repositories: [
        { fullName: "acme/context", githubConnectionId: "con_1" },
        {
          kind: "git" as const,
          host: "git.example.org",
          path: "/team/app.git",
        },
      ],
      modelProxyUrl: `https://${backendHost}/acme/api/v1/workspace-chat/openai/v1`,
      capability: "ingest-capability",
      bridge: { url: `https://${backendHost}/bridge`, token: "bridge-token" },
    }
    const access = [{ token: "git-1", repositories: ["acme/context"] }]
    const rules = ingestCredentialRules(egress, access, { fetchSource: true })
    const plain = rules.filter((rule) =>
      rule.host.startsWith("git.example.org"),
    )
    expect(
      plain.map(({ host, path, authorization }) => [host, path, authorization]),
    ).toEqual([
      ["git.example.org:443", "/team/app.git/info/refs", null],
      ["git.example.org:443", "/team/app.git/git-upload-pack", null],
    ])
    expect(
      rules
        .filter((rule) => rule.host === "github.com")
        .every((rule) => rule.authorization?.startsWith("Basic ")),
    ).toBe(true)
    // No rule allows a push or another path of the plain git host.
    expect(rules.some((rule) => rule.path?.includes("receive-pack"))).toBe(
      false,
    )
    // A step: no rule for the plain git host at all.
    expect(
      ingestCredentialRules(egress, access).some((rule) =>
        rule.host.startsWith("git.example.org"),
      ),
    ).toBe(false)
  })

  it("matches the port of a self-host plain git source: 80 for http, or its own port", () => {
    const rulesOf = (port: number) =>
      ingestCredentialRules(
        {
          repositories: [
            { kind: "git", host: "git.internal", path: "/team/app.git", port },
          ],
          modelProxyUrl: `https://${backendHost}/acme/api/v1/workspace-chat/openai/v1`,
          capability: "ingest-capability",
          bridge: { url: `https://${backendHost}/bridge`, token: "t" },
        },
        [],
        { fetchSource: true },
      )
        .filter((rule) => rule.host.startsWith("git.internal"))
        .map(({ host, path, authorization }) => [host, path, authorization])
    expect(rulesOf(80)).toEqual([
      ["git.internal:80", "/team/app.git/info/refs", null],
      ["git.internal:80", "/team/app.git/git-upload-pack", null],
    ])
    expect(rulesOf(3000).map(([host]) => host)).toEqual([
      "git.internal:3000",
      "git.internal:3000",
    ])
  })
})

describe("assertNoMetadataEndpoint", () => {
  /** A sandbox shell whose `curl` answers each URL with `code`. */
  const sandboxWithCurl = (code: string) => {
    const bin = mkdtempSync(join(tmpdir(), "metadata-curl-"))
    writeFileSync(join(bin, "curl"), `#!/bin/sh\nprintf '${code}'\n`)
    chmodSync(join(bin, "curl"), 0o755)
    return {
      process: {
        exec: async (command: string) => {
          const { stdout, stderr } = await promisify(execFile)(
            "sh",
            ["-c", command],
            {
              env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
            },
          )
          return { stdout, stderr, exitCode: 0 }
        },
      },
    }
  }

  it("fails closed when a metadata endpoint answers", async () => {
    await expect(
      assertNoMetadataEndpoint(sandboxWithCurl("200")),
    ).rejects.toThrow("open http://169.254.169.254/")
  })

  it("passes when no metadata endpoint answers", async () => {
    await expect(
      assertNoMetadataEndpoint(sandboxWithCurl("000")),
    ).resolves.toBeUndefined()
  })
})
