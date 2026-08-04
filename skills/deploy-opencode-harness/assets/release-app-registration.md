# GitHub Release App registration

Repository: `{{REPOSITORY}}`

Create App: [Open the GitHub App creation form]({{CREATE_APP_URL}})

Owner App settings: [Open the GitHub Apps settings page]({{APPS_SETTINGS_URL}})

1. Open the creation link above and create a new GitHub App named `{{APP_NAME}}`.
2. Disable the webhook. Harness uses polling.
3. Set repository permissions: Metadata read-only; Contents read/write; Issues read/write; Pull requests read/write; Checks read-only; Administration disabled.
4. Create the App, generate one private key, and keep the downloaded PEM in a local ignored directory or secret store. Do not paste its contents into chat.
5. Open the owner App settings link above, select the created App, choose **Install App**, then use **Only select repositories** and select exactly `{{REPOSITORY}}`.
6. Record the numeric App ID and Installation ID. Return those identifiers plus the local PEM path or opaque secret reference; do not return PEM contents.
7. The installer binds the verified repository owner, repository name, and `stage` base branch and supplies the same Release App credentials and read-only PEM to both `harness` and `opencode-runtime`.
