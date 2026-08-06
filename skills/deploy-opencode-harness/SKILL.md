---
name: deploy-opencode-harness
description: Install, repair, or resume one isolated OpenCode Harness for an existing GitHub repository using whatever server access and deployment tools are available.
---

# Deploy OpenCode Harness

Разверни один Harness для одного существующего GitHub-репозитория и доведи установку до проверенного результата. Не требуй конкретный hosting provider, API, SSH transport или заранее заданную форму credentials: сначала исследуй доступные tools, sessions, files и secret references, затем сам выбери безопасный путь.

Все сообщения оператору пиши по-русски. Не проси оператора разбираться в способе установки, выбирать runtime topology или выполнять обычные reversible шаги. Вопрос допустим только для недоступного credential/authority, ручной регистрации GitHub App или реального identity collision.

## Product contract

- Установка создаёт ровно два service roles: публичный `harness` и приватный `opencode-runtime`.
- `harness` содержит authenticated web gateway и Issue worker.
- `opencode-runtime` содержит OpenCode server, SQLite, model execution и model gateway key. Он не получает web password или session-signing secret.
- Repository-scoped GitHub App App ID, Installation ID, owner, repository, base branch и read-only PEM доступны и `harness`, и `opencode-runtime`.
- Standard OpenCode `build` agent получает writable checkout project repository, полный доступ к инструментам внутри workspace и GitHub authentication через `harness-github`.
- Coding agent сам создаёт commit, push'ит `opencode/issue-*` и создаёт или переиспользует draft PR в `stage` через `harness-github git` и `harness-github gh`.
- Обычный Issue flow всегда заканчивается draft PR в `stage`. Никакой текст модели, label, успешная проверка или таймер не запускает merge автоматически.
- `/merge stage`, `/merge stage #<issue>` и `/merge prod` — command prompts для того же standard OpenCode `build` agent. Harness не создаёт отдельную release role и не выполняет merge in-process.
- `/merge prod` всегда создаёт или переиспользует PR `stage -> main`; feature branch никогда не мержится прямо в `main`.
- Возможность push или merge определяется Release App permissions и, когда они доступны, GitHub rulesets; OpenCode agent permissions не являются security boundary.
- GitHub Team/Pro не является prerequisite: Harness обязан устанавливаться и на private repository без платных Rulesets, но installer явно фиксирует более слабую branch-integrity гарантию.

## Phase 1: discover access

1. Определи repository из текущего checkout, GitHub context или уже предоставленного URL. Если repository нельзя доказать, запроси только `owner/repository`.
2. Найди любые уже доступные server credentials или deployment tools. Если доступа нет, попроси предоставить любой рабочий способ доступа или локальный secret reference; не перечисляй providers и не навязывай формат.
3. Выполни только non-mutating preflight и нормализуй фактические возможности через `scripts/installer_state.py`:
   - bounded command execution;
   - deployment definition materialization;
   - persistent storage;
   - secret storage/rotation;
   - service inspect/reconcile/start/stop/restart;
   - one public HTTPS route;
   - private Harness-to-runtime probe;
   - bounded status and diagnostics.
4. Вычисли deterministic identity `harness-<owner>-<repo>-<hash8>`. Reconcile только compatible resource с тем же repository identity. При collision остановись, ничего не перезаписывай и не создавай второй Harness.

Никогда не читай и не меняй target application, его database, containers, volumes, secrets, domains, logs или deployment. Доступ к серверу используется только для Harness-owned resources.

## Phase 2: manual Release App checkpoint

Сгенерируй exact instructions из `assets/release-app-registration.md` для repository-scoped GitHub App с именем `<repo>-release-app` (далее Release App):

Сначала прочитай `owner.type` из verified GitHub repository metadata и подставь в шаблон кликабельные Markdown-ссылки:

- для `Organization`: create URL `https://github.com/organizations/<owner>/settings/apps/new`, settings URL `https://github.com/organizations/<owner>/settings/apps`;
- для `User`: create URL `https://github.com/settings/apps/new`, settings URL `https://github.com/settings/apps`.

Не ограничивайся текстом «откройте GitHub Settings»: в checkpoint всегда явно выведи обе ссылки с понятными подписями. Не угадывай organization URL для user-owned repository и наоборот.

- Metadata: read-only;
- Contents: read/write;
- Issues: read/write;
- Pull requests: read/write;
- Checks: read-only;
- Administration: disabled;
- installation: only the target repository;
- webhook: disabled, потому что Harness использует polling.

Это обязательный manual checkpoint: остановись и дождись, пока owner создаст App, установит её и даст числовые App ID и Installation ID плюс локальный путь или secret reference на скачанный PEM. Owner и repository возьми из verified repository coordinate; base branch равна `stage`. Никогда не проси вставлять PEM contents в чат.

После resume прочитай App ID, Installation ID, owner, repository, base branch и PEM один раз, удерживай secret material только в памяти и запусти `scripts/github_app_verifier.py`. Bind verified values как `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_OWNER`, `GITHUB_REPO` и `GITHUB_BASE_BRANCH`. Откажись при неверном App ID, несовпадающем Installation ID, нуле/нескольких installations, лишнем repository, недостающем permission или любом Administration access.

## Phase 3: branches and rules

