export type PackageKind = "App" | "Service" | "Library"

export type WorkspacePackageMarker = {
  file: string
  defaultKind: PackageKind
}

// Order matters: more app-specific manifests should be checked first.
export const WORKSPACE_PACKAGE_MARKERS: WorkspacePackageMarker[] = [
  { file: "manifest.json", defaultKind: "App" }, // Browser extension
  { file: "tauri.conf.json", defaultKind: "App" },
  { file: "tauri.config.json", defaultKind: "App" },
  { file: "capacitor.config.json", defaultKind: "App" },
  { file: "capacitor.config.ts", defaultKind: "App" },
  { file: "app.json", defaultKind: "App" }, // Expo
  { file: "app.config.json", defaultKind: "App" },
  { file: "app.config.js", defaultKind: "App" },
  { file: "AndroidManifest.xml", defaultKind: "App" },
  { file: "package.json", defaultKind: "Service" }, // Classified by content
  { file: "Cargo.toml", defaultKind: "Service" },
  { file: "pyproject.toml", defaultKind: "Library" },
  { file: "pubspec.yaml", defaultKind: "Library" }, // Classified by content
  { file: "go.mod", defaultKind: "Library" },
  { file: "pom.xml", defaultKind: "Library" },
  { file: "build.gradle", defaultKind: "Library" },
  { file: "build.gradle.kts", defaultKind: "Library" },
]

export const WORKSPACE_PACKAGE_MARKER_FILES = new Set(
  WORKSPACE_PACKAGE_MARKERS.map((marker) => marker.file),
)
