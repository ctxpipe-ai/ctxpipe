// An OpenWorkflow worker claims every open run in its namespace, also runs
// it does not implement. Each test file gets its own namespace, so runs that
// one file leaves open do not delay the workers of the next file. This setup
// runs before the file imports a module, so the module-level `ow` client and
// each later `openWorkflowNamespaceId()` call use this namespace.
process.env.OPENWORKFLOW_NAMESPACE_ID = `test-${crypto.randomUUID()}`
