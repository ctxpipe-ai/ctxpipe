# `examples/`

Runnable consumer examples for ctxpipe packages. These are not published packages — each example is a private workspace member used as documentation and as a manually-run end-to-end test against real infrastructure.

## Examples

| Path                                                       | Package                        | Purpose                                                                                            |
| ---------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------- |
| [aws-cdk-self-host](./aws-cdk-self-host)                   | `@ctxpipe/aws-cdk-self-host`   | Deploy a self-hosted ctxpipe stack to AWS using `@ctxpipe/aws-cdk`. Doubles as a manual e2e test. |

## Adding a new example

1. Create a new directory under `examples/` with a `package.json` that has `"private": true` and a name like `@ctxpipe/<example-name>`.
2. The new directory is automatically picked up by pnpm (`examples/*` is registered in [pnpm-workspace.yaml](../pnpm-workspace.yaml)).
3. Depend on internal packages via `workspace:*`.
4. Add a row to the table above and a self-contained README explaining prerequisites, how to run it, and how to clean up.
