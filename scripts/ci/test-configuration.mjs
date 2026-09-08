import { existsSync, readFileSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"
import ts from "typescript"
import { parse as parseYaml } from "yaml"

export function readTestConfiguration(files, root) {
  const errors = []
  const configFiles = new Set(
    files.filter((file) =>
      /(?:^|\/)(?:vitest|vite|playwright)\.config\.[cm]?[jt]s$/.test(file),
    ),
  )
  const commandFiles = files.filter((file) => /\.(json|ya?ml|sh)$/.test(file))
  const addConfig = (path, cwd, owner) => {
    const file = resolve(cwd, path.replace(/^["']|["']$/g, ""))
    if (!existsSync(file) || !/\.[cm]?[jt]s$/.test(file)) {
      errors.push(
        `${relative(root, owner)}: Cannot resolve test configuration ${path}`,
      )
      return
    }
    configFiles.add(file)
    if (!files.includes(file)) files.push(file)
  }
  for (const file of commandFiles) {
    const contents = readFileSync(file, "utf8")
    let commands
    if (file.endsWith("package.json")) {
      commands = Object.values(JSON.parse(contents).scripts ?? {}).map(
        (command) => ({ command, cwd: dirname(file) }),
      )
    } else if (/\.ya?ml$/.test(file)) {
      const workflow = parseYaml(contents)
      commands = Object.values(workflow?.jobs ?? {}).flatMap((job) =>
        (job.steps ?? [])
          .filter((step) => typeof step.run === "string")
          .map((step) => ({
            command: step.run,
            cwd: resolve(
              root,
              step["working-directory"] ??
                job.defaults?.run?.["working-directory"] ??
                workflow.defaults?.run?.["working-directory"] ??
                ".",
            ),
          })),
      )
    } else {
      commands = [{ command: contents, cwd: root }]
    }
    for (const { command, cwd } of commands) {
      for (const line of command.replace(/\\\r?\n/g, " ").split("\n")) {
        if (
          line.trim().startsWith("#") ||
          !/\b(?:vitest|playwright)\b|\b(?:pnpm|npm|bun)\s+(?:(?:run|exec)\s+)?test(?:\b|:)/.test(
            line,
          )
        )
          continue
        for (const flag of line.matchAll(
          /--(?:retry|retries)(?:=|\s+)([^\s;|&]+)/g,
        ))
          if (flag[1].replace(/^["']|["']$/g, "") !== "0")
            errors.push(
              `${relative(root, file)}: Test runner retry flags are forbidden`,
            )
        for (const flag of line.matchAll(
          /(?:--config|-c)(?:=|\s+)("[^"]+"|'[^']+'|[^\s;|&]+)/g,
        ))
          addConfig(flag[1], cwd, file)
      }
    }
  }
  // Local imports, re-exports and static CommonJS require calls belong to the
  // same configuration surface. Installed dependencies remain outside it.
  for (const file of configFiles) {
    const parsed = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    )
    const visit = (node) => {
      const specifier =
        node.moduleSpecifier ??
        (ts.isCallExpression(node) &&
        (node.expression.getText(parsed) === "require" ||
          node.expression.kind === ts.SyntaxKind.ImportKeyword)
          ? node.arguments[0]
          : undefined)
      if (
        specifier &&
        ts.isStringLiteral(specifier) &&
        specifier.text.startsWith(".")
      ) {
        const base = resolve(dirname(file), specifier.text)
        const candidates = [
          base,
          base.replace(/\.[cm]?js$/, ".ts"),
          ...[
            ".ts",
            ".mts",
            ".cts",
            ".js",
            ".cjs",
            ".mjs",
            "/index.ts",
            "/index.js",
          ].map((extension) => base + extension),
        ]
        const dependency = candidates.find(
          (candidate) =>
            existsSync(candidate) && /\.[cm]?[jt]s$/.test(candidate),
        )
        if (dependency) addConfig(dependency, root, file)
        else
          errors.push(
            `${relative(root, file)}: Cannot resolve local test configuration ${specifier.text}`,
          )
      }
      ts.forEachChild(node, visit)
    }
    visit(parsed)
  }
  return {
    sourceFiles: files.filter((file) => !commandFiles.includes(file)),
    commandFiles,
    configFiles,
    errors,
  }
}
