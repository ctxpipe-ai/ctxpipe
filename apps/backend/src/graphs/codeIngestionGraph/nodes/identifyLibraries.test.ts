import { beforeEach, describe, expect, it, vi } from "vitest"

const {
  mockRequireCurrentOrgId,
  mockGetModel,
  mockAgentInvoke,
  mockCreateAgent,
  mockListFilesRecursive,
  mockFetchFiles,
} = vi.hoisted(() => ({
  mockRequireCurrentOrgId: vi.fn(() => "org_test"),
  mockGetModel: vi.fn(() => ({ provider: "mock-model" })),
  mockAgentInvoke: vi.fn(async () => undefined),
  mockCreateAgent: vi.fn(() => ({ invoke: mockAgentInvoke })),
  mockListFilesRecursive: vi.fn(async (): Promise<string[]> => ["package.json"]),
  mockFetchFiles: vi.fn(async (): Promise<Record<string, string>> => ({
    "package.json": JSON.stringify({
      dependencies: { prisma: "^5.0.0" },
    }),
  })),
}))

vi.mock("../../../auth/context.js", () => ({
  requireCurrentOrgId: mockRequireCurrentOrgId,
}))

vi.mock("../../../retrieval/services/modelProvider.js", () => ({
  getModel: mockGetModel,
}))

vi.mock("../../createAgent.js", () => ({
  createAgent: mockCreateAgent,
}))

vi.mock("../../../domain/codeIngestion/codesearchClient.js", () => ({
  listFilesRecursive: mockListFilesRecursive,
  fetchFiles: mockFetchFiles,
}))

import { identifyLibraries, postProcessLibraries } from "./identifyLibraries.js"

describe("identifyLibraries post-processing", () => {
  const state = {
    repositoryId: "repo_abc",
    roots: ["./", "apps/web"],
    targetHash: "abc123",
  }

  it("produces Library objects and USES_LIBRARY claims", () => {
    const captured = [
      { name: "Prisma", path: "./", category: "ORM", evidence: "package.json" },
      {
        name: "Hono",
        path: "apps/web",
        category: "HTTP",
        evidence: "package.json",
      },
    ]
    const { objects, claims } = postProcessLibraries(captured, state)

    expect(objects).toHaveLength(2)

    const libObjects = objects.filter((o) => o.kind === "Library")
    expect(libObjects).toHaveLength(2)

    expect(libObjects[0]).toMatchObject({
      kind: "Library",
      deduplicationKey: "lib:repo_abc:./:Prisma",
      name: "Prisma",
      summary: "Prisma used by ./ (ORM)",
      payload: { category: "ORM" },
    })

    expect(libObjects[1]).toMatchObject({
      kind: "Library",
      deduplicationKey: "lib:repo_abc:apps/web:Hono",
      name: "Hono",
      summary: "Hono used by apps/web (HTTP)",
    })

    expect(claims).toHaveLength(2)
    expect(claims.every((c) => c.predicate === "USES_LIBRARY")).toBe(true)
    expect(
      claims.every(
        (c) => c.subjectKind === "Service" && c.objectKind === "Library",
      ),
    ).toBe(true)
    expect(claims[0]).toMatchObject({
      subjectRef: "svc:repo_abc:./",
      objectRef: "lib:repo_abc:./:Prisma",
      predicate: "USES_LIBRARY",
      sourceId: "identifyLibraries:repo_abc:./:Prisma:abc123",
      sourceType: "git",
      extractionMethod: "llm",
      confidence: 0.8,
    })
  })

  it("deduplicates by library name per root", () => {
    const captured = [
      { name: "Prisma", path: "./" },
      { name: "prisma", path: "./" },
      { name: "drizzle", path: "./" },
    ]
    const { objects } = postProcessLibraries(captured, state)

    expect(objects).toHaveLength(2) // Prisma (deduped), Drizzle
    const names = objects.map((o) => o.name).sort()
    expect(names).toEqual(["Drizzle", "Prisma"])
  })

  it("normalizes library names for deduplication", () => {
    const captured = [
      { name: "drizzle-orm", path: "./" },
      { name: "Drizzle", path: "./" },
    ]
    const { objects } = postProcessLibraries(captured, state)
    expect(objects).toHaveLength(1)
    expect(objects[0].name).toBe("Drizzle")
    expect(objects[0].deduplicationKey).toBe("lib:repo_abc:./:Drizzle")
  })

  it("filters by pathMatchesRoot", () => {
    const captured = [
      { name: "Express", path: "apps/api" },
      { name: "Zod", path: "packages/shared" },
    ]
    const { objects } = postProcessLibraries(captured, {
      ...state,
      roots: ["apps/api"],
    })
    expect(objects).toHaveLength(1)
    expect(objects[0].name).toBe("Express")
    expect(objects[0].deduplicationKey).toBe("lib:repo_abc:apps/api:Express")
  })

  it("produces correct output shape for objects and claims", () => {
    const captured = [{ name: "Better Auth", path: "./", category: "auth" }]
    const { objects, claims } = postProcessLibraries(captured, state)

    expect(objects[0]).toMatchObject({
      kind: "Library",
      deduplicationKey: expect.stringMatching(/^lib:repo_abc:\.\/:.*/),
      name: expect.any(String),
      summary: expect.any(String),
    })

    expect(claims[0]).toMatchObject({
      subjectRef: "svc:repo_abc:./",
      subjectKind: "Service",
      objectRef: expect.stringMatching(/^lib:repo_abc:\.\/:.*/),
      objectKind: "Library",
      predicate: "USES_LIBRARY",
      sourceId: expect.any(String),
      sourceType: "git",
      extractionMethod: "llm",
      confidence: 0.8,
      provenance: expect.objectContaining({ root: "./" }),
    })
  })
})

