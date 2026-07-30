# Installer Defaults

Keep the shared model environment outside the repository. Coolify access and the GitHub App are per project installation.

- For each target Coolify server, the operator creates a dedicated API token and keeps it in an ignored local file. The operator provides its path as `coolify_token_env_path`:

  ```text
  COOLIFY_TOKEN=<dedicated API token with read, write, and deploy access>
  ```

  Never paste the token into chat. Derive the Coolify API origin from the operator-supplied `coolify_environment_url`.
- The shared model environment already used by Harness. Never ask the user for model URL, model ID, or model key.

Use `SERVICE_FQDN_OPENCODE_WEB_4096: /` in the Harness Compose for `opencode-web`. Return the resulting Coolify-generated URL to the operator. Do not require a custom domain, DNS configuration, or wildcard DNS.

Never print, commit, or ask for PEM contents, model keys, Coolify tokens, or generated internal tokens.
