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
    ["typescript", "tsconfig.json"],
    ["typescript", "jsconfig.json"],
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

  it("does not select typescript from bare package.json without tsconfig/jsconfig", () => {
    const checkoutPath = createCheckout()
    touch(checkoutPath, "package.json")
    touch(checkoutPath, join("src", "index.js"))

    expect(detectLanguages(checkoutPath)).toEqual([])
  })

  it.each<[ScipIndexerId, string]>([
    ["ruby", "project.gemspec"],
    ["dotnet", "project.csproj"],
    ["dotnet", "project.sln"],
    ["dotnet", "project.vbproj"],
    ["dotnet", "project.fsproj"],
    ["php", "source.php"],
    ["java", "App.scala"],
    ["java", "Main.kt"],
  ])("detects %s from %s files", (indexer, marker) => {
    const checkoutPath = createCheckout()
    touch(checkoutPath, join("src", marker))

    expect(detectLanguages(checkoutPath)).toEqual([indexer])
  })

  it("does not select clang from bare C/C++ sources without a compilation database", () => {
    const checkoutPath = createCheckout()
    touch(checkoutPath, join("pkg", "cni", "source.c"))
    touch(checkoutPath, join("pkg", "cni", "source.h"))

    expect(detectLanguages(checkoutPath)).toEqual([])
  })

  it("detects nested Go modules and JVM markers beyond one directory level", () => {
    const checkoutPath = createCheckout()
    touch(checkoutPath, join("staging", "src", "k8s.io", "api", "go.mod"))
    touch(checkoutPath, join("hack", "tools", "build.gradle.kts"))
    touch(checkoutPath, join("third_party", "lib", "Foo.scala"))

    expect(detectLanguages(checkoutPath)).toEqual(["go", "java"])
  })

  it("detects Debian packaging from the debian directory", () => {
    const checkoutPath = createCheckout()
    mkdirSync(join(checkoutPath, "debian"))

    expect(detectLanguages(checkoutPath)).toEqual(["debian"])
  })

  it("skips node_modules and .git when scanning", () => {
    const checkoutPath = createCheckout()
    touch(checkoutPath, join("node_modules", "pkg", "go.mod"))
    touch(checkoutPath, join(".git", "go.mod"))

    expect(detectLanguages(checkoutPath)).toEqual([])
  })

  it("returns indexers in stable family order without duplicates", () => {
    const checkoutPath = createCheckout()
    for (const marker of [
      "composer.json",
      "Cargo.toml",
      "tsconfig.json",
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

  it("still finds root go.mod when an early large subtree exists", () => {
    const checkoutPath = createCheckout()
    touch(checkoutPath, "go.mod")
    for (let i = 0; i < 50; i += 1) {
      touch(checkoutPath, join("bulk", `f${i}`, "placeholder.txt"))
    }
    touch(checkoutPath, join("staging", "src", "k8s.io", "api", "go.mod"))

    expect(detectLanguages(checkoutPath)).toEqual(["go"])
  })

  it("returns no indexers for a missing checkout", () => {
    expect(detectLanguages(join(tmpdir(), "missing-checkout"))).toEqual([])
  })
})