describe("identifyLibraries deterministic prepass expectations (red)", () => {
  const state = {
    repositoryId: "repo_abc",
    roots: ["./"],
    targetHash: "abc123",
  }

  const ecosystemCases = [
    {
      ecosystem: "Node/Bun",
      submission: {
        name: "Prisma",
        path: "./",
        category: "ORM",
        evidence: "package.json dependency prisma",
      },
      expectedName: "Prisma",
      expectedCategory: "ORM",
      expectedEvidenceHint: "package.json",
    },
    {
      ecosystem: "Ruby",
      submission: {
        name: "Rails",
        path: "./",
        category: "HTTP",
        evidence: "Gemfile gem rails",
      },
      expectedName: "Rails",
      expectedCategory: "HTTP",
      expectedEvidenceHint: "Gemfile",
    },
    {
      ecosystem: "Python",
      submission: {
        name: "FastAPI",
        path: "./",
        category: "HTTP",
        evidence: "requirements.txt fastapi",
      },
      expectedName: "FastAPI",
      expectedCategory: "HTTP",
      expectedEvidenceHint: "requirements.txt",
    },
    {
      ecosystem: "Go",
      submission: {
        name: "Fiber",
        path: "./",
        category: "HTTP",
        evidence: "go.mod github.com/gofiber/fiber",
      },
      expectedName: "Fiber",
      expectedCategory: "HTTP",
      expectedEvidenceHint: "go.mod",
    },
    {
      ecosystem: "Java/Kotlin",
      submission: {
        name: "Spring Boot",
        path: "./",
        category: "HTTP",
        evidence: "pom.xml org.springframework.boot",
      },
      expectedName: "Spring Boot",
      expectedCategory: "HTTP",
      expectedEvidenceHint: "pom.xml",
    },
    {
      ecosystem: "Rust",
      submission: {
        name: "Axum",
        path: "./",
        category: "HTTP",
        evidence: "Cargo.toml axum",
      },
      expectedName: "Axum",
      expectedCategory: "HTTP",
      expectedEvidenceHint: "Cargo.toml",
    },
    {
      ecosystem: "PHP",
      submission: {
        name: "Laravel",
        path: "./",
        category: "HTTP",
        evidence: "composer.json laravel/framework",
      },
      expectedName: "Laravel",
      expectedCategory: "HTTP",
      expectedEvidenceHint: "composer.json",
    },
    {
      ecosystem: ".NET",
      submission: {
        name: "ASP.NET Core",
        path: "./",
        category: "HTTP",
        evidence: "src/App.csproj Microsoft.AspNetCore.App",
      },
      expectedName: "ASP.NET Core",
      expectedCategory: "HTTP",
      expectedEvidenceHint: ".csproj",
    },
    {
      ecosystem: "Elixir",
      submission: {
        name: "Phoenix",
        path: "./",
        category: "HTTP",
        evidence: "mix.exs {:phoenix, ...}",
      },
      expectedName: "Phoenix",
      expectedCategory: "HTTP",
      expectedEvidenceHint: "mix.exs",
    },
    {
      ecosystem: "Swift",
      submission: {
        name: "Vapor",
        path: "./",
        category: "HTTP",
        evidence: "Package.swift package(url: \".../vapor\")",
      },
      expectedName: "Vapor",
      expectedCategory: "HTTP",
      expectedEvidenceHint: "Package.swift",
    },
  ] as const

  it.each(ecosystemCases)(
    "marks $ecosystem manifest hits as deterministic",
    ({ submission, expectedName, expectedCategory, expectedEvidenceHint }) => {
      const { objects, claims } = postProcessLibraries([submission], state)
      expect(objects).toHaveLength(1)
      expect(objects[0]).toMatchObject({
        name: expectedName,
        payload: { category: expectedCategory },
      })
      expect(claims).toHaveLength(1)
      expect(claims[0]).toMatchObject({
        extractionMethod: "deterministic",
        provenance: expect.objectContaining({
          evidence: expect.stringContaining(expectedEvidenceHint),
        }),
      })
    },
  )

  it("preserves extractionMethod per claim for mixed deterministic + fallback results", () => {
    const { claims } = postProcessLibraries(
      [
        {
          name: "Prisma",
          path: "./",
          category: "ORM",
          evidence: "deterministic package.json prisma",
        },
        {
          name: "Zod",
          path: "./",
          category: "validation",
          evidence: "llm fallback import heuristics",
        },
      ],
      state,
    )

    expect(claims).toHaveLength(2)
    expect(claims[0]?.extractionMethod).toBe("deterministic")
    expect(claims[1]?.extractionMethod).toBe("llm")
  })
})

