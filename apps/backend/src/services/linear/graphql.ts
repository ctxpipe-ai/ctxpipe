import type { TypedDocumentNode } from "@graphql-typed-document-node/core"
import { type LinearClient, RatelimitedLinearError } from "@linear/sdk"
import {
  type DocumentNode,
  type FieldNode,
  Kind,
  print,
  type SelectionNode,
  type SelectionSetNode,
  type ValueNode,
} from "graphql"

export const linearQueryComplexityCeiling = 8_000

const requestReserve = 25
const complexityReserve = 20_000
const minuteMs = 60_000

export class LinearQueryTooComplexError extends Error {
  readonly estimate: number

  constructor(estimate: number) {
    super(
      `Linear query complexity estimate ${estimate} exceeds ${linearQueryComplexityCeiling}`,
    )
    this.name = "LinearQueryTooComplexError"
    this.estimate = estimate
  }
}

type Budget = {
  calls: number[]
  requestsRemaining?: number
  requestsResetAt?: number
  complexityRemaining?: number
  complexityResetAt?: number
  tail: Promise<void>
}

const budgets = new Map<string, Budget>()
const complexityByDocument = new WeakMap<DocumentNode, number>()

export function resetLinearGraphqlForTests(): void {
  budgets.clear()
}

export async function linearGraphql<
  TData,
  TVariables extends Record<string, unknown>,
>(
  client: LinearClient,
  document: TypedDocumentNode<TData, TVariables>,
  variables: TVariables,
): Promise<TData> {
  const estimate = cachedQueryComplexity(document, variables)
  if (estimate > linearQueryComplexityCeiling) {
    throw new LinearQueryTooComplexError(estimate)
  }
  const token = accessTokenKey(client)
  return enqueue(token, () =>
    requestWithBudget(client, print(document), variables, budgetFor(token)),
  )
}

function cachedQueryComplexity(
  document: DocumentNode,
  variables: unknown,
): number {
  const values = recordOf(variables)
  if (
    values &&
    Object.values(values).some((value) => typeof value === "number")
  ) {
    return estimateLinearQueryComplexity(document, variables)
  }
  const cached = complexityByDocument.get(document)
  if (cached !== undefined) return cached
  const estimate = estimateLinearQueryComplexity(document, variables)
  complexityByDocument.set(document, estimate)
  return estimate
}

export function estimateLinearQueryComplexity(
  document: DocumentNode,
  variables?: unknown,
): number {
  const fragments = new Map<string, SelectionSetNode>()
  let selectionSet: SelectionSetNode | undefined
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      fragments.set(definition.name.value, definition.selectionSet)
    }
    if (definition.kind === Kind.OPERATION_DEFINITION) {
      selectionSet = definition.selectionSet
    }
  }
  if (!selectionSet) return 0
  const variableValues = recordOf(variables)
  let cost = 0
  for (const field of fieldsOf(selectionSet, fragments, new Set())) {
    cost += fieldCost(field, fragments, variableValues)
  }
  return Math.ceil(cost)
}

async function requestWithBudget<TData>(
  client: LinearClient,
  query: string,
  variables: unknown,
  budget: Budget,
): Promise<TData> {
  let waits = 0
  for (;;) {
    const waitMs = nextWaitMs(budget)
    if (waitMs > 0) {
      await waitForBudget(waitMs, waits)
      waits += 1
      continue
    }
    try {
      const response = await client.client.rawRequest<
        TData,
        Record<string, unknown>
      >(query, recordOf(variables))
      noteCall(budget)
      recordHeaders(budget, response.headers)
      if (response.data === undefined) {
        throw new Error("Linear GraphQL response did not include data")
      }
      return response.data
    } catch (error) {
      noteCall(budget)
      const limited = rateLimitWait(error)
      if (!limited) throw error
      applyRateLimit(budget, limited)
      const retryWaitMs = earliestWait(
        nextWaitMs(budget),
        endpointWaitMs(limited),
      )
      await waitForBudget(
        retryWaitMs > 0 ? retryWaitMs : limited.fallbackMs,
        waits,
      )
      waits += 1
    }
  }
}

function enqueue<T>(token: string, run: () => Promise<T>): Promise<T> {
  const budget = budgetFor(token)
  const result = budget.tail.then(run, run)
  budget.tail = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

function budgetFor(token: string): Budget {
  const existing = budgets.get(token)
  if (existing) return existing
  const created: Budget = { calls: [], tail: Promise.resolve() }
  budgets.set(token, created)
  return created
}

function accessTokenKey(client: LinearClient): string {
  const headers = client.options?.headers
  if (!headers) return ""
  if (headers instanceof Headers) return headers.get("authorization") ?? ""
  if (Array.isArray(headers)) {
    const match = headers.find(
      ([name]) => name.toLowerCase() === "authorization",
    )
    return match?.[1] ?? ""
  }
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "authorization") return value
  }
  return ""
}

