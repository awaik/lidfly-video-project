# LidFly Video Project

Система производства коротких видео (Reels, YouTube Shorts, 16:9, 1:1) под управлением ИИ-агентов: от сценария и проверенного шот-плана до генерации дублей, приёмки (QA), отдельной озвучки и сборки финального мастера.

Разработчик проекта — **[LidFly.ru](https://lidfly.ru)**.

## Как здесь создаются видео (для людей и для агентов)

В проекте есть **два маршрута генерации видеокадров** и **отдельный маршрут для звука**. Их можно использовать по отдельности или комбинировать в одном ролике (часть шотов снять через API, часть — через браузер):

1. **Через API ([EVOLINK](https://evolink.ai/)) — маршрут по умолчанию:**
   - Видео генерируется по API-ключу `EVOLINK_API_KEY` моделями **`seedance-2.5`** (выбирается по умолчанию), **`seedance-2.0`**, **`kling-o3`** (Video 3.0 Omni) и **`kling-v3`**.
   - Подходит, когда нужна предсказуемая пакетная генерация с расчётом стоимости до отправки (`plan` → `submit --execute` → `wait`).
2. **Через сайт Google Gemini в браузере (`gemini-browser`):**
   - Видео генерируется бесплатно/по подписке прямо на сайте `https://gemini.google.com/videos` в открытом профиле Chrome (агент сам вводит промпты, прикладывает референсы и скачивает оригинал через Chrome DevTools MCP / Puppeteer).
   - Скачанный MP4 принимается в проект командой `node src/cli.mjs browser-import` с проверкой хешей и параметров кадра.
3. **Озвучка — всегда отдельно от видео:**
   - Нативная звуковая дорожка видеомоделей в финальный монтаж не идёт.
   - Голос синтезируется отдельно через API OpenRouter (модель **`google/gemini-3.1-flash-tts-preview`**, голос `Leda`, скрипт `scripts/tts-openrouter.mjs`, ключ `OPENROUTER_API_KEY`) либо через Komend TTS (`TTS_KOMEND_AUTH_TOKEN`).

### Как поставить задачу (для человека)

- **Снять через браузер Gemini:** напишите агенту *«делаем ролик через браузер Gemini»* (или *«через сайт Gemini»*).
- **Снять через API:** напишите *«делаем через API»* (или укажите модель: *«через Seedance 2.5»*, *«через Kling O3»*). Если маршрут не указан, агент по умолчанию выберет API EVOLINK (`seedance-2.5`).
- **Скомбинировать:** можно попросить *«хук и кульминацию сними в Seedance 2.5, а остальные планы — через браузер Gemini»*.

### Как агент понимает, что делать (для агента)

1. **Инициализация и план:** любой полный ролик начинается со скилла `$produce-short-video` (`node scripts/init-production.mjs`) и построения шот-плана по `$develop-shot-plan` (`script init` → `script check` → независимое `script review` → `script freeze`).
2. **Выбор маршрута в `brief/shotplan.json` (до `script freeze`):**
   - если выбран **сайт Gemini**, в `target.model_default` и/или в `shot.route.model` записывается `"gemini-browser"`;
   - если выбран **API EVOLINK**, в `shot.route.model` записывается `"seedance-2.5"`, `"seedance-2.0"`, `"kling-o3"` или `"kling-v3"`.
3. **Сборка запросов (`node src/cli.mjs script compose`):**
   - для шотов с `"gemini-browser"` CLI создаёт `requests/S001-B1.json` (`schema_version: "browser-request/1"`). Агент выполняет их по скиллу `$generate-browser-video` в браузере и импортирует через `browser-import` (отправить такой файл в платный API невозможно — валидатор его отклонит);
   - для API-шотов CLI создаёт `requests/S001-T001.json` (`schema_version: 1`, `provider: "evolink"`). Агент выполняет их по скиллам `$generate-seedance-video`, `$generate-kling-3-video` или `$generate-kling-o3-video` через команды `plan` → `submit --execute` → `wait`.
4. **Проверка и монтаж (единые для обоих маршрутов):** каждый дубль проходит `$review-generated-video`, после чего собирается в мастер через `$assemble-short-video` (`assemble --require-review`) или интерактивный редактор `$edit-with-openchatcut` (`adopt-master`).


## Первые модели

| Ключ проекта | Каталожное имя | Режимы | Точные EVOLINK ID |
| --- | --- | --- | --- |
| `seedance-2.5` **(default)** | Seedance 2.5 | text/image/reference-to-video, video edit/extend | пять точных `seedance-2.5-*` ID из allowlist |
| `seedance-2.0` | Seedance 2.0 | text/image/reference-to-video | `seedance-2.0-*` из явного allowlist |
| `kling-o3` | Kling O3 | text/image/reference-to-video, video edit | `kling-o3-*`, документированное соответствие `kling-v3-omni` |
| `kling-v3` | Kling 3.0 | text/image-to-video | `kling-v3-*` |

Посмотреть весь allowlist без API-вызова:

```bash
npm run video -- models
npm run video -- doctor  # read-only проверка EVOLINK auth/credits, Komend token и локального тулчейна
```

`doctor` проверяет не только ключи, но и то, что реально ломается при сборке: наличие
ffmpeg/ffprobe/ImageMagick, работоспособность SVG-растеризатора (при отсутствии librsvg `stroke`
молча теряется) и наличие глифов кириллицы и знака `₽` в шрифтах-кандидатах. Ненулевой exit code
возвращается только при `status: error`; `warning` означает деградацию, при которой работать можно.

`seedance-2.5` идёт первым в списке и выбирается автоматически, если поле `model` отсутствует в
request. Явно выбранная другая модель не заменяется при ошибке: тихого fallback нет.

## Настройка

Требуется Node.js 20 или новее. Ключи читаются из серверного `.env` и никогда не записываются в manifests:

```dotenv
EVOLINK_API_KEY=...
OPENROUTER_API_KEY=...
TTS_KOMEND_AUTH_TOKEN=...
```

Шаблон находится в `.env.example`. Реальный `.env` исключён из Git.

## Референсы пользователя

Готовые фото персонажа, продукта или локации принимаются в проект до планирования. Оригинал пользователя копируется, а не перемещается, и никогда не перезаписывается:

```bash
npm run video -- assets add \
  --project projects/acme/V001 \
  --file ~/Downloads/hero-1.jpg \
  --asset-id hero-front \
  --role identity \
  --rights approved

npm run video -- assets list --project projects/acme/V001

# Влезает ли набор в выбранный режим — до платного вызова
npm run video -- assets check \
  --project projects/acme/V001 \
  --model kling-o3 --mode reference_to_video \
  --video-url https://cdn.example.com/reference.mp4 \
  --video-rights approved
```

Формат определяется по содержимому файла, а не по расширению, поэтому HEIC или видео с именем `.jpg` отсеиваются на входе. Реестр пишется в `projects/<client>/VNNN/assets.json`, оригиналы — в `assets/originals/`; `asset_id` выдаётся один раз и не переиспользуется.

`assets check` использует тот же каталог, что строит боевой payload, и возвращает `ok`, ёмкость режима и findings трёх уровней: `blocker` (запрос будет отклонён, exit code 1), `warning` (пройдёт, но рискует кадром — низкое разрешение, чужое соотношение сторон, дубликат) и `info`. Целевое соотношение берётся из `target.aspect_ratio` замороженного шот-плана; `--aspect-ratio` перебивает его, а `aspect_ratio_source` в отчёте говорит, откуда взялся ответ. Для обязательного видео в `kling-o3/reference_to_video` и `video_edit` передайте тот же публичный HTTPS URL через `--video-url` и подтверждённый статус через `--video-rights`; check валидирует URL и роль локально, не скачивая файл. `--rights` и `--video-rights` принимают только `approved` или `not_required` и фиксируют подтверждение пользователя на использование лица, логотипа или footage.

## Безопасный workflow

Сначала создайте JSON по одному из файлов в `examples/requests/`. У каждого reference обязательны стабильный `asset_id`, роль и `rights_status`.

```bash
# Сценарный гейт: план, проверка, независимое ревью, заморозка, сборка запросов
npm run video -- script check   --project projects/<client>/VNNN
npm run video -- script freeze  --project projects/<client>/VNNN
npm run video -- script compose --project projects/<client>/VNNN

# Только валидация и immutable plan; платного вызова нет
npm run video -- plan --request examples/requests/seedance-2.5-default-text.json

# Планирование целой партии запросов сразу, с общей оценкой стоимости
npm run video -- plan --requests projects/<client>/VNNN/requests --jobs-root artifacts/<client>/VNNN/jobs

# Явно авторизованный платный submit ровно один раз
npm run video -- submit --job artifacts/jobs/S001/T001-<hash> --execute

# Read-only запрос статуса существующего task
npm run video -- status --job artifacts/jobs/S001/T001-<hash>

# Bounded polling и загрузка временного результата в новый файл
npm run video -- wait --job artifacts/jobs/S001/T001-<hash>
```

Перед submit сохраняются normalized request, точный provider payload, snapshot возможностей и состояние задания. Если исход POST неоднозначен из-за сети, job переходит в `submission_unknown` и не может автоматически создать второй платный task. Polling всегда использует уже сохранённый task ID. Результаты и неудачные partial downloads не перезаписываются.

Разобрать такой повисший job помогает `reconcile`: он сверяет время сабмита и модель со списком задач провайдера.

```bash
npm run video -- tasks --limit 20
npm run video -- reconcile --job artifacts/.../S002/T001-<hash>            # только читает
npm run video -- reconcile --job artifacts/.../S002/T001-<hash> --adopt    # привязать найденную задачу
npm run video -- reconcile --job artifacts/.../S002/T001-<hash> --release  # задачи не было, открыть retry
```

При нескольких кандидатах команда ничего не решает сама и требует явный `--task-id`. Задача, уже привязанная к другому job, кандидатом не считается: ключ EVOLINK общий на все проекты.

Локальные JPEG/PNG (и WebP для Seedance) загружаются через документированный EVOLINK file API при `--execute`. Видео- и аудиореференсы пока принимаются только как доступные EVOLINK HTTP(S) URL.

## Komend TTS

В запросе можно сохранить блок `narration`. TTS разрешается только после review нативного звука:

```bash
npm run video -- tts \
  --job artifacts/jobs/S001/T001-<hash> \
  --native-audio-status missing \
  --execute
```

Допустимые статусы для вызова — `missing` и `unusable`. При `present` или `unreviewed` команда остановится. Поддерживаются голоса `ru_zhadyra` (`female`/`neutral`) и `ru_roman` (`male`), форматы MP3/WAV.

## Сценарный гейт

Платная генерация в проектном контексте начинается только с замороженного шот-плана: биты сценария разложены по шотам, событий в шоте не больше, чем его длительность способна отрисовать, кульминация занимает отдельный шот, континуити-якоря есть в каждом шоте, а план прочитал независимый рецензент.

```bash
npm run video -- script init   --project projects/<client>/VNNN --script <сценарий.md> --duration-seconds 30
npm run video -- script check  --project projects/<client>/VNNN   # findings, exit 1 при blocker
npm run video -- script review --project projects/<client>/VNNN --record <review.json>
npm run video -- script freeze --project projects/<client>/VNNN
npm run video -- script compose --project projects/<client>/VNNN [--dry-run]
```

Промпт собирается из плана и `brief/continuity.json`, поэтому поля `prompt` в шоте нет: лишнее действие невозможно протащить прозой мимо счётчика событий. Правка замороженного плана меняет его хеш, и гейт останавливает работу до нового ревью. Флага обхода нет; для уже отснятых проектов существует именной `approval.script_plan_waiver` со списком конкретных шотов.

## Бюджет и стоимость

Потолок расходов объявляется в `project.json` и **исполняется кодом**: перед любым сетевым вызовом
`submit` читает манифест проекта, суммирует фактические списания по всем job (`usage.cost.usd`) и
отказывает, если `approval.paid_generation` не выставлен или прогноз выходит за
`approval.max_total_cost`. Флага обхода нет — легальный путь один: поднять потолок в манифесте.

`plan` печатает ожидаемую стоимость до `--execute`. Цены измерены на реальных списаниях и хранятся
в каталоге моделей; неизмеренные маршруты честно отдают `unknown_rate`, а не выдуманное число.

```bash
npm run video -- jobs --jobs-root artifacts/<client>/VNNN/jobs   # индекс job: фаза, стоимость, ошибки
npm run video -- retry --job <dir> --change "что именно меняется"  # следующий take со связью
```

## Бюджет одной командой

```bash
npm run video -- budget --project projects/<client>/VNNN
```

Показывает списанное, зарезервированное сабмитами, остаток и сколько секунд генерации в него ещё влезает по текущей ставке. Команда только читает и к провайдеру не ходит.

## Сборка мастера

```bash
npm run video -- assemble --manifest projects/<client>/VNNN/edits/<variant>.edit.json
```

Монтаж описывается декларативным edit-манифестом: сегменты (живой шот, статика с движением, серия
состояний), оверлеи, микс. Длительности задаются **в кадрах** — номинальные секунды при 24 fps
округляются вниз и сдвигают весь хвост. Окна ducking выводятся из того, какие сегменты несут
production-звук. Мастер версионируется и никогда не перезаписывается; рядом сохраняется отчёт
верификации с измеренными числами (длительность, кадры, LUFS, true peak, black/freeze).

## Монтаж в OpenChatCut

Второй, интерактивный маршрут монтажа — [OpenChatCut](https://github.com/0xsline/OpenChatCut),
локальный агентный видеоредактор с MCP-сервером (AGPL-3.0). Он живёт в отдельном checkout рядом с
репозиторием (`../OpenChatCut`, путь переопределяется `OPENCHATCUT_DIR`) и требует Node 24, который
CLI находит сам через nvm или `OPENCHATCUT_NODE`. В этот репозиторий он не входит: после clone его
нужно установить отдельно. Интеграция проверена с версией 0.2.14 (коммит `19cba6e`, 2026-09-04).

### Установка OpenChatCut

Источник: `https://github.com/0xsline/OpenChatCut.git`. Нужны `git`, Node 24 (`nvm install 24`) и
сеть: установка тянет зависимости, ffmpeg/ffprobe и бинарник Electron, это несколько минут.

```bash
node src/cli.mjs openchatcut status     # present: false — редактор ещё не установлен
node src/cli.mjs openchatcut install    # клонирует в ../OpenChatCut, ставит зависимости, готовит .env.local
node src/cli.mjs openchatcut connect    # один раз: регистрирует MCP-сервер в Claude Code
npm run editor                          # поднимает редактор; первый запуск чеканит MCP-токен
```

`install` делает то, что вручную выглядело бы так:

```bash
git clone --depth 1 https://github.com/0xsline/OpenChatCut.git ../OpenChatCut
cd ../OpenChatCut
printf 'allow-remote=all\nallow-scripts=ffmpeg-static,@ffprobe-installer/darwin-arm64,esbuild,sharp,onnxruntime-node,electron,fsevents,protobufjs\n' > .npmrc
nvm use 24 && npm install
cp -n .env.example .env.local           # плюс AGENT_IMPORT_ROOTS с artifacts/, projects/, audio-library/ этого репозитория
```

Файл `.npmrc` обязателен: npm 12 по умолчанию отказывается качать tarball с чужого хоста реестра
(lock-файл редактора ссылается на два пакета с registry.npmmirror.com, ошибка `EALLOWREMOTE`) и
блокирует install-скрипты зависимостей, а именно они скачивают ffmpeg, ffprobe и Electron.
Оба файла локальные: `.env.local` игнорируется Git редактора, `.npmrc` остаётся единственным
untracked-файлом в его `git status`; коммитить их в checkout редактора не нужно.

Данные редактора (проекты, медиа, MCP-токен) лежат вне checkout, в изолированном dev-профиле
`~/.openchatcut/dev-profiles/<id>/`; id записан в `../OpenChatCut/.git/openchatcut-dev-profile.json`.
Удаление checkout их не трогает, и наоборот.

Обновление: `git -C ../OpenChatCut pull`, затем снова `node src/cli.mjs openchatcut install`
(повторный запуск не клонирует и не перезаписывает `.npmrc`, только ставит зависимости). После
обновления сверьте `skill_baseline` в `openchatcut status` со значением в
`skills-source/edit-with-openchatcut/references/openchatcut-session.md`: формы инструментов там
зафиксированы по проверенной версии.

Если что-то не сошлось:

- `EALLOWREMOTE` или «install scripts blocked» при `npm install` — в checkout нет `.npmrc` из блока выше;
- нет `node_modules/electron/dist` (нужен только для `--desktop`) — `nvm use 24 && node node_modules/electron/install.js` внутри checkout;
- порт 5199 занят — `npm run editor:stop` для процесса, запущенного через `up`, чужой процесс ищите через `lsof -i :5199`;
- checkout лежит в другом месте — задайте `OPENCHATCUT_DIR` в `.env`.

### Запуск и подключение

```bash
node src/cli.mjs openchatcut status    # read-only: checkout, Node 24, зависимости, .env.local, токен, endpoint
node src/cli.mjs openchatcut install   # клонировать (если нет) и npm install под Node 24
npm run editor                         # openchatcut up: поднять редактор в фоне и дождаться готовности endpoint
node src/cli.mjs openchatcut up --project-id <id>   # то же плюс открыть вкладку проекта и дождаться привязки
npm run editor:stop                    # остановить редактор, запущенный через up
npm run editor:foreground              # тот же сервер в текущем терминале (--desktop — Electron)
node src/cli.mjs openchatcut connect   # зарегистрировать MCP-сервер openchatcut в Claude Code (local scope)
```

`up` идемпотентен и не требует участия человека: агент запускает редактор сам в начале задачи.
Фоновый процесс переживает сессию агента; pid и лог лежат в `.openchatcut-editor/` (вне Git).
`stop` останавливает только то, что запустил `up`; чужой процесс на порту он не трогает.

MCP-эндпоинт `http://localhost:5199/api/external-mcp/mcp` всегда требует bearer-токен. Редактор
чеканит его в свой dev-профиль при первом запуске; `connect` читает его оттуда (или из
`OPENCHATCUT_MCP_TOKEN`) и нигде не печатает. `.mcp.json` в корне объявляет тот же сервер для
любого клона и ждёт `OPENCHATCUT_MCP_TOKEN` в окружении; запись local scope имеет приоритет.
Для Codex: `codex mcp add openchatcut --url <endpoint> --bearer-token-env-var OPENCHATCUT_MCP_TOKEN`.

`npm run editor` также прописывает `artifacts/`, `projects/` и `audio-library/` этого репозитория в
`AGENT_IMPORT_ROOTS` редактора, чтобы desktop-сборка могла импортировать дубли по пути.

Любое изменение живого проекта в редакторе (финализация импорта, применение черновика, запуск
рендера) по дизайну OpenChatCut делает привязку MCP-транспорта устаревшей, и клиенту нужно
переподключаться. Поэтому импорт и рендер идут через CLI, который открывает свежий транспорт на
каждый шаг, а MCP-соединение агента остаётся для творческого черновика:

```bash
# принятые дубли в открытый проект редактора; хеш содержимого сверяется с sha256 файла
node src/cli.mjs openchatcut import --project-id <id проекта в OpenChatCut> \
  --files artifacts/<client>/VNNN/jobs/S001/T003-<hash>/outputs/result-01.mp4,artifacts/.../S002/...

# рендер активного таймлайна с ожиданием и снимком read_timeline для приёма
node src/cli.mjs openchatcut render --project-id <id> --name <ACME-V001-E002-v1.mp4> \
  --timeline-out projects/<client>/VNNN/edits/E002-openchatcut-timeline-v1.json
```

Обе команды работают с проектом, открытым во вкладке редактора, и запускают его real-project
инструменты в собственных unattended-сессиях: вызов команды и есть согласие. Проект в редакторе
создавайте в формате замороженного плана (`create_project` с `compositionWidth`,
`compositionHeight`, `fps`): по умолчанию это 1920x1080 при 30 fps, и такой экспорт приём
отклонит по соотношению сторон и частоте кадров.

Экспорт редактора попадает в проект только через приём мастера:

```bash
node src/cli.mjs adopt-master --project projects/<client>/VNNN --variant E002 \
  --url http://localhost:5199/media/uploads/<file>.mp4 --timeline <read_timeline.json> \
  --renderer-project <id проекта в OpenChatCut> --render-id <renderId> --note "что это за монтаж"
```

Команда копирует файл в `artifacts/<client>/VNNN/masters/E002/` как следующую версию, никогда не
перезаписывая, и пишет рядом отчёт с sha256, происхождением, cut list из таймлайна и измеренной
верификацией: соотношение сторон, частота кадров и длительность сверяются с замороженным шот-планом,
громкость — с целевым окном. Порядок работы агента описан в skill `$edit-with-openchatcut`.

## Структура

- `src/domain/` — provider-independent нормализованный контракт;
- `src/media/` — тонкие обёртки над ffmpeg/ffprobe без доменной логики;
- `src/providers/evolink/` — транспорт, явный model allowlist и раздельные payload-контракты;
- `src/providers/komend/` — TTS client и распознавание речи для проверки реплик;
- `src/workflows/` — immutable job journal, submit/poll/download, бюджетный гейт, сборка мастера;
- `tests/` — только mocked contract tests, без платных вызовов;
- `skills-source/` — канонические skills.

## Локальные production-данные

Полный workflow создаёт отдельный контекст для каждого клиента и номера видео. Профиль клиента и его production-проекты хранятся вместе в `projects/<client_id>/`, а результаты — в `artifacts/`; оба корня являются локальными и исключены из Git. Это защищает клиентские материалы от случайного коммита, но означает, что новый clone начинает с пустого локального реестра.

Резервное копирование этих каталогов нужно организовать вне Git. Не применяйте к ним `git clean` или автоматическую очистку: неудачные и устаревшие варианты, provider outputs и промежуточные артефакты сохраняются до явно подтверждённого удаления.

## Разработка

Клиентские каталоги `.agents/skills/`, `.codex/skills/`, `.claude/skills/` и `.openclaw/skills/` генерируются из `skills-source/` и не редактируются вручную.

```bash
npm run build:skills
npm run check:skills
npm test
```

Синхронизация недеструктивна: она не перезаписывает расходящиеся generated-файлы и не удаляет unmanaged-файлы.

Актуальные API-источники: [EVOLINK quickstart](https://evolink.ai/docs/en/quickstart), [Seedance 2.5](https://evolink.ai/docs/en/api-manual/video-series/seedance2.5/seedance-2.5-overview), [Seedance 2.0](https://evolink.ai/docs/en/api-manual/video-series/seedance2.0/seedance-2.0-overview), [Kling O3](https://evolink.ai/docs/en/api-manual/video-series/kling/kling-o3-text-to-video), [Kling V3](https://evolink.ai/docs/en/api-manual/video-series/kling/kling-v3-text-to-video).

## Второй маршрут: Gemini в браузере

Генерация фрагментов через https://gemini.google.com/videos в выбранном профиле браузера
описана в [generate-browser-video](skills-source/generate-browser-video/SKILL.md).
API-маршрут EVOLINK остаётся доступным. Для браузера перед freeze задайте шоту
`route.model: "gemini-browser"`; это идентификатор маршрута, а не название модели Google.

`script compose --project <project> --shot S001 --take-id B1` сохраняет запрос.
После генерации и скачивания оригинала используйте:

```bash
node src/cli.mjs browser-import --project projects/<client>/VNNN \
  --request projects/<client>/VNNN/requests/S001-B1.json \
  --receipt projects/<client>/VNNN/requests/S001-B1-completed.json \
  --file /path/to/downloaded.mp4
```

Формат receipt указан в skill. Импорт копирует оригинал в проектный `jobs/browser/S001/B1`,
записывает SHA-256 и измеренные параметры, сохраняет запрос и источник. Он не отправляет
запросы и не принимает дубль автоматически: далее обязательны QA и `assemble --require-review`.
Нативная звуковая дорожка сохраняется в оригинале, но исключается из монтажа.
Расходы и лимиты браузера записываются отдельно; команда `budget` считает API-задачи.

## Лицензия

Распространяется под лицензией [MIT](LICENSE). Разработчик — **[LidFly.ru](https://lidfly.ru)**.
Сторонний skill `vibe-creating-prompt` распространяется под лицензией Apache-2.0 (см. `skills-source/vibe-creating-prompt/LICENSE` и `NOTICE`).