describe("identifyLibraries fallback gating (red)", () => {
  const ingestionState = {
    repositoryId: "repo_abc",
    orgId: "org_abc",
    roots: ["./"],
    targetHash: "abc123",
    extractedObjects: [],
    extractedClaims: [],
    objectIds: [],
    touchedObjectIds: [],
    claimsForProjection: [],
  }

  beforeEach(() => {
    mockRequireCurrentOrgId.mockReset()
    mockRequireCurrentOrgId.mockReturnValue("org_test")
    mockGetModel.mockReset()
    mockGetModel.mockReturnValue({ provider: "mock-model" })
    mockAgentInvoke.mockReset()
    mockAgentInvoke.mockResolvedValue(undefined)
    mockCreateAgent.mockClear()
    mockListFilesRecursive.mockReset()
    mockListFilesRecursive.mockResolvedValue(["package.json"])
    mockFetchFiles.mockReset()
    mockFetchFiles.mockResolvedValue({
      "package.json": JSON.stringify({
        dependencies: { prisma: "^5.0.0" },
      }),
    })
  })

  it("skips LLM fallback when deterministic evidence is sufficient", async () => {
    mockAgentInvoke.mockImplementation(async () => {
      throw new Error("LLM fallback should be skipped for deterministic roots")
    })

    const result = await identifyLibraries(ingestionState)

    expect(mockCreateAgent).not.toHaveBeenCalled()
    expect(result.extractedClaims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ extractionMethod: "deterministic" }),
      ]),
    )
  })

  it("triggers fallback on ambiguous manifest parsing and keeps llm extractionMethod", async () => {
    mockListFilesRecursive.mockResolvedValue(["pom.xml"])
    mockFetchFiles.mockResolvedValue({
      "pom.xml": "<project><dependencies>",
    })
    mockAgentInvoke.mockImplementation(async () => {
      const call = mockCreateAgent.mock.calls.at(-1)
      const config = call?.[0] as {
        tools?: Array<{
          name?: string
          invoke?: (input: unknown) => Promise<unknown>
        }>
      }
      const submitTool = config.tools?.find((tool) => tool.name === "submit_libraries")
      expect(submitTool).toBeDefined()
      if (!submitTool?.invoke) {
        throw new Error("submit_libraries tool was not provided")
      }
      await submitTool.invoke({
        libraries: [
          {
            name: "Spring Boot",
            path: "./",
            category: "HTTP",
            evidence: "fallback after malformed pom.xml",
          },
        ],
      })
    })

    const result = await identifyLibraries(ingestionState)

    expect(mockCreateAgent).toHaveBeenCalledTimes(1)
    expect(mockAgentInvoke).toHaveBeenCalledTimes(1)
    expect(result.extractedClaims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          extractionMethod: "llm",
          provenance: expect.objectContaining({
            evidence: expect.stringContaining("malformed pom.xml"),
          }),
        }),
      ]),
    )
  })
})

