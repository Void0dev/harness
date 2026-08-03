# Harness

Harness — это дополнение к уже существующему проекту. Оно публикует защищённый web-интерфейс OpenCode, подключает чат к исходному коду проекта в режиме чтения и превращает GitHub Issues в изменения кода и draft PR в `stage`.

Codex в runtime не используется. OpenCode работает и как чат, и как coding agent.

## Как выглядит один сценарий

1. Пользователь открывает OpenCode Web и обсуждает задачу с моделью.
2. Команда `/issue <текст>` создаёт GitHub Issue с label `ai:todo` и сохраняет ID родительской чат-сессии.
3. Harness замечает Issue и создаёт дочернюю OpenCode-сессию.
4. Дочерняя сессия работает в отдельном временном клоне `stage`, меняет код и запускает проверки.
5. Coding agent коммитит изменения, получает короткоживущий Release App installation token через `harness-github`, push'ит ветку `opencode/issue-*` и создаёт или переиспользует draft PR в `stage`.
6. Harness проверяет, что ожидаемый открытый draft PR действительно появился, сохраняет ссылку и завершает Issue.
7. Родительская и дочерняя сессии сохраняются и видны в OpenCode Web.

На этом обычный Issue flow всегда останавливается. Merge выполняется только отдельной authenticated командой: `/merge stage`, `/merge stage #<issue>` или `/merge prod`. Команда запускает обычный `release agent`, который читает текущее состояние GitHub и работает через `harness-github gh`. `/merge prod` создаёт или переиспользует только PR `stage -> main`; feature-ветка никогда не мержится прямо в `main`.

Если worker задаёт вопрос, Issue переходит в `ai:needs-human`, а сам вопрос появляется в родительском чате. Первое обычное сообщение пользователя передаётся в ту же дочернюю сессию, после чего работа продолжается. Если commit, push или создание PR не завершились, `/retry` продолжает ту же дочернюю сессию и агент повторяет GitHub-операцию без отдельного publisher pipeline.

Для каждого Issue в его исходном месте истории появляется один ответ Harness слева. Пока worker занят, этот ответ показывает компактное анимированное «Размышление» и только текущий процесс. После завершения временный прогресс заменяется обычным текстовым итогом и ссылками на изменения и Pull Request. Вопрос разработчику или техническая ошибка отображаются тем же ответом. Состояние хранится в Harness и восстанавливается после обновления страницы.

На настоящий вопрос worker нужно ответить обычным сообщением в том же чате. После технической ошибки используется явная команда `/retry`, поэтому обычный разговор не запускает код повторно случайно.

Одновременно выполняется только один Issue.

## Два сервиса

- Публичный `harness` принимает HTTPS-трафик, проверяет web-сессию, опрашивает Issues, запускает child sessions и проверяет созданные PR.
- Приватный `opencode-runtime` запускает OpenCode, coding agent и release agent, хранит SQLite и получает model gateway key.
- Оба сервиса получают credentials одной repository-scoped Release App. Runtime использует их только через `harness-github`, который выпускает короткоживущий installation token отдельно для каждой команды; web password и session-signing secret остаются только в `harness`, model key — только в runtime.

## Что где хранится

- `$HARNESS_DATA_DIR/context` — отдельный checkout ветки `stage` только для чтения в чате. Он периодически обновляется.
- `$HARNESS_DATA_DIR/opencode` — постоянная история OpenCode-сессий.
- `$HARNESS_DATA_DIR/workspaces` и `$HARNESS_DATA_DIR/runs` — временные рабочие копии и данные запусков.
- GitHub — Issues, ветки и pull requests.

Большое количество веток не хранится в chat checkout. Для каждого Issue создаётся отдельный временный клон, а после push и создания PR источником истины снова остаётся GitHub.

## Skill

| Skill | Назначение |
| --- | --- |
| [`deploy-opencode-harness`](skills/deploy-opencode-harness/SKILL.md) | Обнаруживает доступный способ развёртывания, настраивает Release App и rulesets, устанавливает два сервиса и проверяет результат. |

Coolify не обязателен для локального теста. В production размещается только Harness stack из двух сервисов; skill не читает, не меняет и не деплоит целевое приложение.

## Основные компоненты

```text
Public Harness
├── authenticated web gateway
├── опрашивает GitHub Issues
├── создаёт дочернюю сессию через OpenCode Server API
├── хранит состояние одной активной задачи
└── проверяет созданный coding agent draft PR

Private opencode-runtime
├── OpenCode server и SQLite
├── обычный чат с read-only контекстом stage
├── coding agent: commit, push, draft PR в stage
├── release agent: явный merge в stage или promotion stage -> main
└── model execution, model gateway key и harness-github
```

