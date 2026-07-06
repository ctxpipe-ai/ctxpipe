# Grafana CODEOWNERS Infrastructure Discovery

You are investigating the CODEOWNERS infrastructure in `grafana/grafana`.

The workspace contains a pinned checkout of `grafana/grafana` at `/app`.

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
