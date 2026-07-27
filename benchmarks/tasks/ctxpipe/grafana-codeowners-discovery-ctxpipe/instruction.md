# Grafana CODEOWNERS Infrastructure Discovery (ctxpipe MCP)

You are investigating the CODEOWNERS infrastructure in `grafana/grafana`.

**There is no repository checkout in this workspace.** Use the **ctxpipe** MCP
server (already configured for your trial) to read org code context for:

- `grafana/grafana`

Write `/app/answer.json` with exactly these keys:

- `codeowners_file`
- `codeowners_validator_workflow`
- `manifest_constants_script`
- `manifest_index_script`
- `manifest_raw_script`
- `manifest_generate_script`
- `manifest_metadata_script`
- `manifest_utils_script`
- `featuremgmt_codeowners_go`
- `featuremgmt_models_go`
- `package_json_manifest_script`

Use string values only.

For the first ten keys, return repository-relative file paths.

For `package_json_manifest_script`, return the `package.json` script key that
runs the CODEOWNERS manifest entrypoint.