describe("identifyLibraries ecosystem e2e coverage (red)", () => {
  const baseState = {
    repositoryId: "repo_abc",
    orgId: "org_abc",
    roots: ["./"],
    targetHash: "abc123",
    extractedObjects: [],
    extractedClaims: [],
    objectIds: [],
    touchedObjectIds: [],
    claimsForProjection: [],
  }

  beforeEach(() => {
    mockRequireCurrentOrgId.mockReset()
    mockRequireCurrentOrgId.mockReturnValue("org_test")
    mockGetModel.mockReset()
    mockGetModel.mockReturnValue({ provider: "mock-model" })
    mockAgentInvoke.mockReset()
    mockAgentInvoke.mockResolvedValue(undefined)
    mockCreateAgent.mockClear()
    mockListFilesRecursive.mockReset()
    mockFetchFiles.mockReset()
  })

  it("detects Java/Kotlin Spring Boot from build.gradle.kts map-notation dependencies", async () => {
    mockListFilesRecursive.mockResolvedValue(["build.gradle.kts"])
    mockFetchFiles.mockResolvedValue({
      "build.gradle.kts": `
plugins {
  id("org.springframework.boot") version "3.3.1"
}

dependencies {
  implementation(group = "org.springframework.boot", name = "spring-boot-starter-web", version = "3.3.1")
}
`,
    })
    mockAgentInvoke.mockImplementation(async () => {
      const call = mockCreateAgent.mock.calls.at(-1)
      const config = call?.[0] as {
        tools?: Array<{
          name?: string
          invoke?: (input: unknown) => Promise<unknown>
        }>
      }
      const submitTool = config.tools?.find((tool) => tool.name === "submit_libraries")
      if (!submitTool?.invoke) {
        throw new Error("submit_libraries tool was not provided")
      }
      await submitTool.invoke({
        libraries: [
          {
            name: "Spring Boot",
            path: "./",
            category: "HTTP",
            evidence: "llm fallback from gradle map notation",
          },
        ],
      })
    })

    const result = await identifyLibraries(baseState)

    expect(mockCreateAgent).not.toHaveBeenCalled()
    expect(result.extractedClaims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          extractionMethod: "deterministic",
          objectRef: "lib:repo_abc:./:Spring Boot",
          provenance: expect.objectContaining({
            evidence: expect.stringContaining("build.gradle.kts"),
          }),
        }),
      ]),
    )
  })

  const deterministicEcosystemCases = [
    {
      ecosystem: "Node/Bun package.json",
      files: ["package.json"],
      manifests: {
        "package.json": JSON.stringify({
          dependencies: { prisma: "^5.0.0" },
        }),
      },
      expectedObjectRef: "lib:repo_abc:./:Prisma",
      expectedEvidenceHint: "package.json dependency prisma",
    },
    {
      ecosystem: "Ruby Gemfile",
      files: ["Gemfile"],
      manifests: {
        Gemfile: `source "https://rubygems.org"
gem "rails"
`,
      },
      expectedObjectRef: "lib:repo_abc:./:Rails",
      expectedEvidenceHint: "Gemfile dependency rails",
    },
    {
      ecosystem: "Python requirements.txt",
      files: ["requirements.txt"],
      manifests: {
        "requirements.txt": `
fastapi==0.115.0
`,
      },
      expectedObjectRef: "lib:repo_abc:./:FastAPI",
      expectedEvidenceHint: "requirements.txt dependency fastapi",
    },
    {
      ecosystem: "Python pyproject.toml",
      files: ["pyproject.toml"],
      manifests: {
        "pyproject.toml": `
[project]
name = "demo"
dependencies = ["fastapi>=0.100"]
`,
      },
      expectedObjectRef: "lib:repo_abc:./:FastAPI",
      expectedEvidenceHint: "pyproject.toml dependency fastapi",
    },
    {
      ecosystem: "Go go.mod",
      files: ["go.mod"],
      manifests: {
        "go.mod": `
module demo

go 1.23

require (
  github.com/gofiber/fiber v2.52.0
)
`,
      },
      expectedObjectRef: "lib:repo_abc:./:Fiber",
      expectedEvidenceHint: "go.mod dependency github.com/gofiber/fiber",
    },
    {
      ecosystem: "Java Maven pom.xml",
      files: ["pom.xml"],
      manifests: {
        "pom.xml": `
<project>
  <modelVersion>4.0.0</modelVersion>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
      <version>3.3.1</version>
    </dependency>
  </dependencies>
</project>
`,
      },
      expectedObjectRef: "lib:repo_abc:./:Spring Boot",
      expectedEvidenceHint: "pom.xml dependency org.springframework.boot",
    },
    {
      ecosystem: "Java/Kotlin Gradle build.gradle",
      files: ["build.gradle"],
      manifests: {
        "build.gradle": `
dependencies {
  implementation "org.springframework.boot:spring-boot-starter-web:3.3.1"
}
`,
      },
      expectedObjectRef: "lib:repo_abc:./:Spring Boot",
      expectedEvidenceHint: "build.gradle dependency org.springframework.boot",
    },
    {
      ecosystem: "Rust Cargo.toml",
      files: ["Cargo.toml"],
      manifests: {
        "Cargo.toml": `
[package]
name = "demo"
version = "0.1.0"

[dependencies]
axum = "0.8"
`,
      },
      expectedObjectRef: "lib:repo_abc:./:Axum",
      expectedEvidenceHint: "Cargo.toml dependency axum",
    },
    {
      ecosystem: "PHP composer.json",
      files: ["composer.json"],
      manifests: {
        "composer.json": JSON.stringify({
          require: { "laravel/framework": "^11.0.0" },
        }),
      },
      expectedObjectRef: "lib:repo_abc:./:Laravel",
      expectedEvidenceHint: "composer.json dependency laravel/framework",
    },
    {
      ecosystem: ".NET csproj",
      files: ["src/App.csproj"],
      manifests: {
        "src/App.csproj": `
<Project Sdk="Microsoft.NET.Sdk.Web">
  <ItemGroup>
    <FrameworkReference Include="Microsoft.AspNetCore.App" />
  </ItemGroup>
</Project>
`,
      },
      expectedObjectRef: "lib:repo_abc:./:ASP.NET Core",
      expectedEvidenceHint: "src/App.csproj dependency microsoft.aspnetcore.app",
    },
    {
      ecosystem: "Elixir mix.exs",
      files: ["mix.exs"],
      manifests: {
        "mix.exs": `
defp deps do
  [
    {:phoenix, "~> 1.7"}
  ]
end
`,
      },
      expectedObjectRef: "lib:repo_abc:./:Phoenix",
      expectedEvidenceHint: "mix.exs dependency phoenix",
    },
    {
      ecosystem: "Swift Package.swift",
      files: ["Package.swift"],
      manifests: {
        "Package.swift": `
// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "Demo",
  dependencies: [
    .package(url: "https://github.com/vapor/vapor", from: "4.0.0")
  ],
  targets: [
    .target(
      name: "Demo",
      dependencies: [
        .product(name: "Vapor", package: "vapor")
      ]
    )
  ]
)
`,
      },
      expectedObjectRef: "lib:repo_abc:./:Vapor",
      expectedEvidenceHint: "Package.swift dependency vapor",
    },
  ] as const

  it.each(deterministicEcosystemCases)(
    "keeps $ecosystem deterministic and skips fallback",
    async ({ files, manifests, expectedObjectRef, expectedEvidenceHint }) => {
      mockListFilesRecursive.mockResolvedValue([...files])
      mockFetchFiles.mockResolvedValue(manifests as Record<string, string>)
      mockAgentInvoke.mockImplementation(async () => {
        throw new Error("LLM fallback should be skipped for deterministic roots")
      })

      const result = await identifyLibraries(baseState)

      expect(mockCreateAgent).not.toHaveBeenCalled()
      expect(result.extractedClaims).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            extractionMethod: "deterministic",
            objectRef: expectedObjectRef,
            provenance: expect.objectContaining({
              evidence: expect.stringContaining(expectedEvidenceHint),
            }),
          }),
        ]),
      )
    },
  )
})

