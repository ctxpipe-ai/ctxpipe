import { tryEmitIndexEvent } from "../../observability/indexingLog.js"

/**
 * Limits how many repository index pipelines run at once on this codesearch
 * instance. Zoekt + SCIP indexing are memory-heavy; parallel runs on large repos
 * (e.g. kubernetes, llvm) can OOM the container even without persistent watchers.
 *
 * Legacy `POST /index` still uses {@link withIndexConcurrency}. OpenWorkflow
 * phase endpoints rely on child-process admission at the spawn boundary.
 */
const MAX_CONCURRENT_INDEX_RUNS = 1

let activeIndexRuns = 0
const indexWaiters: Array<() => void> = []

type RepositoryOperationKind = "index" | "purge"
type RepositoryOperationWaiter = {
  kind: RepositoryOperationKind
  resolve: () => void
}
type RepositoryOperationState = {
  activeIndexes: number
  purgeActive: boolean
  waiters: RepositoryOperationWaiter[]
}

const repositoryOperations = new Map<string, RepositoryOperationState>()

function releaseIndexSlot(): void {
  activeIndexRuns = Math.max(0, activeIndexRuns - 1)
  const next = indexWaiters.shift()
  if (next) next()
}

async function acquireIndexSlot(): Promise<void> {
  if (activeIndexRuns < MAX_CONCURRENT_INDEX_RUNS) {
    activeIndexRuns += 1
    return
  }
  await new Promise<void>((resolve) => {
    indexWaiters.push(() => {
      activeIndexRuns += 1
      resolve()
    })
  })
}

export async function withIndexConcurrency<T>(
  fn: () => Promise<T>,
  onWaiting?: () => void | Promise<void>,
): Promise<T> {
  const waiting = activeIndexRuns >= MAX_CONCURRENT_INDEX_RUNS
  if (waiting) {
    tryEmitIndexEvent("codesearch.index.queue.wait")
    await onWaiting?.()
  }
  await acquireIndexSlot()
  tryEmitIndexEvent("codesearch.index.queue.acquired")
  try {
    return await fn()
  } finally {
    releaseIndexSlot()
    tryEmitIndexEvent("codesearch.index.queue.released")
  }
}

function getRepositoryOperationState(repoId: string): RepositoryOperationState {
  const existing = repositoryOperations.get(repoId)
  if (existing) return existing
  const created: RepositoryOperationState = {
    activeIndexes: 0,
    purgeActive: false,
    waiters: [],
  }
  repositoryOperations.set(repoId, created)
  return created
}

function hasWaitingPurge(state: RepositoryOperationState): boolean {
  return state.waiters.some((waiter) => waiter.kind === "purge")
}

function canAcquireRepositoryOperation(
  state: RepositoryOperationState,
  kind: RepositoryOperationKind,
): boolean {
  if (kind === "index") {
    return !state.purgeActive && !hasWaitingPurge(state)
  }
  return !state.purgeActive && state.activeIndexes === 0
}

function acquireRepositoryOperationNow(
  state: RepositoryOperationState,
  kind: RepositoryOperationKind,
): void {
  if (kind === "index") {
    state.activeIndexes += 1
  } else {
    state.purgeActive = true
  }
}

function drainRepositoryOperationWaiters(
  repoId: string,
  state: RepositoryOperationState,
): void {
  if (state.purgeActive || state.waiters.length === 0) {
    if (
      !state.purgeActive &&
      state.activeIndexes === 0 &&
      state.waiters.length === 0
    ) {
      repositoryOperations.delete(repoId)
    }
    return
  }

  if (state.activeIndexes === 0 && state.waiters[0]?.kind === "purge") {
    const next = state.waiters.shift()
    state.purgeActive = true
    next?.resolve()
    return
  }

  while (state.waiters[0]?.kind === "index" && !state.purgeActive) {
    const next = state.waiters.shift()
    state.activeIndexes += 1
    next?.resolve()
  }
}

async function acquireRepositoryOperation(
  repoId: string,
  kind: RepositoryOperationKind,
): Promise<void> {
  const state = getRepositoryOperationState(repoId)
  if (canAcquireRepositoryOperation(state, kind)) {
    acquireRepositoryOperationNow(state, kind)
    return
  }

  tryEmitIndexEvent("codesearch.repository.operation.wait", {
    repoId,
    operation: kind,
  })

  await new Promise<void>((resolve) => {
    state.waiters.push({ kind, resolve })
  })
}

function releaseRepositoryOperation(
  repoId: string,
  kind: RepositoryOperationKind,
): void {
  const state = repositoryOperations.get(repoId)
  if (!state) return

  if (kind === "index") {
    state.activeIndexes = Math.max(0, state.activeIndexes - 1)
  } else {
    state.purgeActive = false
  }

  drainRepositoryOperationWaiters(repoId, state)
  if (
    !state.purgeActive &&
    state.activeIndexes === 0 &&
    state.waiters.length === 0
  ) {
    repositoryOperations.delete(repoId)
  }
}

async function withRepositoryOperation<T>(
  repoId: string,
  kind: RepositoryOperationKind,
  fn: () => Promise<T>,
): Promise<T> {
  await acquireRepositoryOperation(repoId, kind)
  tryEmitIndexEvent("codesearch.repository.operation.acquired", {
    repoId,
    operation: kind,
  })
  try {
    return await fn()
  } finally {
    releaseRepositoryOperation(repoId, kind)
    tryEmitIndexEvent("codesearch.repository.operation.released", {
      repoId,
      operation: kind,
    })
  }
}

export async function withRepositoryIndexOperation<T>(
  repoId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withRepositoryOperation(repoId, "index", fn)
}

export async function withRepositoryPurgeOperation<T>(
  repoId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withRepositoryOperation(repoId, "purge", fn)
}
