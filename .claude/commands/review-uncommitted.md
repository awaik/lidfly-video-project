---
allowed-tools: Bash(git diff:*), Bash(git status:*), Bash(git ls-files:*), Bash(wc -l:*), Bash(npm run check:skills:*), Read, Grep, Glob
description: Code review незакоммиченных изменений
---

Собери все незакоммиченные изменения и проанализируй их.

Изменённые отслеживаемые файлы:
```bash
git diff
```

Застейдженные изменения:
```bash
git diff --cached
```

Новые (неотслеживаемые) файлы — прочитай их целиком через Read:
```bash
git status --short
git ls-files --others --exclude-standard
```

---

Ты senior Node.js разработчик. Проведи ревью для **lidfly-video-project** — API-first генерация коротких вертикальных видео (Reels/Shorts) через EVOLINK (Seedance 2.5/2.0, Kling O3/V3), Komend TTS для русской озвучки и agent skills для Claude Code / Codex / Cursor / OpenClaw.

Стек: Node.js ≥20, чистый ESM `.mjs`, без TypeScript и без внешних npm-зависимостей (только stdlib), `node --test`. Политика проекта — `CLAUDE.md` / `AGENTS.md`.

## Архитектура

```
src/
├── cli.mjs               # точка входа (npm run video)
├── config/env.mjs        # загрузка .env
├── core/                 # validation, errors/redact — provider-agnostic
├── domain/               # нормализация video-request, независима от провайдеров
├── workflows/            # жизненный цикл job: plan → submit → refresh → wait
└── providers/            # адаптеры: evolink/ (client, model-catalog), komend/ (TTS)
skills-source/            # канонические skills → build:skills → .agents/.claude/.codex/.openclaw
artifacts/jobs/<shot>/<take>-<hash>/   # job.json, manifests, events/, outputs/
projects/<name>/          # продакшен-артефакты с B-версиями (audio, graphics, edits)
tests/                    # node --test, только моки и fixtures
```

## Проверь в первую очередь

**Границы слоёв и изоляция провайдеров (нарушение = MAJOR/CRITICAL)**
- `core/` и `domain/` не импортируют из `providers/` и `workflows/` — различия Kling/Seedance/Komend только в адаптерах
- Провайдеры не импортируют друг друга; связывает их только `workflows/`
- Никаких новых npm-зависимостей — проект намеренно на голой stdlib; добавление пакета только по явному решению пользователя
- Изменённые файлы желательно < 500 строк — прогони `wc -l` по затронутым

**EVOLINK и выбор модели**
- Для видеогенерации только EVOLINK (`EVOLINK_API_KEY`); появление first-party BytePlus/Kling или другого gateway без явного решения — CRITICAL
- `model_id` только из allowlist `src/providers/evolink/model-catalog.mjs` (`EVOLINK_MODELS`); конструирование model ID конкатенацией строк из имени/mode/varianta — CRITICAL
- Семейства: `seedance-2.5` (default при пропущенном `model`), `seedance-2.0`, `kling-o3`, `kling-v3`. «Kling O3» — неоднозначный alias: точный `resolved_model_id`, `upstream_family` и docs-ссылка фиксируются в capability snapshot
- Нет тихого fallback на другую модель или провайдера — смена должна быть видна пользователю и записана в `job.json`
- Komend TTS — только для русской озвучки после review, когда нативная речь `missing`/`unusable`; вызов TTS «потому что есть текст» — нарушение
- Документированные лимиты моделей (разрешения, число референсов, длительности, роли) enforce'ятся в catalog-слое с понятной ошибкой, а не отдаются провайдеру «как есть»

