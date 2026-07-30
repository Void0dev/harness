#!/usr/bin/env bash

github_app_secret_directory=""

prepare_github_app_private_key() {
  local encoded_secret_path="${GITHUB_APP_PRIVATE_KEY_BASE64_PATH:-}"
  local private_key_path

  if [[ -z "$encoded_secret_path" ]]; then
    return 0
  fi
  if [[ ! -r "$encoded_secret_path" ]]; then
    echo "GitHub App Base64 secret is not readable" >&2
    return 1
  fi

  github_app_secret_directory="$(mktemp -d "${TMPDIR:-/tmp}/issue-harness-key.XXXXXX")"
  chmod 0700 "$github_app_secret_directory"
  private_key_path="$github_app_secret_directory/github-app.pem"
  if ! base64 --decode -- "$encoded_secret_path" > "$private_key_path"; then
    rm -rf -- "$github_app_secret_directory"
    github_app_secret_directory=""
    echo "GitHub App Base64 secret is malformed" >&2
    return 1
  fi
  if [[ ! -s "$private_key_path" ]]; then
    rm -rf -- "$github_app_secret_directory"
    github_app_secret_directory=""
    echo "GitHub App Base64 secret is empty" >&2
    return 1
  fi

  chmod 0600 "$private_key_path"
  export GITHUB_APP_PRIVATE_KEY_PATH="$private_key_path"
}

cleanup_github_app_private_key() {
  if [[ -n "$github_app_secret_directory" ]]; then
    rm -rf -- "$github_app_secret_directory"
    github_app_secret_directory=""
  fi
}
