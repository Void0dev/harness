---
name: deploy-opencode-harness
description: Use when installing one existing GitHub repository's customer-facing OpenCode Harness in the same existing Coolify environment as that repository's application.
---

# Установка OpenCode Harness для одного проекта

Создай ровно один новый Coolify Service `harness` для одного репозитория. В нём только `issue-harness` и `opencode-web`. Никогда не читай, не меняй, не деплой, не перезапускай и не инспектируй ресурсы целевого приложения: его контейнеры, базы, volumes, секреты, домены, логи или переменные.

## Язык и обязательный маршрут

All messages to the operator must be in Russian. Все сообщения оператору, включая чек-лист, запросы апрува, ошибки и итог, пиши только по-русски. Не показывай английские шаблоны сообщений пользователю.

Пройди только по обязательному маршруту ниже. Не добавляй проверки, API-запросы, поиск альтернативных endpoint, тестовые Issue/PR или действия «на всякий случай». Вопрос возможен лишь когда ответ действительно необходим для продолжения (например, API вернул несколько серверов) либо оператор сам попросил иной шаг.

## Перед вводом семи полей

Сначала по-русски покажи оператору этот чек-лист. Затем попроси **все семь полей одним сообщением**. Не проси апрув при получении полей.

1. Создать отдельный GitHub App для этого проекта и установить его **только на один нужный репозиторий**. Права: Metadata — read-only; Contents, Issues, Pull requests — read/write; Administration — disabled. Скачать private PEM в локальную игнорируемую папку, например `C:\harness-secrets\<project>.private-key.pem`. Никогда не проси вставлять содержимое PEM в чат.
2. Убедиться, что в репозитории уже существуют `main` и `stage`. Не создавай и не проверяй ветки во время установки.
3. Создать API-токен именно того Coolify, где находится целевой проект. Для каждого Coolify-сервера токен отдельный. Сохранить его локально, например `C:\harness-secrets\<project>-coolify.env`, с единственной строкой `COOLIFY_TOKEN=<token>`. Никогда не проси вставлять токен в чат.
4. Убедиться, что в локальном checkout Harness есть `.env.local` с общим `VOID_AI_API_KEY`. Не спрашивай модель, URL, ID, ключ или путь к этому файлу.
5. Узнать точную версию Coolify (например, `4.0.0-beta.470`) в интерфейсе этого Coolify.

Ask for exactly these seven fields, with a one-line explanation of each:

```text
coolify_environment_url: браузерная ссылка на точный существующий environment Coolify, где уже работает сайт
coolify_version: точная версия Coolify из этого же инстанса, например 4.0.0-beta.470
coolify_token_env_path: локальный путь к файлу этого проекта с COOLIFY_TOKEN
github_app_id: числовой App ID отдельного GitHub App этого проекта
pem_path: локальный путь к скачанному private-key .pem этого GitHub App
chat_login: логин клиента для OpenCode Web
chat_password: пароль клиента для OpenCode Web
```

Ссылка environment — единственный выбор места. Never ask for a repository URL, model details, DNS/domain, server UUID, destination UUID, Docker settings, or resource limits. Never ask the user to paste PEM contents.

## Апрувы и граница действий

No approval is needed to parse the supplied environment URL. Извлеки локально только origin, `project_uuid` и `environment_uuid` из уже присланной ссылки; это не действие на сервере.

После семи полей действуй строго по таблице. Only these seven approved actions are part of the normal installation. Каждый пункт требует ровно один ответ `approve <номер>` до выполнения. Объединяй безопасные локальные чтения в один шаг; не дроби их.

| № | Действие после апрува |
| --- | --- |
| 1 | Один grouped local-secret read: прочитать в память `coolify_token_env_path`, `pem_path` и локальный `.env.local` Harness; проверить только наличие нужных переменных/файлов, не выводя секреты. |
| 2 | GitHub App: по PEM и App ID получить installation ID и удостовериться, что App открывает ровно один репозиторий. |
| 3 | Coolify: `GET /api/v1/servers`; при ровно одном пригодном сервере выбрать его автоматически. |
| 4 | Создать новый Service `harness` готовым Compose одним `POST /api/v1/services`. |
| 5 | Передать только переменные нового Harness одним `PATCH /api/v1/services/{harness_uuid}/envs/bulk`. |
| 6 | Запустить только этот Harness через restart. |
| 7 | Прочитать только состояние и FQDN нового `opencode-web`, вернуть ссылку чата. |

Before every read or write in this table, require a separate exact `approve <number>`. Формат запроса на апрув всегда по-русски:

```text
Действие <номер>: <простое описание>
Цель: <точный локальный файл, GitHub-репозиторий или UUID нового Harness>
Результат: <что будет прочитано или изменено>
Затрагивает: только Harness или его входные данные
Нужно подтверждение: approve <номер>
```