function nextWaitMs(budget: Budget, now = Date.now()): number {
  const waits: number[] = []
  const recent = callsInWindow(budget, now)
  if (recent.length >= 70) {
    const oldest = recent[0]
    if (oldest !== undefined) waits.push(oldest + minuteMs + 1000 - now)
  }
  if (
    budget.requestsRemaining !== undefined &&
    budget.requestsRemaining < requestReserve &&
    budget.requestsResetAt !== undefined
  ) {
    waits.push(budget.requestsResetAt + 1000 - now)
  }
  if (
    budget.complexityRemaining !== undefined &&
    budget.complexityRemaining < complexityReserve &&
    budget.complexityResetAt !== undefined
  ) {
    waits.push(budget.complexityResetAt + 1000 - now)
  }
  const pending = waits.filter((wait) => wait > 0)
  if (pending.length === 0) return 0
  return Math.min(...pending)
}

async function waitForBudget(
  waitMs: number,
  waitsSoFar: number,
): Promise<void> {
  if (waitsSoFar >= 3) {
    throw new Error("Linear rate limit persisted after 3 waits")
  }
  if (waitMs > 65 * 60 * 1000) {
    throw new Error("Linear rate limit wait exceeds 65 minutes")
  }
  await new Promise((resolve) => setTimeout(resolve, waitMs))
}

function noteCall(budget: Budget, now = Date.now()): void {
  callsInWindow(budget, now)
  budget.calls.push(now)
}

function callsInWindow(budget: Budget, now: number): number[] {
  const cutoff = now - minuteMs
  budget.calls = budget.calls.filter((time) => time > cutoff)
  return budget.calls
}

function recordHeaders(budget: Budget, headers: Headers | undefined): void {
  if (!headers) return
  const requestsRemaining = headerNumber(
    headers,
    "x-ratelimit-requests-remaining",
  )
  const requestsResetAt = epochMs(
    headerNumber(headers, "x-ratelimit-requests-reset"),
  )
  const complexityRemaining = headerNumber(
    headers,
    "x-ratelimit-complexity-remaining",
  )
  const complexityResetAt = epochMs(
    headerNumber(headers, "x-ratelimit-complexity-reset"),
  )
  if (requestsRemaining !== undefined)
    budget.requestsRemaining = requestsRemaining
  if (requestsResetAt !== undefined) budget.requestsResetAt = requestsResetAt
  if (complexityRemaining !== undefined) {
    budget.complexityRemaining = complexityRemaining
  }
  if (complexityResetAt !== undefined)
    budget.complexityResetAt = complexityResetAt
}

type RateLimitWait = {
  requestsRemaining?: number
  requestsResetAt?: number
  complexityRemaining?: number
  complexityResetAt?: number
  endpointRemaining?: number
  endpointResetAt?: number
  fallbackMs: number
}

function rateLimitWait(error: unknown): RateLimitWait | undefined {
  if (!isRateLimited(error)) return undefined
  const headers = errorHeaders(error)
  const limited = error instanceof RatelimitedLinearError ? error : undefined
  const retryAfterSeconds = limited?.retryAfter
  return {
    requestsRemaining:
      limited?.requestsRemaining ??
      headerNumber(headers, "x-ratelimit-requests-remaining"),
    requestsResetAt: epochMs(
      limited?.requestsResetAt ??
        headerNumber(headers, "x-ratelimit-requests-reset"),
    ),
    complexityRemaining:
      limited?.complexityRemaining ??
      headerNumber(headers, "x-ratelimit-complexity-remaining"),
    complexityResetAt: epochMs(
      limited?.complexityResetAt ??
        headerNumber(headers, "x-ratelimit-complexity-reset"),
    ),
    endpointRemaining: headerNumber(
      headers,
      "x-ratelimit-endpoint-requests-remaining",
    ),
    endpointResetAt: epochMs(
      headerNumber(headers, "x-ratelimit-endpoint-requests-reset"),
    ),
    fallbackMs: ((retryAfterSeconds ?? 1) + 1) * 1000,
  }
}

function applyRateLimit(budget: Budget, limited: RateLimitWait): void {
  if (limited.requestsRemaining !== undefined) {
    budget.requestsRemaining = limited.requestsRemaining
    if (limited.requestsResetAt !== undefined) {
      budget.requestsResetAt = limited.requestsResetAt
    }
  }
  if (limited.complexityRemaining !== undefined) {
    budget.complexityRemaining = limited.complexityRemaining
    if (limited.complexityResetAt !== undefined) {
      budget.complexityResetAt = limited.complexityResetAt
    }
  }
  const requestsBlocking =
    limited.requestsRemaining !== undefined &&
    limited.requestsRemaining < requestReserve
  const complexityBlocking =
    limited.complexityRemaining !== undefined &&
    limited.complexityRemaining < complexityReserve
  if (
    !requestsBlocking &&
    !complexityBlocking &&
    limited.endpointRemaining !== 0
  ) {
    budget.requestsRemaining = 0
    budget.requestsResetAt = Date.now() + limited.fallbackMs - 1000
  }
}

