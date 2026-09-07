import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"

try {
  const root = fileURLToPath(new URL("../../", import.meta.url))
  const classification = new Map(
    execFileSync(
      "git",
      [
        "show",
        "7dfa6b93a5baedc3eb2c86dd1056662e89cace00:docs/plans/workspace-recovery-gate-0/test-classification.tsv",
      ],
      { cwd: root, encoding: "utf8" },
    )
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => {
        const fields = line.split("\t")
        return [fields[0], fields[3]]
      }),
  )
  const files =
    process.argv.length > 2
      ? process.argv.slice(2)
      : execFileSync(
          "git",
          ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
          { cwd: root, encoding: "utf8" },
        )
          .split("\0")
          .filter(
            (file) =>
              /\.(test|stories)\.[cm]?[jt]sx?$/.test(file) ||
              /(?:^|\/)(?:vitest|vite|playwright)\.config\.[cm]?[jt]s$/.test(
                file,
              ),
          )
          .map((file) => resolve(root, file))
  const errors = []
  const acceptedFixtures = new Map()
  for (const file of files) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    )
    const path = relative(root, file).replaceAll("\\", "/")
    const proof = classification.get(path) !== "characterization"
    const tests = new Set(["it", "test", "describe", "suite"])
    const mocks = new Set(["vi", "vitest", "jest"])
    for (const statement of source.statements) {
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        ["vitest", "node:test", "@playwright/test"].includes(
          statement.moduleSpecifier.text,
        )
      ) {
        const bindings = statement.importClause?.namedBindings
        if (bindings && ts.isNamespaceImport(bindings))
          mocks.add(bindings.name.text)
        if (bindings && ts.isNamedImports(bindings)) {
          for (const binding of bindings.elements) {
            const imported = binding.propertyName?.text ?? binding.name.text
            if (tests.has(imported)) tests.add(binding.name.text)
            if (mocks.has(imported)) mocks.add(binding.name.text)
          }
        }
      }
    }
    const rootName = (expression) => {
      if (ts.isIdentifier(expression)) return expression.text
      if (
        ts.isPropertyAccessExpression(expression) ||
        ts.isElementAccessExpression(expression) ||
        ts.isCallExpression(expression)
      )
        return rootName(expression.expression)
      return ""
    }
    // Follow ordinary local aliases of the test framework before checking uses.
    let previousSize = -1
    while (previousSize !== mocks.size) {
      previousSize = mocks.size
      const collectAliases = (node) => {
        if (
          ts.isVariableDeclaration(node) &&
          ts.isObjectBindingPattern(node.name) &&
          node.initializer &&
          mocks.has(rootName(node.initializer))
        ) {
          for (const binding of node.name.elements) {
            if (
              ts.isIdentifier(binding.name) &&
              ["vi", "vitest", "jest"].includes(
                (binding.propertyName ?? binding.name).getText(source),
              )
            )
              mocks.add(binding.name.text)
          }
        }
        if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.initializer &&
          (ts.isIdentifier(node.initializer) ||
            (ts.isPropertyAccessExpression(node.initializer) &&
              ["vi", "vitest", "jest"].includes(node.initializer.name.text))) &&
          mocks.has(rootName(node.initializer))
        )
          mocks.add(node.name.text)
        ts.forEachChild(node, collectAliases)
      }
      collectAliases(source)
    }
    const complain = (node, message) =>
      errors.push(
        `${path}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${message}`,
      )
    const visit = (node) => {
      if (ts.isBindingElement(node)) {
        const property = (node.propertyName ?? node.name)
          .getText(source)
          .replaceAll(/["']/g, "")
        if (
          [
            "skip",
            "skipIf",
            "runIf",
            "fails",
            "fail",
            "fixme",
            "todo",
            "only",
          ].includes(property)
        )
          complain(
            node,
            `Test selection/expected failure is forbidden: ${property}`,
          )
        let declaration = node.parent
        while (declaration && !ts.isVariableDeclaration(declaration))
          declaration = declaration.parent
        if (
          proof &&
          ["mock", "doMock", "spyOn"].includes(property) &&
          declaration?.initializer &&
          mocks.has(rootName(declaration.initializer))
        )
          complain(
            node,
            `Proof cannot alias collaborator substitution (${property})`,
          )
      }
      if (
        ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)
      ) {
        const property = ts.isPropertyAccessExpression(node)
          ? node.name.text
          : ts.isStringLiteral(node.argumentExpression)
            ? node.argumentExpression.text
            : ""
        const owner = rootName(node.expression)
        if (
          [
            "skip",
            "skipIf",
            "runIf",
            "fails",
            "fail",
            "fixme",
            "todo",
            "only",
          ].includes(property)
        )
          complain(
            node,
            `Test selection/expected failure is forbidden: ${property}`,
          )
        if (
          proof &&
          mocks.has(owner) &&
          ["mock", "doMock", "spyOn"].includes(property)
        ) {
          const target = ts.isCallExpression(node.parent)
            ? node.parent.arguments[0]
            : undefined
          // Network edges may use MSW. Module replacement cannot prove execution
          // of the application or its runtime collaborators.
          const networkSdk =
            target &&
            ts.isStringLiteral(target) &&
            /^(?:@aws-sdk\/|@linear\/sdk$|@langchain\/(?:aws|core\/)|@langfuse\/|octokit$)/.test(
              target.text,
            )
          let fixtureOnly =
            (path === "apps/codesearch/src/domain/repositories/purge.test.ts" &&
              target?.getText(source) === '"../../config/paths.js"') ||
            (path ===
              "apps/codesearch/src/domain/graph/executeGraphPrimitive.test.ts" &&
              target?.getText(source) === '"node:fs/promises"')
          if (fixtureOnly) {
            // These two exact call-through/temp-path fixtures were reviewed at
            // Gate 0. A changed implementation requires real proof, not an exception.
            if (!acceptedFixtures.has(path))
              acceptedFixtures.set(
                path,
                execFileSync(
                  "git",
                  ["show", `7dfa6b93a5baedc3eb2c86dd1056662e89cace00:${path}`],
                  { cwd: root, encoding: "utf8" },
                ),
              )
            fixtureOnly = acceptedFixtures
              .get(path)
              .includes(node.parent.getText(source))
          }
          const outputOrClock =
            property === "spyOn" &&
            target &&
            ["Date", "Math", "globalThis", "console"].includes(
              target.getText(source),
            )
          if (!networkSdk && !fixtureOnly && !outputOrClock)
            complain(
              node,
              `Proof cannot mock its owned collaborators (${property})`,
            )
        }
      }
      if (
        ts.isPropertyAssignment(node) &&
        ["retry", "retries"].includes(
          node.name.getText(source).replaceAll(/["']/g, ""),
        ) &&
        !["0", "false"].includes(node.initializer.getText(source)) &&
        ((ts.isCallExpression(node.parent.parent) &&
          tests.has(rootName(node.parent.parent.expression))) ||
          /(?:^|\/)(?:vitest|vite|playwright)\.config\.[cm]?[jt]s$/.test(
            path,
          ) ||
          (() => {
            for (let parent = node.parent; parent; parent = parent.parent) {
              if (
                ts.isCallExpression(parent) &&
                rootName(parent.expression) === "defineConfig"
              )
                return true
            }
            return false
          })())
      )
        complain(node, "Blind test retries are forbidden")
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  if (errors.length) throw new Error(errors.join("\n"))
  process.stdout.write(
    `Proof policy checked ${files.length} test/story/config files\n`,
  )
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