Любой другой ответ — ничего не делать. После шага сообщай только несекретный результат и следующий апрув. Read each local secret file once per installation и дальше reuse the retained in-memory token or key; никогда не проси следующий апрув только ради повторного чтения неизменённого секрета. Никогда не выводи, не коммить, не записывай на диск и не возвращай PEM, токен Coolify, ключ модели, пароль чата или внутренние токены. Never call DELETE.

При нескольких серверах спроси у оператора имя нужного сервера и затем повтори только действие 3 с его выбором. При ответе о нескольких destinations или занятом имени `harness` остановись и объясни причину; не ищи endpoint destinations и не трогай environment. Never call a `/servers/{server_uuid}/destinations` endpoint, environment-details endpoint, target resource list, или любые ресурсы сайта. Если API уже вернул ошибку, обработай тело того же ответа; не делай отдельный «запрос чтения ошибки».

## Coolify command profiles

Используй профиль, соответствующий `coolify_version`. Если версия неизвестна, применяй Default profile и прямо укажи это в контексте следующего апрува; не изобретай другие запросы и не перебирай URL.

### Default profile

Текущий профиль по умолчанию повторяет проверенный `4.0.0-beta.470` без изменения команд:

- `GET /api/v1/servers`
- `POST /api/v1/services` с initial `docker_compose_raw`: Base64 точного UTF-8 готового Compose
- `PATCH /api/v1/services/{harness_uuid}/envs/bulk` с JSON `{ "data": [...] }`
- `POST /api/v1/services/{harness_uuid}/restart?latest=true`

### Coolify 4.0.0-beta.470

Это проверенный профиль для `4.0.0-beta.470`; команды идентичны Default profile:

- `GET /api/v1/servers`
- `POST /api/v1/services` с initial `docker_compose_raw`: Base64 точного UTF-8 готового Compose
- `PATCH /api/v1/services/{harness_uuid}/envs/bulk` с JSON `{ "data": [...] }`
- `POST /api/v1/services/{harness_uuid}/restart?latest=true`

Не вызывай `/deploy`: на этой версии он возвращает `404`. Не отправляй `type: "docker-compose"`; это не custom-Compose type. Omit `destination_uuid`: beta.470 выбирает единственный destination сервера сам.

## Содержимое создания и запуска

1. На действии 2 используй GitHub App из одобренных PEM и App ID, получи `GITHUB_APP_INSTALLATION_ID`. App должен открывать exactly one repository. Откажись при нуле/нескольких репозиториях, Admin permission, personal token или ином репозитории.
2. Используй только `coolify/harness.production.compose.yml` как production template. Он собирает оба контейнера из public Harness repository branch `main`, создаёт только Harness-owned volumes/secrets, монтирует GitHub PEM read-only только в `issue-harness`, оставляет worker private и применяет `cap_drop: ALL` и `no-new-privileges` к обоим. Не используй Docker socket, privileged mode, paths целевого приложения, ручные файлы сервера, GHCR packages или второй Coolify GitHub App.
3. В действии 1 прочитай `VOID_AI_API_KEY` из локального `.env.local` только в память. В шаблоне обязан быть ровно один `__VOID_AI_API_KEY_AT_DEPLOY__` внутри `configs.void-ai-api-key.content`, смонтированный только в `opencode-web` по `/run/secrets/void-ai-api-key`. replace the marker only in memory: до рендера ровно один marker, после — ни одного. Never store `VOID_AI_API_KEY` as a Service environment variable и никогда не передавай его `issue-harness`.
4. В Compose `opencode-web` должен содержать ровно `SERVICE_FQDN_OPENCODE_WEB_4096: /`: Coolify создаст случайный проксированный URL. Do not use a `Generate Domain` action, DNS или отдельный домен.
5. В действии 4 создай ровно один Service одним `POST /api/v1/services`: `name: "harness"`, `project_uuid`, `environment_uuid`, `server_uuid`, `instant_deploy: false`, initial `docker_compose_raw`. Не создавай пустой Service и не PATCH Compose при свежей установке. Для отдельно одобренной коррекции уже созданного Harness разрешён только `PATCH /api/v1/services/{harness_uuid}` с `docker_compose_raw` как Base64 exact UTF-8; перед отправкой локально декодируй и сравни байты. Do not send raw YAML and do not try alternate encodings.
6. В действии 5 запиши только данные нового Harness: identity репозитория, GitHub App, chat credentials, generated internal tokens и PEM-derived secret. Pin `GITHUB_BASE_BRANCH=stage` и `MAX_CONCURRENT_RUNS=1`. Не читай список env этого Service и не передавай туда `VOID_AI_API_KEY`.
7. В действии 6 используй только `POST /api/v1/services/{harness_uuid}/restart?latest=true`. В действии 7 не создавай тестовый Issue/PR. Верни только Coolify-generated URL чата и итоговый статус.

Итог: в выбранном environment появляется один изолированный Harness с двумя контейнерами и одной сгенерированной ссылкой для клиента.