**Артефакты, jobs и B-версии (потеря данных = CRITICAL)**
- Ничего не удаляется и не перезаписывается: исходные медиа, результаты, отклонённые генерации, промежуточные файлы — новые рендеры только новыми артефактами с явным происхождением
- Immutable-паттерн: manifests через `writeJsonOnce` / `flag: "wx"`; `job.json` — только через `persistState` с событием в `events/`; скачивание через `.partial` + link/unlink
- B-версии (`B1`, `B2`, …) монотонны, не переиспользуются и не переименовываются; принятый вариант не заменяет предыдущие
- В job сохраняются provider, `resolved_model_id`, параметры кадра, prompt, `remote_task_id`, фазы, usage и `provider_error` — всё нужное для воспроизводимости

**Секреты и redaction**
- `EVOLINK_API_KEY`, `TTS_KOMEND_AUTH_TOKEN` только из env; в коде, логах, manifests, примерах `examples/` и артефактах `projects/` секретов быть не должно
- Всё, что пишется на диск из provider-ответов, — через `redact()` из `src/core/errors.mjs`; новые поля с токенами/подписанными URL должны попадать под существующие паттерны redact (иначе — расширить их)
- `.env` не попадает в git; примеры — только в `.env.example`

**Надёжность async jobs**
- Каждый `fetch` с `AbortSignal.timeout(...)`; голый fetch без таймаута — MAJOR
- Polling ограничен deadline + backoff (паттерн `waitForTask`); retry только для `ProviderError.retryable` (429/5xx)
- Идемпотентность: повторный submit не создаёт второй платный task (`remote_task_id`-guard); ambiguous/terminal фазы (`submission_started`, `submission_unknown`, `submission_rejected`) не обходятся
- Платное действие только под explicit `--execute` / `execute: true`; код, запускающий генерацию, публикацию или удаление удалённых jobs по умолчанию, — CRITICAL
- Входные данные через хелперы `src/core/validation.mjs` (`assertNoUnknownKeys`, `oneOf`, `requiredString`, …) — неизвестные ключи отклоняются

**Тесты**
- Никаких реальных платных вызовов из тестов — только mock fetch и обезличенные fixtures; реальный ключ в тестах — CRITICAL
- Новый провайдер или model-specific параметр → контрактный тест адаптера + проверка нормализации ошибок
- Багфикс → регресс-тест в `tests/*.test.mjs` или `scripts/test-skills.mjs`

**Skills (single-source)**
- Правки только в `skills-source/<skill>/`; diff в `.agents/`, `.claude/`, `.codex/`, `.openclaw/` без соответствующего изменения канона = ручная правка клиентской копии — MAJOR; изменение канона без пересборки копий — тоже
- Если skills затронуты — прогони `npm run check:skills` и приложи результат
- `SKILL.md` frontmatter: только `name` и `description`; имя каталога = `name`, lowercase hyphen-case
- `agents/openai.yaml`: `display_name`, `short_description`, `default_prompt` с явным `$<skill-name>`
- Только реально используемые `scripts/`, `references/`, `assets/`; ссылки `$skill-name` указывают на существующие skills

## Напоминания (не часть самого ревью, упомяни если применимо)

- Изменён канонический skill → `npm run build:skills`, затем `npm test`
- Изменены провайдеры/domain/workflows → `npm run test:contracts`
- Изменены skills-скрипты синхронизации → `npm run test:skills`
- Новые примеры в `examples/requests/` — без реальных подписанных URL и токенов

---

## Формат ответа

**🔴 CRITICAL** — утечка секретов, model ID мимо allowlist, тихий fallback модели/провайдера, платный вызов без explicit execute или из тестов, удаление/перезапись артефактов и B-версий, обход immutable-паттерна jobs

**🟡 MAJOR** — нарушение границ слоёв, fetch без таймаута, неидемпотентный submit, запись provider-ответов без `redact()`, ручная правка клиентских копий skills или канон без пересборки, новая npm-зависимость, файлы > 500 строк, model-specific параметр без контрактного теста

**🟢 MINOR** — стиль, нейминг, magic numbers, оптимизации, мелочи описаний

Будь кратким. Указывай `файл:строка` и что конкретно исправить. Если изменения чистые — так и скажи.