1. Запусти `scripts/github_branches.py`: `main` обязан существовать. Если `stage` отсутствует, создай её ровно на текущем SHA `main`. Существующую `stage` никогда не reset, force-push, delete или replace.
2. Release App не получает Administration permission. Для namespaced rulesets используй отдельную temporary bootstrap authority или owner action.
3. Разреши один из двух branch-policy modes и сохрани его в metadata `branch_policy_mode`:
   - `protected-rulesets`: запусти plan/apply/read-back через `scripts/github_rulesets.py` для `harness-stage` и `harness-production`; не ослабляй unrelated rulesets, reviews или checks; после verified read-back переведи state через `rulesets-verified` в `branch-policy-resolved`;
   - `unprotected-degraded`: только если GitHub Rulesets API для private repository вернул `403` или `404` с явным plan/upgrade/feature-unavailable объяснением, сохрани `last_error_code=rulesets_feature_unavailable_private_plan`, не пытайся повторно mutate rulesets и переведи state в `branch-policy-resolved`.
4. Если bootstrap authority просто отсутствует или API error не доказан как plan limitation, выдай exact minimal owner instructions и сохрани phase `awaiting-ruleset-authority`; ambiguous `403/404` не ослабляет policy автоматически.
5. В `unprotected-degraded` Installation продолжается без GitHub Team/Pro. Явно сообщи, что `main` и `stage` не защищены server-side: Release App с `Contents: write` технически может писать в них, а соблюдение PR topology обеспечивается contract/trust, не GitHub enforcement.

## Phase 4: deploy or reconcile

1. Используй canonical topology `assets/harness-compose.yml` как desired runtime contract. Переведи её в доступный deployment mechanism только после явного mapping каждой required capability на реальный tool/action.
2. Сгенерируй один раз strong web login/password, command token, health token, runtime token и session-signing secret. Сохраняй значения только через discovered secret capability; persisted state содержит только opaque references.
3. Model URL, model ID и model key возьми из уже доступного operator environment. Если binding отсутствует, запроси только secret reference, не значение в чате.
4. Передай одинаковые `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_BASE_BRANCH` и один read-only PEM mount обоим сервисам. Web login и session secret остаются только в `harness`; model key остаётся только в `opencode-runtime`.
5. Для Compose marker `__VOID_AI_API_KEY_AT_DEPLOY__` должен встречаться ровно один раз до render и ни разу после. replace the marker only in memory. Never store `VOID_AI_API_KEY` as a Service environment variable.
6. Перед update сохрани last-known-good non-secret deployment description. При failed rollout восстанови её и останови failed revision. Never call DELETE.
7. Persist resume state через `scripts/installer_state.py` с mode-equivalent `0700/0600`. Не сохраняй PEM, tokens, passwords, model key или one-time web credential envelope в state JSON.

## Phase 5: verify

До успеха проверь:

- снаружи публичный HTTPS URL без session получает redirect/login или `401`, но не OpenCode content;
- корректный login открывает Harness web gateway;
- private `opencode-runtime` не имеет public route и принимает только internal bearer от Harness;
- `/live`, `/ready`, `/health/worker` и token-protected `/identity` соответствуют ожидаемому repository;
- Release App видит только target repository и имеет точный permission floor без Administration;
- `main` и `stage` существуют, а `branch_policy_mode` совпадает с фактическим режимом; для `protected-rulesets` также проверь `harness-stage` и `harness-production` read-back, для `unprotected-degraded` повторно подтверди plan limitation и отсутствие заявлений о server-side protection;
- standard OpenCode agent открывается в persistent writable checkout target repository и имеет edit/bash/GitHub tools;
- coding agent создаёт commit, push и draft PR в `stage` самостоятельно;
- `/merge` выполняется standard OpenCode `build` agent через `gh`; Harness не выполняет merge in-process;
- runtime не получает web credentials; Harness не получает model key;
- deployed images immutable и проходят `references/image-release.md` verification.

Не создавай smoke Issue, PR или production promotion без отдельной явной просьбы пользователя.

## Resume invariants

- Resume from the latest persisted non-secret phase: `preflight`, `awaiting-github-app`, `github-app-verified`, `branches-verified`, `awaiting-ruleset-authority`, `rulesets-verified`, `branch-policy-resolved`, `deployed`, `verified`, `reported`.
- Re-discover remote state before each mutation and bind only to the same repository and deterministic Harness identity.
- Completed idempotent steps are no-op unless observed evidence disappeared.
- После финального ответа удали local one-time web credential envelope и переведи state в `reported`.

## Idempotence invariants

- Одинаковые inputs reconcile the same Harness; uncertain response не является причиной создать второй.
- Branch creation, ruleset apply, branch-policy resolution, secret generation и service creation выполняются at most once per desired-state digest.
- Repeated `/merge` requests require the standard OpenCode agent to re-read current GitHub state with `gh` and treat an already completed operation as a no-op.
- Never call DELETE. Repair compatible drift or stop on incompatible ownership.

## Security invariants

- Never print, log, commit, persist or echo PEM, server credentials, bootstrap authority, installation token, model key, internal tokens or secret-bearing API bodies.
- Repository-scoped GitHub App credentials доступны обоим сервисам; web authority остаётся только в `harness`, а model key и OpenCode database — только в `opencode-runtime`.
- В `unprotected-degraded` не называй `main` или `stage` защищёнными: branch integrity зависит от ограниченного App scope и следования operational contract.
- Harness и runtime используют distinct UID/PID namespaces; общий GID разрешён только для setgid `context` и `runs`.
- Project workspace доступен runtime на запись; Harness никогда не reset/clean local branch или uncommitted changes. Private Harness state остаётся `0700`; no Docker socket or privileged mode.
- Final output contains no verification evidence, App metadata or infrastructure credentials.

## Result contract

После successful verification верни exactly три строки без heading, bullets, code fence, blank line или trailing prose:

url: <https-url>
login: <generated-login>
password: <generated-password>
