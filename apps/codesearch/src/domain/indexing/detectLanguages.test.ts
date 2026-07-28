import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { detectLanguages, type ScipIndexerId } from "./detectLanguages.js"

const temporaryDirectories: string[] = []

function createCheckout(): string {
  const path = mkdtempSync(join(tmpdir(), "detect-languages-"))
  temporaryDirectories.push(path)
  return path
}

function touch(checkoutPath: string, relativePath: string): void {
  const path = join(checkoutPath, relativePath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, "")
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe("detectLanguages", () => {
  it.each<[ScipIndexerId, string]>([
    ["go", "go.mod"],
    ["typescript", "package.json"],
    ["python", "pyproject.toml"],
    ["python", "setup.py"],
    ["python", "requirements.txt"],
    ["python", "setup.cfg"],
    ["java", "pom.xml"],
    ["java", "build.gradle"],
    ["java", "build.gradle.kts"],
    ["java", "settings.gradle"],
    ["java", "settings.gradle.kts"],
    ["rust", "Cargo.toml"],
    ["clang", "compile_commands.json"],
    ["clang", "CMakeLists.txt"],
    ["ruby", "Gemfile"],
    ["dart", "pubspec.yaml"],
    ["php", "composer.json"],
  ])("detects %s from %s", (indexer, marker) => {
    const checkoutPath = createCheckout()
    touch(checkoutPath, marker)

    expect(detectLanguages(checkoutPath)).toEqual([indexer])
  })

  it.each([
    "tsconfig.json",
    "jsconfig.json",
  ])("detects TypeScript projects with package.json and %s", (configMarker) => {
    const checkoutPath = createCheckout()
    touch(checkoutPath, "package.json")
    touch(checkoutPath, configMarker)

    expect(detectLanguages(checkoutPath)).toEqual(["typescript"])
  })

  it.each<[ScipIndexerId, string]>([
    ["clang", "source.c"],
    ["clang", "source.cpp"],
    ["clang", "source.cc"],
    ["clang", "source.cxx"],
    ["clang", "source.h"],
    ["clang", "source.hpp"],
    ["ruby", "project.gemspec"],
    ["dotnet", "project.csproj"],
    ["dotnet", "project.sln"],
    ["dotnet", "project.vbproj"],
    ["dotnet", "project.fsproj"],
    ["php", "source.php"],
  ])("detects %s from shallow %s files", (indexer, marker) => {
    const checkoutPath = createCheckout()
    touch(checkoutPath, join("src", marker))

    expect(detectLanguages(checkoutPath)).toEqual([indexer])
  })

  it("detects Debian packaging from the debian directory", () => {
    const checkoutPath = createCheckout()
    mkdirSync(join(checkoutPath, "debian"))

    expect(detectLanguages(checkoutPath)).toEqual(["debian"])
  })

  it("returns indexers in stable family order without duplicates", () => {
    const checkoutPath = createCheckout()
    for (const marker of [
      "composer.json",
      "Cargo.toml",
      "package.json",
      "go.mod",
      "pom.xml",
      "pyproject.toml",
      "CMakeLists.txt",
      "Gemfile",
      "project.csproj",
      "pubspec.yaml",
    ]) {
      touch(checkoutPath, marker)
    }
    mkdirSync(join(checkoutPath, "debian"))

    expect(detectLanguages(checkoutPath)).toEqual([
      "go",
      "typescript",
      "python",
      "java",
      "rust",
      "clang",
      "ruby",
      "dotnet",
      "dart",
      "php",
      "debian",
    ])
  })

  it("limits source inference to the checkout and one directory level", () => {
    const checkoutPath = createCheckout()
    touch(checkoutPath, join("packages", "nested", "source.cpp"))
    touch(checkoutPath, join("packages", "nested", "source.php"))

    expect(detectLanguages(checkoutPath)).toEqual([])
  })

  it("returns no indexers for a missing checkout", () => {
    expect(detectLanguages(join(tmpdir(), "missing-checkout"))).toEqual([])
  })
})
