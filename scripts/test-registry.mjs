import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

export const tiers = ["core", "feature", "extended", "release", "deprecated"];
export const runtimes = ["unit", "browser", "electron", "packaged"];
export const root = path.resolve(import.meta.dirname, "..");
export function readRegistry() {
  return JSON.parse(
    fs.readFileSync(path.join(root, "tests/registry.json"), "utf8"),
  );
}
function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`Test symlink is not managed: ${file}`);
    return entry.isDirectory()
      ? files(file)
      : [path.relative(root, file).replaceAll("\\", "/")];
  });
}

// Count declarations with the TypeScript parser, not lines or grep matches.
// Keep tests explicit: no loops, .each, skip, todo or conditional registration.
export function countTests(file) {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(path.join(root, file), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const bindings = new Set();
  for (const statement of source.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ["vitest", "@playwright/test"].includes(statement.moduleSpecifier.text)
    ) {
      for (const binding of statement.importClause?.namedBindings?.elements ??
        []) {
        if (
          ["it", "test"].includes((binding.propertyName ?? binding.name).text)
        )
          bindings.add(binding.name.text);
      }
    }
  }
  let count = 0;
  function visit(node) {
    if (ts.isCallExpression(node)) {
      let base = node.expression;
      while (ts.isPropertyAccessExpression(base) || ts.isCallExpression(base))
        base = base.expression;
      if (ts.isIdentifier(base) && bindings.has(base.text)) {
        if (ts.isIdentifier(node.expression)) {
          if (
            !node.arguments[0] ||
            !ts.isStringLiteralLike(node.arguments[0]) ||
            node.arguments.length !== 2
          )
            throw new Error(`Use explicit named test declarations: ${file}`);
          for (let parent = node.parent; parent; parent = parent.parent) {
            if (
              ts.isForStatement(parent) ||
              ts.isForOfStatement(parent) ||
              ts.isForInStatement(parent) ||
              ts.isWhileStatement(parent) ||
              ts.isDoStatement(parent) ||
              ts.isIfStatement(parent) ||
              ts.isConditionalExpression(parent)
            )
              throw new Error(
                `Dynamic test declarations are not counted: ${file}`,
              );
          }
          count++;
        } else {
          const method = ts.isPropertyAccessExpression(node.expression)
            ? node.expression.name.text
            : "each";
          if (
            ![
              "beforeEach",
              "afterEach",
              "beforeAll",
              "afterAll",
              "setTimeout",
              "use",
              "describe",
              "step",
              "info",
            ].includes(method)
          )
            throw new Error(
              `Use registry lifecycle instead of test.${method}: ${file}`,
            );
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!count) throw new Error(`No test declarations: ${file}`);
  return count;
}

export function audit(registry = readRegistry()) {
  if (!Array.isArray(registry)) throw new Error("Registry must be an array");
  const ids = new Set(),
    paths = new Set();
  const counts = new Map();
  const date = /^\d{4}-\d{2}-\d{2}$/;
  for (const entry of registry) {
    for (const key of [
      "id",
      "path",
      "area",
      "tier",
      "status",
      "runtime",
      "created",
      "lastReviewed",
      "reason",
    ])
      if (typeof entry[key] !== "string" || !entry[key].trim())
        throw new Error(`Missing ${key}: ${entry.id}`);
    if (ids.has(entry.id) || paths.has(entry.path))
      throw new Error(`Duplicate ID/path: ${entry.id}`);
    ids.add(entry.id);
    paths.add(entry.path);
    if (
      !tiers.includes(entry.tier) ||
      !runtimes.includes(entry.runtime) ||
      !["active", "deprecated", "quarantine"].includes(entry.status)
    )
      throw new Error(`Invalid lifecycle/runtime: ${entry.id}`);
    if ((entry.tier === "deprecated") !== (entry.status === "deprecated"))
      throw new Error(`Deprecated tier/status must agree: ${entry.id}`);
    for (const key of ["created", "lastReviewed"])
      if (
        !date.test(entry[key]) ||
        new Date(entry[key]).toISOString().slice(0, 10) !== entry[key]
      )
        throw new Error(`Invalid ${key}: ${entry.id}`);
    if (entry.lastReviewed < entry.created)
      throw new Error(`Review predates creation: ${entry.id}`);
    if (
      !/^tests\/(core|feature|extended|release|deprecated)\/[a-zA-Z0-9/_-]+\.(test|spec)\.ts$/.test(
        entry.path,
      )
    )
      throw new Error(`Invalid managed path: ${entry.path}`);
    if (
      entry.status === "deprecated" &&
      (!entry.deprecationReason?.trim() || !date.test(entry.removeAfter ?? ""))
    )
      throw new Error(
        `Deprecation requires reason and removeAfter: ${entry.id}`,
      );
    if (
      entry.status === "quarantine" &&
      (!entry.quarantineReason?.trim() || !date.test(entry.reviewBy ?? ""))
    )
      throw new Error(`Quarantine requires reason and reviewBy: ${entry.id}`);
    if (!fs.existsSync(path.join(root, entry.path))) {
      if (entry.status !== "deprecated")
        throw new Error(`Missing test: ${entry.path}`);
      counts.set(entry.id, 0);
    } else {
      if ((entry.runtime === "unit") !== entry.path.endsWith(".test.ts"))
        throw new Error(`Runtime/extension mismatch: ${entry.path}`);
      counts.set(entry.id, countTests(entry.path));
    }
  }
  for (const file of files(path.join(root, "tests")))
    if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(file) && !paths.has(file))
      throw new Error(`Unregistered test: ${file}`);
  return counts;
}

export function statistics(registry, counts) {
  const result = {
    activeTests: 0,
    activeGroups: 0,
    byTier: Object.fromEntries(tiers.map((tier) => [tier, 0])),
    byArea: {},
    byRuntime: Object.fromEntries(runtimes.map((runtime) => [runtime, 0])),
    deprecatedCount: 0,
    quarantinedCount: 0,
    deprecatedRecords: [],
  };
  for (const entry of registry) {
    const count = counts.get(entry.id);
    if (entry.status === "active") {
      result.activeTests += count;
      result.activeGroups++;
      result.byTier[entry.tier] += count;
      result.byArea[entry.area] = (result.byArea[entry.area] ?? 0) + count;
      result.byRuntime[entry.runtime] += count;
    } else if (entry.status === "deprecated") {
      result.deprecatedCount++;
      result.deprecatedRecords.push({
        id: entry.id,
        reason: entry.deprecationReason,
        removeAfter: entry.removeAfter,
        executableTests: count,
      });
    } else result.quarantinedCount++;
  }
  result.byArea = Object.fromEntries(
    Object.entries(result.byArea).sort(([a], [b]) => a.localeCompare(b)),
  );
  return result;
}

export function select(registry, command, area) {
  if (command === "feature" && !area)
    throw new Error("Usage: npm run test:feature -- <area>");
  if (
    command === "feature" &&
    !registry.some(
      (entry) =>
        entry.area === area &&
        entry.status === "active" &&
        entry.tier === "feature",
    )
  )
    throw new Error(`No maintained feature tests for area: ${area}`);
  return registry.filter((entry) =>
    command === "deprecated"
      ? entry.status === "deprecated" &&
        fs.existsSync(path.join(root, entry.path))
      : entry.status === "active" &&
        ((command === "full" && entry.tier !== "release") ||
          command === "release" ||
          (entry.tier === command &&
            (command !== "feature" || entry.area === area))),
  );
}