function endpointWaitMs(limited: RateLimitWait, now = Date.now()): number {
  if (limited.endpointRemaining !== 0) return 0
  if (limited.endpointResetAt === undefined) return limited.fallbackMs
  return Math.max(0, limited.endpointResetAt + 1000 - now)
}

function earliestWait(left: number, right: number): number {
  const pending = [left, right].filter((wait) => wait > 0)
  if (pending.length === 0) return 0
  return Math.min(...pending)
}

function isRateLimited(error: unknown): boolean {
  if (error instanceof RatelimitedLinearError) return true
  return graphqlExtensionValues(error).some(
    (value) => value.toLowerCase() === "ratelimited",
  )
}

function graphqlExtensionValues(error: unknown): string[] {
  const response = errorResponse(error)
  if (!response || !Array.isArray(response.errors)) return []
  const values: string[] = []
  for (const item of response.errors) {
    if (!item || typeof item !== "object" || !("extensions" in item)) continue
    const extensions = item.extensions
    if (!extensions || typeof extensions !== "object") continue
    if ("code" in extensions && typeof extensions.code === "string") {
      values.push(extensions.code)
    }
    if ("type" in extensions && typeof extensions.type === "string") {
      values.push(extensions.type)
    }
  }
  return values
}

function errorHeaders(error: unknown): Headers | undefined {
  const headers = errorResponse(error)?.headers
  return headers instanceof Headers ? headers : undefined
}

function errorResponse(
  error: unknown,
): { errors?: unknown; headers?: unknown } | undefined {
  if (!error || typeof error !== "object" || !("raw" in error)) return undefined
  const raw = error.raw
  if (!raw || typeof raw !== "object" || !("response" in raw)) return undefined
  const response = raw.response
  if (!response || typeof response !== "object") return undefined
  return response
}

function headerNumber(
  headers: Headers | undefined,
  name: string,
): number | undefined {
  if (!headers) return undefined
  const raw = headers.get(name)
  if (raw == null || raw === "") return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

function epochMs(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined
  return value < 1e12 ? value * 1000 : value
}

function recordOf(variables: unknown): Record<string, unknown> | undefined {
  if (!variables || typeof variables !== "object") return undefined
  const record: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(variables)) record[key] = value
  return record
}

function fieldsOf(
  selectionSet: SelectionSetNode,
  fragments: Map<string, SelectionSetNode>,
  stack: Set<string>,
): FieldNode[] {
  const fields: FieldNode[] = []
  for (const selection of selectionSet.selections) {
    fields.push(...fieldsFromSelection(selection, fragments, stack))
  }
  return fields
}

function fieldsFromSelection(
  selection: SelectionNode,
  fragments: Map<string, SelectionSetNode>,
  stack: Set<string>,
): FieldNode[] {
  if (selection.kind === Kind.FIELD) return [selection]
  if (selection.kind === Kind.INLINE_FRAGMENT) {
    return fieldsOf(selection.selectionSet, fragments, stack)
  }
  if (stack.has(selection.name.value)) return []
  const fragment = fragments.get(selection.name.value)
  if (!fragment) return []
  const next = new Set(stack)
  next.add(selection.name.value)
  return fieldsOf(fragment, fragments, next)
}

function fieldCost(
  field: FieldNode,
  fragments: Map<string, SelectionSetNode>,
  variables: Record<string, unknown> | undefined,
): number {
  if (!field.selectionSet) return 0.1
  const children = fieldsOf(field.selectionSet, fragments, new Set())
  if (
    !children.some(
      (child) => child.name.value === "nodes" || child.name.value === "edges",
    )
  ) {
    return objectCost(field.selectionSet, fragments, variables)
  }
  const pageSize = readPageSize(field, variables)
  let cost = 0
  for (const child of children) {
    if (child.name.value === "nodes" || child.name.value === "edges") {
      if (child.selectionSet) {
        cost += pageSize * objectCost(child.selectionSet, fragments, variables)
      }
      continue
    }
    cost += child.selectionSet
      ? objectCost(child.selectionSet, fragments, variables)
      : 0.1
  }
  return cost
}

function objectCost(
  selectionSet: SelectionSetNode,
  fragments: Map<string, SelectionSetNode>,
  variables: Record<string, unknown> | undefined,
): number {
  let cost = 1
  for (const field of fieldsOf(selectionSet, fragments, new Set())) {
    cost += fieldCost(field, fragments, variables)
  }
  return cost
}

function readPageSize(
  field: FieldNode,
  variables: Record<string, unknown> | undefined,
): number {
  const argument = field.arguments?.find(
    (candidate) =>
      candidate.name.value === "first" || candidate.name.value === "last",
  )
  const value = argument ? readNumeric(argument.value, variables) : undefined
  return value ?? 50
}

function readNumeric(
  value: ValueNode,
  variables: Record<string, unknown> | undefined,
): number | undefined {
  if (value.kind === Kind.INT) {
    const parsed = Number(value.value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  if (value.kind === Kind.VARIABLE) {
    const variable = variables?.[value.name.value]
    return typeof variable === "number" && Number.isFinite(variable)
      ? variable
      : undefined
  }
  return undefined
}
