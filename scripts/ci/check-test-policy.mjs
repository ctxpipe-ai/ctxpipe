import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"
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
              /(?:^|\/)package\.json$|^\.github\/workflows\/.*\.ya?ml$|^scripts\/.*\.sh$/.test(
                file,
              ) ||
              /(?:^|\/)(?:vitest|vite|playwright)\.config\.[cm]?[jt]s$/.test(
                file,
              ),
          )
          .map((file) => resolve(root, file))
  const commandFiles = files.filter((file) => /\.(json|ya?ml|sh)$/.test(file))
  const errors = []
  for (const file of commandFiles) {
    const contents = readFileSync(file, "utf8")
    const commands = file.endsWith("package.json")
      ? Object.values(JSON.parse(contents).scripts ?? {})
      : contents
          .replace(/\\\r?\n/g, " ")
          .split("\n")
          .filter((line) => !line.trim().startsWith("#"))
    for (const command of commands) {
      if (!/\b(?:vitest|playwright|test(?::[\w-]+)?)\b/.test(command)) continue
      for (const flag of command.matchAll(
        /--(?:retry|retries)(?:=|\s+)([^\s;|&]+)/g,
      ))
        if (flag[1] !== "0")
          errors.push(
            `${relative(root, file)}: Test runner retry flags are forbidden`,
          )
    }
  }
  const configFiles = new Set(
    files.filter((file) =>
      /(?:^|\/)(?:vitest|vite|playwright)\.config\.[cm]?[jt]s$/.test(file),
    ),
  )
  // Local configuration dependencies are part of the configuration surface.
  // Follow imports/re-exports; never scan an installed dependency as product policy.
  for (const file of configFiles) {
    const parsed = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    )
    for (const statement of parsed.statements) {
      const specifier = statement.moduleSpecifier
      if (
        !specifier ||
        !ts.isStringLiteral(specifier) ||
        !specifier.text.startsWith(".")
      )
        continue
      const base = resolve(dirname(file), specifier.text)
      const candidates = [
        base,
        base.replace(/\.[cm]?js$/, ".ts"),
        ...[".ts", ".mts", ".cts", ".js", "/index.ts", "/index.js"].map(
          (extension) => base + extension,
        ),
      ]
      const dependency = candidates.find(
        (candidate) => existsSync(candidate) && /\.[cm]?[jt]s$/.test(candidate),
      )
      if (!dependency) {
        errors.push(
          `${relative(root, file)}: Cannot resolve local test configuration ${specifier.text}`,
        )
        continue
      }
      configFiles.add(dependency)
      if (!files.includes(dependency)) files.push(dependency)
    }
  }
  const sourceFiles = files.filter((file) => !commandFiles.includes(file))
  const compilerOptions = {
    allowJs: true,
    noResolve: true,
    noLib: true,
    types: [],
    target: ts.ScriptTarget.Latest,
    jsx: ts.JsxEmit.Preserve,
  }
  const program = ts.createProgram(
    sourceFiles,
    compilerOptions,
    ts.createCompilerHost(compilerOptions, true),
  )
  const checker = program.getTypeChecker()
  const declarationOf = (identifier) => {
    const symbol = ts.isShorthandPropertyAssignment(identifier.parent)
      ? checker.getShorthandAssignmentValueSymbol(identifier.parent)
      : checker.getSymbolAtLocation(identifier)
    const declaration = symbol?.valueDeclaration
    return declaration && ts.isVariableDeclaration(declaration)
      ? declaration
      : undefined
  }
  const initializerOf = (identifier) => declarationOf(identifier)?.initializer
  const isConstantBinding = (identifier) => {
    const declaration = declarationOf(identifier)
    return declaration && (declaration.parent.flags & ts.NodeFlags.Const) !== 0
  }
  const unwrap = (expression) => {
    while (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isSatisfiesExpression(expression) ||
      ts.isTypeAssertionExpression(expression) ||
      ts.isNonNullExpression(expression)
    )
      expression = expression.expression
    return expression
  }
  const acceptedFixtures = new Map()
  for (const file of sourceFiles) {
    const source = program.getSourceFile(file)
    if (!source) throw new Error(`Cannot parse required policy source: ${file}`)
    const path = relative(root, file).replaceAll("\\", "/")
    const proof = classification.get(path) !== "characterization"
    const tests = new Set(["it", "test", "describe", "suite"])
    const mocks = new Set(["vi", "vitest", "jest", "mock"])
    for (const statement of source.statements) {
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        const bindings = statement.importClause?.namedBindings
        if (bindings && ts.isNamespaceImport(bindings)) {
          mocks.add(bindings.name.text)
          tests.add(bindings.name.text)
        }
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
      expression = unwrap(expression)
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
    while (previousSize !== mocks.size + tests.size) {
      previousSize = mocks.size + tests.size
      const collectAliases = (node) => {
        if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.initializer
        ) {
          if (tests.has(rootName(node.initializer))) tests.add(node.name.text)
        }
        if (
          ts.isVariableDeclaration(node) &&
          ts.isObjectBindingPattern(node.name) &&
          node.initializer &&
          mocks.has(rootName(node.initializer))
        ) {
          for (const binding of node.name.elements) {
            if (
              ts.isIdentifier(binding.name) &&
              ["vi", "vitest", "jest", "mock"].includes(
                (binding.propertyName ?? binding.name).getText(source),
              )
            )
              mocks.add(binding.name.text)
            if (
              ts.isIdentifier(binding.name) &&
              ["test", "it", "describe", "suite"].includes(
                (binding.propertyName ?? binding.name).getText(source),
              )
            )
              tests.add(binding.name.text)
          }
        }
        if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.initializer &&
          (ts.isIdentifier(unwrap(node.initializer)) ||
            (ts.isPropertyAccessExpression(unwrap(node.initializer)) &&
              ["vi", "vitest", "jest", "mock"].includes(
                unwrap(node.initializer).name.text,
              ))) &&
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
    const mutatedObjects = new Set()
    const objectOrigin = (expression, seen = new Set()) => {
      expression = unwrap(expression)
      if (!ts.isIdentifier(expression)) return expression
      const initializer = initializerOf(expression)
      if (!initializer || seen.has(initializer)) return expression
      seen.add(initializer)
      return objectOrigin(initializer, seen)
    }
    const collectMutations = (node) => {
      const target =
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
          ? node.left
          : (ts.isPrefixUnaryExpression(node) ||
                ts.isPostfixUnaryExpression(node)) &&
              [
                ts.SyntaxKind.PlusPlusToken,
                ts.SyntaxKind.MinusMinusToken,
              ].includes(node.operator)
            ? node.operand
            : ts.isDeleteExpression(node)
              ? node.expression
              : undefined
      if (target) {
        const access = unwrap(target)
        if (
          ts.isPropertyAccessExpression(access) ||
          ts.isElementAccessExpression(access)
        )
          mutatedObjects.add(objectOrigin(access.expression))
      }
      if (ts.isCallExpression(node) && !tests.has(rootName(node.expression))) {
        // An options object passed to arbitrary code is no longer statically
        // immutable. This covers Object/Reflect setters and local mutators.
        for (const argument of node.arguments)
          mutatedObjects.add(objectOrigin(argument))
        const callee = unwrap(node.expression)
        if (
          ts.isPropertyAccessExpression(callee) ||
          ts.isElementAccessExpression(callee)
        )
          mutatedObjects.add(objectOrigin(callee.expression))
      }
      ts.forEachChild(node, collectMutations)
    }
    collectMutations(source)
    const testOptions = new Set()
    const markOptions = (expression, seen = new Set()) => {
      expression = unwrap(expression)
      const initializer = ts.isIdentifier(expression)
        ? initializerOf(expression)
        : undefined
      if (initializer && !seen.has(initializer)) {
        if (!isConstantBinding(expression))
          complain(expression, "Test options must use constant bindings")
        seen.add(initializer)
        markOptions(initializer, seen)
      } else if (ts.isSpreadElement(expression)) {
        markOptions(expression.expression, seen)
      } else if (ts.isArrayLiteralExpression(expression)) {
        for (const element of expression.elements) markOptions(element, seen)
      } else if (ts.isCallExpression(expression)) {
        const name = expression.expression.getText(source)
        if (["Object.freeze", "Object.seal", "Object.assign"].includes(name)) {
          for (const argument of expression.arguments)
            markOptions(argument, seen)
        } else {
          complain(
            expression,
            "Test arguments must use statically declared options and callbacks",
          )
        }
      } else if (ts.isObjectLiteralExpression(expression)) {
        if (mutatedObjects.has(expression))
          complain(expression, "Test options must not be mutated")
        testOptions.add(expression)
        for (const property of expression.properties)
          if (ts.isSpreadAssignment(property))
            markOptions(property.expression, seen)
      }
    }
    const collectOptions = (node) => {
      if (ts.isCallExpression(node) && tests.has(rootName(node.expression)))
        for (const argument of node.arguments) markOptions(argument)
      ts.forEachChild(node, collectOptions)
    }
    collectOptions(source)
    const constantValue = (expression, seen = new Set()) => {
      expression = unwrap(expression)
      const initializer = ts.isIdentifier(expression)
        ? initializerOf(expression)
        : undefined
      if (
        initializer &&
        isConstantBinding(expression) &&
        !seen.has(initializer)
      ) {
        seen.add(initializer)
        return constantValue(initializer, seen)
      }
      if (
        ts.isStringLiteral(expression) ||
        ts.isNoSubstitutionTemplateLiteral(expression)
      )
        return JSON.stringify(expression.text)
      return expression.getText(source)
    }
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
          ["mock", "doMock", "spyOn", "module"].includes(property) &&
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
          : constantValue(node.argumentExpression).replaceAll(/["']/g, "")
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
          ["mock", "doMock", "spyOn", "module"].includes(property)
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
        (ts.isPropertyAssignment(node) ||
          ts.isShorthandPropertyAssignment(node) ||
          ts.isGetAccessorDeclaration(node)) &&
        ["retry", "retries", "fails", "skip", "only", "todo"].includes(
          (ts.isComputedPropertyName(node.name)
            ? constantValue(node.name.expression)
            : node.name.getText(source)
          ).replaceAll(/["']/g, ""),
        ) &&
        !["0", "false"].includes(
          ts.isGetAccessorDeclaration(node)
            ? "dynamic"
            : constantValue(
                ts.isShorthandPropertyAssignment(node)
                  ? node.name
                  : node.initializer,
              ),
        ) &&
        (testOptions.has(node.parent) ||
          configFiles.has(file) ||
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
        complain(
          node,
          "Test retries, selection and expected failures are forbidden",
        )
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  if (errors.length) throw new Error(errors.join("\n"))
  process.stdout.write(
    `Proof policy checked ${sourceFiles.length} test/story/config files and ${commandFiles.length} command files\n`,
  )
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