describe("identifyLibraries malformed manifest ambiguity (red)", () => {
  const baseState = {
    repositoryId: "repo_abc",
    orgId: "org_abc",
    roots: ["./"],
    targetHash: "abc123",
    extractedObjects: [],
    extractedClaims: [],
    objectIds: [],
    touchedObjectIds: [],
    claimsForProjection: [],
  }

  async function submitLibrariesFromFallback(
    libraries: Array<{
      name: string
      path: string
      category?: string
      evidence?: string
    }>,
  ) {
    const call = mockCreateAgent.mock.calls.at(-1)
    const config = call?.[0] as {
      tools?: Array<{
        name?: string
        invoke?: (input: unknown) => Promise<unknown>
      }>
    }
    const submitTool = config.tools?.find((tool) => tool.name === "submit_libraries")
    expect(submitTool).toBeDefined()
    if (!submitTool?.invoke) {
      throw new Error("submit_libraries tool was not provided")
    }
    await submitTool.invoke({ libraries })
  }

  beforeEach(() => {
    mockRequireCurrentOrgId.mockReset()
    mockRequireCurrentOrgId.mockReturnValue("org_test")
    mockGetModel.mockReset()
    mockGetModel.mockReturnValue({ provider: "mock-model" })
    mockAgentInvoke.mockReset()
    mockCreateAgent.mockClear()
    mockListFilesRecursive.mockReset()
    mockFetchFiles.mockReset()
  })

  it("forces fallback for malformed pyproject.toml ambiguity instead of deterministic shortcut", async () => {
    mockListFilesRecursive.mockResolvedValue(["pyproject.toml"])
    mockFetchFiles.mockResolvedValue({
      "pyproject.toml": `
[project
name = "ctxpipe-demo"
description = "fastapi"
`,
    })
    mockAgentInvoke.mockImplementation(async () => {
      await submitLibrariesFromFallback([
        {
          name: "FastAPI",
          path: "./",
          category: "HTTP",
          evidence: "fallback after malformed pyproject.toml",
        },
      ])
    })

    const result = await identifyLibraries(baseState)

    expect(mockCreateAgent).toHaveBeenCalledTimes(1)
    expect(mockAgentInvoke).toHaveBeenCalledTimes(1)
    expect(result.extractedClaims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          extractionMethod: "llm",
          provenance: expect.objectContaining({
            evidence: expect.stringContaining("malformed pyproject.toml"),
          }),
        }),
      ]),
    )
  })

  it("forces fallback for malformed/commented Gradle coordinates", async () => {
    mockListFilesRecursive.mockResolvedValue(["build.gradle"])
    mockFetchFiles.mockResolvedValue({
      "build.gradle": `
dependencies {
  // implementation "org.springframework.boot:spring-boot-starter-web:3.3.1"
  implementation "not-a-real-coordinate"
`,
    })
    mockAgentInvoke.mockImplementation(async () => {
      await submitLibrariesFromFallback([
        {
          name: "Spring Boot",
          path: "./",
          category: "HTTP",
          evidence: "fallback after malformed build.gradle",
        },
      ])
    })

    const result = await identifyLibraries(baseState)

    expect(mockCreateAgent).toHaveBeenCalledTimes(1)
    expect(mockAgentInvoke).toHaveBeenCalledTimes(1)
    expect(result.extractedClaims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          extractionMethod: "llm",
          objectRef: "lib:repo_abc:./:Spring Boot",
        }),
      ]),
    )
  })
})

