import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import { readTestConfiguration } from "./test-configuration.mjs"

function ownedMockCallHash(callText) {
  return createHash("sha256").update(callText).digest("hex")
}

const GATE0 = "7dfa6b93a5baedc3eb2c86dd1056662e89cace00"
const RECOVERY_MERGE_BASE = "9072089086f6fad87fbf05572b9f1ff5336e0520"
const MERGED_MAIN = "64c32537364037188c7988aaa2226ff0695a1ef2"

function gitShow(root, spec) {
  const show = () =>
    execFileSync("git", ["show", spec], { cwd: root, encoding: "utf8" })
  try {
    return show()
  } catch {
    // Pinned SHAs are not on every feature-branch history. Fetch when missing
    // so CI checkouts of a single branch can still read those artifacts.
    execFileSync("git", ["fetch", "origin", spec.split(":")[0], "--no-tags"], {
      cwd: root,
      encoding: "utf8",
    })
    return show()
  }
}

function readGate0File(root, path) {
  return gitShow(root, `${GATE0}:${path}`)
}

function readMergedMainFile(root, path) {
  return gitShow(root, `${MERGED_MAIN}:${path}`)
}

function callTextCounts(sourceText, properties) {
  const source = ts.createSourceFile(
    "pinned.tsx",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )
  const counts = new Map()
  const visit = (node) => {
    if (
      (ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)) &&
      ts.isCallExpression(node.parent)
    ) {
      const property = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : node.argumentExpression.getText(source).replaceAll(/["'`]/g, "")
      if (properties.has(property)) {
        const text = node.parent.getText(source)
        counts.set(text, (counts.get(text) ?? 0) + 1)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return counts
}

function skipIfCallCounts(sourceText) {
  return callTextCounts(sourceText, new Set(["skipIf"]))
}

function ownedMockCallCounts(sourceText) {
  return callTextCounts(
    sourceText,
    new Set(["mock", "doMock", "spyOn", "module"]),
  )
}

// Merge-resolved owned mocks whose AST text differs from MERGED_MAIN.
// Keys are SHA-256 of exact call AST text (node.parent.getText), counted
// and consumed one occurrence at a time — same shape as pinned-main.
const MERGED_OWNED_MOCK_EXCEPTION_COUNTS = {
  "apps/backend/src/models/conversations.test.ts": {
    // vi.mock("../auth/context.js", ...)
    "497f7603db614640cfc0b3293e3517212713bd6f0ff0178bebfb9f7dd9137e90": 1,
    // vi.mock("../db/org-sql.js", ...)
    "65a779298395ebf0b27e2d50ada3a9d743714526b7af190c8bc9ffd76b922a58": 1,
  },
  "apps/backend/src/models/github-pr-mirror.test.ts": {
    // vi.mock("../db/client.js", ...)
    "b0e64060c3dddfa9992cadd61f34022206458233c2463a20d4aaef8ef6315944": 1,
  },
  "apps/backend/src/models/linear-oauth-setup.test.ts": {
    // vi.mock("../db/client.js", ...)
    "336e734ad929f812aea1df2058902ebd4e00971f5380a2510afdfdeaff5c947d": 1,
  },
  "apps/backend/src/openworkflow/workflows/github-ensure-pr-mirror.test.ts": {
    // vi.mock("../../db/client.js", ...)
    "5f33ab14feb1821e09a7fcbe83944d3fc0ce7ded27083ba8e6f0da601d43290d": 1,
    // vi.mock("../../models/github-pr-mirror-target.js", ...)
    "456458bb7b2fc94760bb007726da3f1ae2939fe69e5183ee500681320736382c": 1,
    // vi.mock("../../models/github-pr-mirror.js", ...)
    "0992a49968bc2d5e0de142a944b63102f936530b4104c467957868acd0b7d7bd": 1,
    // vi.mock("../../models/repositories.js", ...)
    "ef16b18e3d40d2aaec9a2dc902bd3c7be17c7397ffd5b1d7071b451d4e7d4b19": 1,
    // vi.mock("../../models/github-installation.js", ...)
    "f01949b5d66052f2e4473901dbf9ace71600156f62a66b7a094bbccbb3a0abf9": 1,
    // vi.mock("../../domain/workspaces/capture-connector-mirror.js", ...)
    "fff8c69fcbd6c023c2408901b07b8ccca5eb009ae5bc61fc26145e2832743a9d": 1,
    // vi.mock("../../services/github/pull-request-mirror/config-from-repo.js", ...)
    "40b813747ed9180cb2ed3a84fee38354a8ee4c4398ab94036a5595b2081607fb": 1,
    // vi.mock("../client.js", ...)
    "f62f3e77567fc18902c94eedca782501d198bac98055f427c7a049cdd94bd633": 1,
  },
  "apps/backend/src/openworkflow/workflows/github-sync-content.test.ts": {
    // vi.mock("../../db/client.js", ...)
    "5f33ab14feb1821e09a7fcbe83944d3fc0ce7ded27083ba8e6f0da601d43290d": 1,
    // vi.mock("../../models/github-pr-mirror.js", ...)
    "1f772df65d4a528176dd61f5bee1c5745d5270b31effb35aedf412f001e1cd3c": 1,
    // vi.mock("../../domain/workspaces/capture-connector-mirror.js", ...)
    "3ca7c391d6794f23066fe4f767af5dcd008957671868fda6cd752c7f05f7621b": 1,
    // vi.mock("../../services/github/pull-request-mirror/sync.js", ...)
    "c68606f4939d483b1ceccd612b549316c899d9a98989ee2814effc58be58fa42": 1,
    // vi.mock("../enqueue-repository-ingestion.js", ...)
    "12bcb2492106e81fec5f3447a0da35ef61881673a3fd0f00773dad84b50a4f0b": 1,
    // vi.mock("../client.js", ...)
    "f62f3e77567fc18902c94eedca782501d198bac98055f427c7a049cdd94bd633": 1,
  },
  "apps/backend/src/services/github/pull-request-mirror/ensure.test.ts": {
    // vi.mock("./sync.js", ...)
    "52d262136401ed0b113eb82944af15d749285fba5df1e717a548edd8c2b36ba8": 1,
  },
  "apps/backend/src/routes/webhooks/github/github-pr-mirror-push.test.ts": {
    // vi.mock("../../../models/github-pr-mirror.js", ...)
    "ed0a4161d3d00aa3e567e19f4a67a28c1a1b6a553a9f378a30cae99481efc58c": 1,
  },
  "apps/ui/src/features/connectors/components/NotionSetupDialog.test.tsx": {
    // vi.mock("@tanstack/react-query", ...)
    "f3120bceb7ad025b2ed86a5e87ffcaadbf545aaac0168bf1366a56c1a7d81573": 1,
  },
  "apps/ui/src/features/connectors/components/PagerdutySetupDialog.test.tsx": {
    // vi.mock("@tanstack/react-query", ...)
    "e96f0136a528ae00cd84240b9ea2cd116bec5f91b14a7b8c1075eb7fe984df6d": 1,
  },
}

function importedMainTestPaths(root) {
  const spec = `${RECOVERY_MERGE_BASE}..${MERGED_MAIN}`
  const list = () =>
    execFileSync("git", ["diff", "--name-only", spec], {
      cwd: root,
      encoding: "utf8",
    })
  let text
  try {
    text = list()
  } catch {
    execFileSync(
      "git",
      ["fetch", "origin", RECOVERY_MERGE_BASE, MERGED_MAIN, "--no-tags"],
      { cwd: root, encoding: "utf8" },
    )
    text = list()
  }
  return new Set(
    text
      .split("\n")
      .filter((file) => /\.(test|stories)\.[cm]?[jt]sx?$/.test(file)),
  )
}

try {
  const root = fileURLToPath(new URL("../../", import.meta.url))
  const classification = new Map(
    readGate0File(
      root,
      "docs/plans/workspace-recovery-gate-0/test-classification.tsv",
    )
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => {
        const fields = line.split("\t")
        return [fields[0], fields[3]]
      }),
  )
  // Gate-0 characterization rows stay characterization. Imported-main paths
  // that Gate-0 marked proof (or omitted) stay proof: owned mocks are
  // allowed only as counted pinned-main call AST texts, plus the narrow
  // merge-resolved exact-call hashes below. Branch-new paths stay proof
  // unless Gate-0 already marked them characterization.
  const importedMain = importedMainTestPaths(root)
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
              [
                "scripts/ci/test-suite.mjs",
                "scripts/ci/storybook-golden.mjs",
                "apps/codesearch/scripts/run-vitest-contracts.mjs",
              ].includes(file) ||
              /(?:^|\/)package\.json$|^\.github\/workflows\/.*\.ya?ml$|^scripts\/.*\.sh$/.test(
                file,
              ) ||
              /(?:^|\/)(?:vitest|vite|playwright)\.config\.[cm]?[jt]s$/.test(
                file,
              ),
          )
          .map((file) => resolve(root, file))
  const { sourceFiles, commandFiles, configFiles, errors } =
    readTestConfiguration(files, root)
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
  const importedMainSources = new Map()
  const mergedMainSource = (path) => {
    if (!importedMainSources.has(path)) {
      try {
        importedMainSources.set(path, readMergedMainFile(root, path))
      } catch {
        importedMainSources.set(path, "")
      }
    }
    return importedMainSources.get(path)
  }
  const remainingPinnedSkipIf = new Map()
  const remainingPinnedOwnedMocks = new Map()
  const remainingMergedOwnedMockExceptions = new Map()
  const consumeCount = (table, path, key, countsForPath) => {
    if (!table.has(path)) table.set(path, countsForPath())
    const remaining = table.get(path)
    const left = remaining.get(key) ?? 0
    if (left === 0) return false
    remaining.set(key, left - 1)
    return true
  }
  const consumePinnedSkipIf = (path, callText) =>
    consumeCount(remainingPinnedSkipIf, path, callText, () =>
      skipIfCallCounts(mergedMainSource(path)),
    )
  const consumePinnedOwnedMock = (path, callText) =>
    importedMain.has(path) &&
    consumeCount(remainingPinnedOwnedMocks, path, callText, () =>
      ownedMockCallCounts(mergedMainSource(path)),
    )
  const consumeMergedOwnedMockException = (path, callText) =>
    importedMain.has(path) &&
    consumeCount(
      remainingMergedOwnedMockExceptions,
      path,
      ownedMockCallHash(callText),
      () =>
        new Map(
          Object.entries(MERGED_OWNED_MOCK_EXCEPTION_COUNTS[path] ?? {}),
        ),
    )
  for (const file of sourceFiles) {
    const source = program.getSourceFile(file)
    if (!source) throw new Error(`Cannot parse required policy source: ${file}`)
    const path = relative(root, file).replaceAll("\\", "/")
    const proof = classification.get(path) !== "characterization"
    const tests = new Set(["it", "test", "describe", "suite"])
    const mocks = new Set(["vi", "vitest", "jest", "mock"])
    const frameworkNamespaces = new Set()
    for (const statement of source.statements) {
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        const bindings = statement.importClause?.namedBindings
        if (
          bindings &&
          ts.isNamespaceImport(bindings) &&
          ["vitest", "node:test", "bun:test", "@playwright/test"].includes(
            statement.moduleSpecifier.text,
          )
        ) {
          mocks.add(bindings.name.text)
          tests.add(bindings.name.text)
          frameworkNamespaces.add(bindings.name.text)
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
    const isTestExpression = (expression) => {
      const root = rootName(expression)
      if (!tests.has(root)) return false
      if (!frameworkNamespaces.has(root)) return true
      let cursor = unwrap(expression)
      while (
        ts.isCallExpression(cursor) ||
        ts.isPropertyAccessExpression(cursor) ||
        ts.isElementAccessExpression(cursor)
      ) {
        if (
          !ts.isCallExpression(cursor) &&
          ts.isIdentifier(unwrap(cursor.expression))
        ) {
          const member = ts.isPropertyAccessExpression(cursor)
            ? cursor.name.text
            : cursor.argumentExpression.getText(source).replaceAll(/["'`]/g, "")
          return ["test", "it", "describe", "suite"].includes(member)
        }
        cursor = unwrap(cursor.expression)
      }
      return false
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
          if (isTestExpression(node.initializer)) tests.add(node.name.text)
          if (
            ts.isIdentifier(unwrap(node.initializer)) &&
            frameworkNamespaces.has(rootName(node.initializer))
          ) {
            frameworkNamespaces.add(node.name.text)
            tests.add(node.name.text)
          }
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
      if (
        ts.isCallExpression(expression) &&
        ["Object.freeze", "Object.seal", "Object.assign"].includes(
          expression.expression.getText(source),
        ) &&
        expression.arguments[0]
      )
        return objectOrigin(expression.arguments[0], seen)
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
      if (
        ts.isCallExpression(node) &&
        !isTestExpression(node.expression) &&
        !["Object.freeze", "Object.seal"].includes(
          node.expression.getText(source),
        )
      ) {
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
      if (ts.isCallExpression(node) && isTestExpression(node.expression)) {
        const callee = unwrap(node.expression)
        const method = ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : ts.isElementAccessExpression(callee)
            ? callee.argumentExpression.getText(source).replaceAll(/["'`]/g, "")
            : ""
        if (!["each", "for", "extend"].includes(method))
          for (const argument of node.arguments) markOptions(argument)
      }
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
      if (
        file.endsWith(".mjs") &&
        !file.endsWith(".test.mjs") &&
        ts.isTemplateExpression(node) &&
        /^--(?:retry|retries)(?:=|$)/.test(node.head.text)
      )
        complain(node, "Dynamic CI runner retry argv is forbidden")
      if (
        file.endsWith(".mjs") &&
        !file.endsWith(".test.mjs") &&
        (ts.isStringLiteral(node) ||
          ts.isNoSubstitutionTemplateLiteral(node)) &&
        /^--(?:retry|retries)(?:=|$)/.test(node.text) &&
        !/^--(?:retry|retries)=0$/.test(node.text)
      )
        complain(node, "CI runner retry argv is forbidden")
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
        ) {
          // Grandfather only exact skipIf call texts from pinned main, one
          // occurrence per pinned count. A second identical call is rejected.
          const importedSkipIf =
            property === "skipIf" &&
            ts.isCallExpression(node.parent) &&
            consumePinnedSkipIf(path, node.parent.getText(source))
          if (!importedSkipIf)
            complain(
              node,
              `Test selection/expected failure is forbidden: ${property}`,
            )
        }
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
              acceptedFixtures.set(path, readGate0File(root, path))
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
          const callText = ts.isCallExpression(node.parent)
            ? node.parent.getText(source)
            : ""
          const pinnedOwnedMock =
            callText && consumePinnedOwnedMock(path, callText)
          const mergedOwnedMock =
            !pinnedOwnedMock &&
            callText &&
            consumeMergedOwnedMockException(path, callText)
          if (
            !networkSdk &&
            !fixtureOnly &&
            !outputOrClock &&
            !pinnedOwnedMock &&
            !mergedOwnedMock
          )
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
