import { readFileSync } from "node:fs"

// A JSON Schema check for the committed schemas in schema/, with no package:
// the merge gate runs it in a job without dependencies. It covers only the
// keywords that those schemas use. It returns the errors, at most `limit`.
export function schemaErrors(value, name, limit = 10) {
  const document = JSON.parse(
    readFileSync(
      new URL(`schema/${name}.schema.json`, import.meta.url),
      "utf8",
    ),
  )
  const errors = []
  const fail = (path, message) => {
    if (errors.length < limit) errors.push(`${path}: ${message}`)
  }
  const check = (value, rule, path) => {
    if (errors.length >= limit) return
    if (rule.$ref) {
      check(value, document.$defs[rule.$ref.replace("#/$defs/", "")], path)
      return
    }
    if ("const" in rule && value !== rule.const)
      return fail(path, `is not ${JSON.stringify(rule.const)}`)
    if (rule.enum && !rule.enum.includes(value))
      return fail(path, `is not one of ${rule.enum.join(", ")}`)
    const type = Array.isArray(value)
      ? "array"
      : value === null
        ? "null"
        : Number.isInteger(value)
          ? "integer"
          : typeof value
    const types = { number: ["number", "integer"] }
    if (rule.type && !(types[rule.type] ?? [rule.type]).includes(type))
      return fail(path, `is ${type}, not ${rule.type}`)
    if (rule.minimum !== undefined && value < rule.minimum)
      fail(path, `is less than ${rule.minimum}`)
    if (rule.pattern && !new RegExp(rule.pattern).test(value))
      fail(path, `does not match ${rule.pattern}`)
    if (type === "array") {
      if (rule.minItems !== undefined && value.length < rule.minItems)
        fail(path, `has fewer than ${rule.minItems} items`)
      if (rule.maxItems !== undefined && value.length > rule.maxItems)
        fail(path, `has more than ${rule.maxItems} items`)
      if (rule.uniqueItems && new Set(value).size !== value.length)
        fail(path, "has duplicate items")
      if (rule.items)
        for (const [index, item] of value.entries())
          check(item, rule.items, `${path}[${index}]`)
    }
    if (type === "object") {
      for (const key of rule.required ?? [])
        if (!(key in value)) fail(path, `has no ${key}`)
      for (const [key, item] of Object.entries(value)) {
        const child = rule.properties?.[key] ?? rule.additionalProperties
        if (child === false) fail(path, `has the unknown property ${key}`)
        else if (child) check(item, child, `${path}.${key}`)
      }
    }
  }
  check(value, document, "$")
  return errors
}
