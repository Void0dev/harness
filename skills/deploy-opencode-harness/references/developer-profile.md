# Installer Defaults

Keep these one-time settings outside the repository. Do not ask for them during a project installation.

- Coolify operator access, the Harness source integration, and the fixed Compose template. Keep the dedicated API token in an ignored local file; the operator provides its path as `coolify_token_env_path` for each installation:

  ```text
  COOLIFY_TOKEN=<dedicated API token with read, write, and deploy access>
  ```

  Never paste the token into chat. Derive the Coolify API origin from the operator-supplied `coolify_environment_url`; reject a plain-HTTP origin and do not send an API token over plain HTTP.
- The shared model environment already used by Harness. Never ask the user for model URL, model ID, or model key.

Use Coolify's `Generate Domain` action for `opencode-web`. Return the resulting Coolify-generated HTTPS URL to the operator. Do not require a custom domain, DNS configuration, or wildcard DNS.

Never print, commit, or ask for PEM contents, model keys, Coolify tokens, or generated internal tokens.