Для чата и кода используется один gateway:

```text
VOID_AI_BASE_URL=https://ai-gateway.void0.org/v1
VOID_AI_API_KEY=<секретный ключ>
VOID_AI_MODEL_ID=<точный ID модели, доступной через gateway>
```

`VOID_AI_API_KEY` передаётся только приватному `opencode-runtime`. Публичный `harness` не получает ключ модели.

## Локальная проверка на Windows

Используйте отдельный тестовый GitHub-репозиторий. Ветка `main` должна существовать. Установщик создаёт отсутствующую `stage` один раз на текущем SHA `main`; существующую `stage` он не reset'ит и не заменяет. Установите Release App только на этот репозиторий и выдайте ей Metadata read-only, Contents read/write, Issues read/write, Pull requests read/write и Checks read-only без Administration.

1. Создайте локальный env-файл:

   ```powershell
   Copy-Item .env.local.example .env.local
   ```

2. Заполните в `.env.local`:

   ```text
   GITHUB_APP_ID=
   GITHUB_APP_INSTALLATION_ID=
   GITHUB_APP_PRIVATE_KEY_PATH=/run/secrets/github-app.pem
   GITHUB_OWNER=
   GITHUB_REPO=
   HARNESS_COMMAND_TOKEN=
   VOID_AI_API_KEY=
   VOID_AI_MODEL_ID=
   OPENCODE_SERVER_PASSWORD=
   HARNESS_HEALTH_DETAILS_TOKEN=
   ```

   Положите PEM-ключ Release App в корень Harness под именем `github-app-private-key.pem`. `HARNESS_COMMAND_TOKEN` и `HARNESS_HEALTH_DETAILS_TOKEN` должны быть разными случайными строками длиной не меньше 32 символов. Не коммитьте `.env.local` или PEM-файл.

3. Проверьте Compose:

   ```powershell
   docker compose --env-file .env.local -f docker-compose.local.yml config --quiet
   ```

4. Соберите и запустите:

   ```powershell
   docker compose --env-file .env.local -f docker-compose.local.yml build
   docker compose --env-file .env.local -f docker-compose.local.yml up
   ```

5. Откройте `http://localhost:4096` и войдите с username `opencode` и паролем из `OPENCODE_SERVER_PASSWORD`.

6. Сначала задайте обычный вопрос о тестовом проекте. Чат должен читать код, но не менять файлы.

7. В том же чате отправьте:

   ```text
   /issue Добавь маленькое безопасное изменение и соответствующий тест
   ```

8. Ожидаемый результат в GitHub:

   - Issue получил `ai:todo`, затем `ai:running`;
   - в OpenCode Web появилась worker-сессия;
   - появилась ветка `opencode/issue-<номер>-...`;
   - создан draft PR в `stage`;
   - Issue получил `ai:finished` и ссылку на PR;
   - PR остаётся draft и не мержится без отдельной `/merge` команды.

9. Остановка:

   ```powershell
   docker compose --env-file .env.local -f docker-compose.local.yml down
   ```

Каталог `.local-harness` сохраняет context, state, рабочие копии и сессии между перезапусками.

## Проверки разработки

В Linux/macOS используются те же scripts без Windows-суффикса: `npm run lint`, `npm run typecheck`, `npm run build` и `npm test`.

```powershell
npm.cmd ci
npm.cmd run lint
npm.cmd run typecheck
npm.cmd run build
npm.cmd test
```

Отдельные проверки OpenCode:

```powershell
npm.cmd exec -w services/issue-harness -- tsx --test test/env.test.ts test/opencode.test.ts test/context.test.ts
node --test opencode/test/issue.test.mjs
```

## Безопасность

- Не храните credentials в Git.
- Не храните installation token в Git, state или remote URL: `harness-github` получает его заново для каждого `git`/`gh` процесса.
- `VOID_AI_API_KEY` получает только приватный `opencode-runtime`; Release App PEM получают оба repository-scoped сервиса; web password и session-signing secret получает только `harness`.
- В production используйте pinned digests для Issue Harness и OpenCode Web.
- Sandcastle, model broker и Docker socket в этой архитектуре отсутствуют.
- `main` никогда не создаётся. Отсутствующая `stage` создаётся один раз на текущем SHA `main`; существующие ветки никогда не reset'ятся и не force-push'ятся skill.
