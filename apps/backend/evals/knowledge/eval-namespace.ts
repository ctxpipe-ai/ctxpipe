/*
 * The OpenWorkflow namespace of the harness. `cli.ts` imports this module
 * first, so that the namespace is set before the OpenWorkflow client loads:
 * the client reads it one time, and the hydrate queues its projection
 * through the client. A real worker never runs in this namespace, so the
 * worker of the hydrate takes only the runs of the eval, never the jobs of
 * another org. A test can set its own namespace with this prefix.
 */
export const EVAL_NAMESPACE = "knowledge-eval"

if (!process.env.OPENWORKFLOW_NAMESPACE_ID?.startsWith(EVAL_NAMESPACE))
  process.env.OPENWORKFLOW_NAMESPACE_ID = EVAL_NAMESPACE
