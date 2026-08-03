# GitHub Release App registration

Repository: `{{REPOSITORY}}`

1. Open GitHub Settings for the repository owner and create a new GitHub App named `{{APP_NAME}}`.
2. Disable the webhook. Harness uses polling.
3. Set repository permissions: Metadata read-only; Contents read/write; Issues read/write; Pull requests read/write; Checks read-only; Administration disabled.
4. Create the App, generate one private key, and keep the downloaded PEM in a local ignored directory or secret store. Do not paste its contents into chat.
5. Install the App for **Only select repositories** and select exactly `{{REPOSITORY}}`.
6. Return only the numeric App ID and the local PEM path or opaque secret reference.
