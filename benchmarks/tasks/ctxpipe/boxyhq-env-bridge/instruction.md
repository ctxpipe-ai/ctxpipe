# BoxyHQ env bridge (v1)

Write `/app/answer.json` with exactly these string fields:

- `jackson_url_env`
- `jackson_external_url_env`
- `jackson_api_key_env`
- `polis_saml_path_prefix`
- `polis_saml_path_source_file`

Task intent:

- Treat `/app/saas-starter-kit` as the only local product repo in this workspace.
- Produce the deterministic v1 answer artifact for this benchmark fixture.

Constraints:

- Output must be valid JSON with the exact keys above.
- Values must be exact strings (case-sensitive).
- Do not include additional keys.
