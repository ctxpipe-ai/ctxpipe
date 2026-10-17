/**
 * One codesearch tool: its name, its description, its input schema, and a
 * call that parses the input with the schema first. Workspace chat and
 * ingest read only the name and the description (`code-tools.ts`); tests
 * call `invoke`.
 */
export function tool<Input, Result>(
  run: (input: Input) => Promise<Result>,
  config: {
    name: string
    description: string
    schema: { parseAsync: (input: unknown) => Promise<Input> }
  },
) {
  return {
    name: config.name,
    description: config.description,
    schema: config.schema,
    invoke: async (input: unknown): Promise<Result> =>
      run(await config.schema.parseAsync(input)),
  }
}