describe("identifyLibraries partial ingestion deterministic+fallback regression (red)", () => {
  beforeEach(() => {
    mockRequireCurrentOrgId.mockReset()
    mockRequireCurrentOrgId.mockReturnValue("org_test")
    mockGetModel.mockReset()
    mockGetModel.mockReturnValue({ provider: "mock-model" })
    mockAgentInvoke.mockReset()
    mockCreateAgent.mockClear()
    mockListFilesRecursive.mockReset()
    mockFetchFiles.mockReset()
  })

  it("keeps both deterministic and fallback claims for repo-root partial ingestion", async () => {
    mockListFilesRecursive.mockResolvedValue(["package.json", "pom.xml"])
    mockFetchFiles.mockResolvedValue({
      "package.json": JSON.stringify({
        dependencies: { prisma: "^5.0.0" },
      }),
      "pom.xml": "<project><dependencies>",
    })
    mockAgentInvoke.mockImplementation(async () => {
      const call = mockCreateAgent.mock.calls.at(-1)
      const config = call?.[0] as {
        tools?: Array<{
          name?: string
          invoke?: (input: unknown) => Promise<unknown>
        }>
      }
      const submitTool = config.tools?.find((tool) => tool.name === "submit_libraries")
      expect(submitTool).toBeDefined()
      if (!submitTool?.invoke) {
        throw new Error("submit_libraries tool was not provided")
      }
      await submitTool.invoke({
        libraries: [
          {
            name: "Spring Boot",
            path: "./",
            category: "HTTP",
            evidence: "fallback after malformed pom.xml",
          },
        ],
      })
    })

    const result = await identifyLibraries({
      repositoryId: "repo_abc",
      orgId: "org_abc",
      roots: ["./"],
      targetHash: "abc123",
      ingestMode: "partial",
      changedPaths: ["package.json", "pom.xml"],
      extractedObjects: [],
      extractedClaims: [],
      objectIds: [],
      touchedObjectIds: [],
      claimsForProjection: [],
    })

    expect(result.extractedClaims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          extractionMethod: "deterministic",
          objectRef: "lib:repo_abc:./:Prisma",
        }),
        expect.objectContaining({
          extractionMethod: "llm",
          objectRef: "lib:repo_abc:./:Spring Boot",
        }),
      ]),
    )
  })
})
