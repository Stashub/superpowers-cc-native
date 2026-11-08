# superpowers-cc-native v0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Собрать репозиторий `Stashub/superpowers-cc-native`: импорт релизов obra/superpowers с переименованием, проверки, выпуск `7.0.2-cc.1`, публикация и установка.

**Architecture:** Две ветки (vendor branch). `upstream` получает только импорты: их собирает `tools/sync.mjs` через временный индекс и помечает печатью `Sync-Tree`. `main` - это `git merge upstream` плюс наши файлы. `tools/check.mjs` проверяет плагин и правила выпуска, а git-хук `pre-push` не пускает на GitHub невыпущенный `plugin/`.

**Tech Stack:** Node.js 24+ (только встроенные модули и `node:test`), git, Claude Code CLI, `gh` (только для создания репозитория).

**Spec:** `docs/superpowers/specs/2026-11-08-superpowers-cc-native-design.md`. План опирается на неё, исполнитель читает обе. Ссылки вида «спека 6.5» - это разделы спеки.

**Проверенные версии** (2026-11-08):
- Node 24 - LTS maintenance до 2028-04-30 (nodejs/Release `schedule.json`). Последний выпуск ветки 24 в context7 - v24.22.2, на машине 24.19.0.
- `node --test` с glob-шаблонами и `node:test` - context7, nodejs.org/docs/latest-v24.x/api/test.html.
- `%(trailers:key=<k>,valueonly)` - context7, git htmldocs pretty-formats.
- Локально: git 2.53.0, Claude Code 2.1.319, gh 2.96.0.

## Global Constraints

- Node.js 24 или новее, без зависимостей: только встроенные модули и `node:test`. В корне нет `package.json`.
- Тесты запускаются только командой `node --test "tools/test/*.test.mjs"`. Без явного шаблона `node --test` подхватит ещё и `plugin/tests/**/*.test.js` оригинала.
- Плагин и marketplace: `superpowers-cc-native`. Репозиторий: `https://github.com/Stashub/superpowers-cc-native`. Оригинал: `https://github.com/obra/superpowers.git`.
- Имя и почта во всех коммитах и тегах: `Stashub` и `64739874+Stashub@users.noreply.github.com`, только в локальном config.
- Номер выпуска соответствует `^\d+\.\d+\.\d+-cc\.[1-9]\d*$` и записан только в `.claude-plugin/marketplace.json`. В `plugin/.claude-plugin/plugin.json` поля `version` нет.
- Переименование: regex `(?<![\w-])superpowers:(?=[a-z])` заменяется на `superpowers-cc-native:`.
- Каждый `plugin/skills/*/SKILL.md` меньше 20 000 байт.
- README, CHANGELOG, CLAUDE.md, сообщения коммитов и сообщения скриптов - на английском.
- Во всех файлах и сообщениях только дефис «-», без длинного и среднего тире.
- В репозитории нет личных и инфраструктурных данных: хостов, абсолютных путей машины, профилей, проектов владельца.
- В ветку `upstream` руками не писать и на неё не переключаться.
- Локальные коммиты по задачам входят в план. Только по явному слову владельца в момент шага:
  - коммит выпуска, перевод `main` и тег (задача 8);
  - создание репозитория на GitHub и push (задача 9);
  - установка и переключение плагинов (задача 10).
- Задача 1 создаёт репозиторий в папке проекта, поэтому worktree до неё сделать нельзя.
- Задачи 2-7 - правки вне `plugin/`, по спеке 8 они идут прямо в `main`. Если исполнитель работает в отдельной ветке или worktree, перед задачей 8 эта ветка вливается в `main`. Причина: `sync.mjs` создаёт `sync/<тег>` от `main`, и без `tools/` в `main` проверка после слияния не найдёт свои файлы.

## Review Focus

1. **sync запущен не из `main`** (например, из ветки плана). Ожидание: остановка `not-on-main`, рабочая копия не переключена. Тест в задаче 4.
2. **sync прерван** после `update-ref`, но до создания тега `upstream/<тег>`. Ожидание: повторный запуск того же тега дописывает тег и продолжает. Тест в задаче 4.
3. **У оригинала появился пре-релиз** (`v7.1.0-rc.1`) или тег другого вида. Ожидание: отказ `bad-tag`, импортируются только `vX.Y.Z`. Тесты в задачах 2 и 4.
4. **Скрипты запущены из подпапки** репозитория. Ожидание: работают от корня (`git rev-parse --show-toplevel`). Тесты в задачах 4 и 5.
5. **Удаление `main` или `upstream` на GitHub** (`git push origin :main`). Ожидание: хук блокирует. Тест в задаче 6.

## File Structure

| Файл | Ответственность |
|---|---|
| `.gitignore`, `.gitattributes`, `LICENSE`, `README.md`, `CHANGELOG.md`, `CLAUDE.md`, `.claude-plugin/marketplace.json` | корневые файлы (спека 5) |
| `tools/lib/constants.mjs` | имена, адреса, идентичность, шаблон номера |
| `tools/lib/rename.mjs` | побайтовая замена ссылок, признак текста |
| `tools/lib/manifest.mjs` | преобразование `plugin.json` (спека 6.4) |
| `tools/lib/semver.mjs` | разбор и сравнение тегов оригинала и наших номеров, следующий номер |
| `tools/lib/errors.mjs` | `ToolError` с кодом остановки |
| `tools/lib/git.mjs` | запуск git |
| `tools/lib/upstream.mjs` | fetch тега, сборка дерева, коммит импорта, печать, ветка `upstream`, идентичность |
| `tools/sync.mjs` | CLI импорта и слияния (спека 6) |
| `tools/lib/checks.mjs` | проверки 7.1, пункты 1-4 и 7 |
| `tools/lib/validate.mjs` | запуск и фильтр `claude plugin validate --json` (спека 7.3) |
| `tools/lib/original-tests.mjs` | списки и запуск тестов оригинала (спека 7.4) |
| `tools/lib/release.mjs` | состояние выпуска и ожидаемый номер (спека 7.2) |
| `tools/check.mjs` | CLI проверок: обычная, `--release`, `--push <коммит>` |
| `tools/hooks/pre-push` | git-хук (спека 8) |
| `tools/test/helpers.mjs` | временные репозитории, поддельный «оригинал» |
| `tools/test/*.test.mjs` | тесты по модулям, `integration.test.mjs` - на настоящих релизах |

---

### Task 1: Репозиторий и корневые файлы

**Files:**
- Create: `.gitignore`, `.gitattributes`, `LICENSE`, `.claude-plugin/marketplace.json`, `README.md`, `CHANGELOG.md`, `CLAUDE.md`
- Уже есть: `docs/superpowers/specs/2026-11-08-superpowers-cc-native-design.md`, этот план

**Interfaces:**
- Produces: репозиторий с веткой `main`; локальный config `user.name`, `user.email`, `core.hooksPath=tools/hooks`; корневой marketplace с номером `7.0.2-cc.1`; `CHANGELOG.md` с пустым `## Unreleased`.

- [ ] **Step 1: Создать репозиторий и локальный config**

```bash
git init -b main
git config user.name Stashub
git config user.email 64739874+Stashub@users.noreply.github.com
git config core.hooksPath tools/hooks
```

Проверка: `git config --local --get user.email` печатает noreply-адрес.

- [ ] **Step 2: Записать файлы с точным содержимым**

`.gitignore`:

```
.superpowers/
```

`.gitattributes` (только наши пути, спека 5.2):

```
/.gitattributes text eol=lf
/.gitignore text eol=lf
/LICENSE text eol=lf
/*.md text eol=lf
/.claude-plugin/** text eol=lf
/tools/** text eol=lf
/docs/** text eol=lf
```

`.claude-plugin/marketplace.json` - блок из спеки 5.2 без изменений.

`CHANGELOG.md`:

```
# Changelog

## Unreleased
```

`LICENSE` - стандартный текст MIT, как в LICENSE оригинала. Строки копирайта:

```
Copyright (c) 2025 Jesse Vincent
Copyright (c) 2026 Stashub
```

- [ ] **Step 3: Написать `README.md` (на английском)**

Разделы:
- что это и для кого. Пользователям других сред - ссылка на obra/superpowers;
- установка (спека 9): одна команда для CC 2.1.275+, две команды для старых версий;
- переход с оригинала: выключить тот оригинал, что стоит (`superpowers-marketplace` или `claude-plugins-official`); имена скиллов меняются; доводка старых планов через `--resume ... --settings`; откат;
- ручные обновления: две команды и правило про 14 дней;
- отличия от оригинала в v0: только имя. Страница компаньона показывает «Superpowers v<версия оригинала>». `diagnosing-superpowers` пишет issue в obra;
- куда писать об ошибке (спека 11);
- как мы держим оригинал: две ветки, `git diff upstream main -- plugin/`, `node tools/sync.mjs <tag>`;
- лицензия.

- [ ] **Step 4: Написать `CLAUDE.md` (на английском)**

Правила из спеки 5.4. Плюс:
- настройка свежего клона: три команды `git config` из шага 1. Локальную ветку `upstream` руками создавать не нужно, sync создаст её из `origin/upstream` сам;
- шаги импорта (спека 6.5) и выпуска (спека 8);
- команда тестов из Global Constraints;
- правила роста кратко (спека 10).

- [ ] **Step 5: Проверить**

```bash
node -e 'JSON.parse(require("fs").readFileSync(".claude-plugin/marketplace.json","utf8"))'
git check-attr eol -- tools/sync.mjs plugin/README.md
grep -rnP '[\x{2013}\x{2014}]' --exclude-dir=.git . ; grep -rnE '/hom[e]/' --exclude-dir=.git .
```

Expected:
- JSON читается без ошибки;
- `tools/sync.mjs: eol: lf` и `plugin/README.md: eol: unspecified`;
- оба `grep` ничего не печатают.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: repository skeleton, spec and plan"
```

---

### Task 2: Чистые функции: переименование, plugin.json, версии

**Files:**
- Create: `tools/lib/constants.mjs`, `tools/lib/errors.mjs`, `tools/lib/rename.mjs`, `tools/lib/manifest.mjs`, `tools/lib/semver.mjs`
- Test: `tools/test/rename.test.mjs`, `tools/test/manifest.test.mjs`, `tools/test/semver.test.mjs`

**Interfaces:**
- Produces:
  - `constants.mjs`: `PLUGIN_NAME = 'superpowers-cc-native'`, `UPSTREAM_PLUGIN_NAME = 'superpowers'`, `UPSTREAM_URL = 'https://github.com/obra/superpowers.git'`, `REPO_URL = 'https://github.com/Stashub/superpowers-cc-native'`, `OWNER = { name: 'Stashub', url: 'https://github.com/Stashub' }`, `IDENTITY = { name: 'Stashub', email: '64739874+Stashub@users.noreply.github.com' }`, `DESCRIPTION_PREFIX = 'Claude Code native fork of obra/superpowers. '`, `UPSTREAM_BRANCH = 'upstream'`, `OBRA_TAG_PREFIX = 'refs/obra/tags/'`, `VERSION_RE = /^\d+\.\d+\.\d+-cc\.[1-9]\d*$/`.
  - `rename.mjs`:
    - `OLD_REF_SOURCE = '(?<![\\w-])superpowers:(?=[a-z])'`. Каждый вызов создаёт свой `RegExp` с флагом `g`;
    - `isText(buf: Buffer): boolean` - нет байта 0x00;
    - `renameBuffer(buf: Buffer): { buf: Buffer, count: number }`;
    - `countOldRefs(buf: Buffer): number`.
  - `manifest.mjs`: `transformPluginJson(text: string): string`.
  - `semver.mjs`:
    - `parseUpstreamTag(tag: string): { major, minor, patch }` - только `vX.Y.Z`, иначе `ToolError('bad-tag')`;
    - `parseRelease(v: string): { major, minor, patch, cc }` - `X.Y.Z-cc.N`, допускается ведущий `v`;
    - `compareUpstream(a: string, b: string): number`, `compareRelease(a: string, b: string): number`;
    - `nextReleaseVersion(base: string, last: string | null): string` - `base` в виде `X.Y.Z`.
  - `errors.mjs`: `class ToolError extends Error`, конструктор `(code: string, message: string)`, поле `code`.

- [ ] **Step 1: Write the failing tests**

`tools/test/rename.test.mjs`:

```js
const r = (s) => renameBuffer(Buffer.from(s, 'latin1')).buf.toString('latin1');
test('renames skill, command and agent refs', () => {
  assert.equal(r('use superpowers:brainstorming'), 'use superpowers-cc-native:brainstorming');
  assert.equal(r('`/superpowers:brainstorm`'), '`/superpowers-cc-native:brainstorm`');
  assert.equal(renameBuffer(Buffer.from('superpowers:a superpowers:b')).count, 2);
});
test('keeps non-refs', () => {
  for (const s of ['foo-superpowers:x', 'my_superpowers:x', 'superpowers: x', 'superpowers:X',
                   '"name": "superpowers"', 'superpowers@superpowers-marketplace'])
    assert.equal(r(s), s);
});
test('is idempotent', () => { const once = r('superpowers:tdd'); assert.equal(r(once), once); });
test('is byte exact outside matches', () => {
  const pre = Buffer.from([0xe9, 0x0d, 0x0a]), post = Buffer.from([0xff]);
  const out = renameBuffer(Buffer.concat([pre, Buffer.from('superpowers:a'), post])).buf;
  assert.deepEqual(out, Buffer.concat([pre, Buffer.from('superpowers-cc-native:a'), post]));
});
test('isText is false only with a NUL byte', () => {
  assert.equal(isText(Buffer.from([0x61, 0x00])), false);
  assert.equal(isText(Buffer.from([0xff, 0xfe, 0x41])), true);
});
test('countOldRefs counts without changing', () => {
  assert.equal(countOldRefs(Buffer.from('superpowers:a foo-superpowers:b')), 1);
});
```

`tools/test/manifest.test.mjs`. На входе `plugin.json` 7.0.2: поля из спеки 14, у автора почта `jesse@example.invalid`.

```js
test('transforms the 7.0.2 manifest exactly', () => {
  assert.equal(transformPluginJson(INPUT_702), EXPECTED_702); // EXPECTED_702 = блок спеки 6.4 + "\n"
});
test('keeps unknown fields in place and drops only version', () => {
  const out = JSON.parse(transformPluginJson(JSON.stringify({ name: 'superpowers', version: '1.0.0',
    description: 'd', foo: 1, author: { name: 'x' }, homepage: 'h', repository: 'r', keywords: [] })));
  assert.deepEqual(Object.keys(out), ['name', 'description', 'foo', 'author', 'homepage', 'repository', 'keywords']);
  assert.equal(out.foo, 1);
  assert.equal(out.description, 'Claude Code native fork of obra/superpowers. d');
});
test('appends missing replaced fields in table order', () => {
  const out = JSON.parse(transformPluginJson('{"name":"superpowers","description":"d"}'));
  assert.deepEqual(Object.keys(out), ['name', 'description', 'author', 'homepage', 'repository']);
});
test('rejects invalid JSON', () => { assert.throws(() => transformPluginJson('{')); });
```

`tools/test/semver.test.mjs`:

```js
test('parses only vX.Y.Z upstream tags', () => {
  assert.deepEqual(parseUpstreamTag('v7.0.2'), { major: 7, minor: 0, patch: 2 });
  for (const t of ['7.0.2', 'v7.1.0-rc.1', 'v7.0', 'release-1'])
    assert.throws(() => parseUpstreamTag(t), { code: 'bad-tag' });
});
test('compares upstream tags numerically', () => {
  assert.ok(compareUpstream('v6.4.10', 'v6.4.2') > 0);
  assert.equal(compareUpstream('v7.0.2', 'v7.0.2'), 0);
});
test('parses and compares release numbers', () => {
  assert.deepEqual(parseRelease('v7.0.2-cc.12'), { major: 7, minor: 0, patch: 2, cc: 12 });
  for (const v of ['7.0.2-cc.0', '7.0.2+cc.1', '7.0.2']) assert.throws(() => parseRelease(v));
  assert.ok(compareRelease('7.0.3-cc.1', '7.0.2-cc.9') > 0);
  assert.ok(compareRelease('7.0.2-cc.10', '7.0.2-cc.9') > 0);
});
test('computes the next release number', () => {
  assert.equal(nextReleaseVersion('7.0.2', null), '7.0.2-cc.1');
  assert.equal(nextReleaseVersion('7.0.2', '7.0.2-cc.1'), '7.0.2-cc.2');
  assert.equal(nextReleaseVersion('7.0.3', '7.0.2-cc.5'), '7.0.3-cc.1');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test "tools/test/*.test.mjs"`
Expected: FAIL, модули не найдены.

- [ ] **Step 3: Реализовать четыре модуля и `errors.mjs` по Interfaces**

`renameBuffer`: `buf.toString('latin1')`, `replace`, `Buffer.from(..., 'latin1')`. `transformPluginJson`:
- заменяет на месте `name`, `description` (префикс плюс описание оригинала), `author`, `homepage`, `repository`;
- удаляет `version`;
- недостающие из этих пяти полей добавляет в конец в порядке таблицы спеки 6.4;
- пишет `JSON.stringify(x, null, 2) + "\n"`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test "tools/test/*.test.mjs"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tools
git commit -m "feat: rename, manifest and version helpers"
```

---

### Task 3: Сборка импорта, печать, ветка `upstream`

**Files:**
- Create: `tools/lib/git.mjs`, `tools/lib/upstream.mjs`
- Test: `tools/test/helpers.mjs`, `tools/test/upstream.test.mjs`

**Interfaces:**
- Consumes: задача 2 целиком.
- Produces:
  - `git.mjs`:
    - `run(cwd, args, { input, env } = {}): { status: number, stdout: Buffer, stderr: string }` - не бросает;
    - `git(cwd, args, opts?): string` - stdout в UTF-8 без последнего перевода строки. При ненулевом коде бросает `ToolError('git', 'git <args>: <stderr>')`;
    - `repoRoot(cwd): string`.
  - `upstream.mjs`:
    - `fetchUpstreamTag(repo, tag, from = UPSTREAM_URL): string` - `git fetch --no-tags <from> +refs/tags/<tag>:refs/obra/tags/<tag>`. Возвращает коммит тега. Нет тега - `ToolError('no-such-tag')`;
    - `upstreamPluginName(repo, tag): string | null` - `name` из `.claude-plugin/plugin.json` тега;
    - `buildImportTree(repo, tag): { tree, files, renamedFiles, renamedRefs }` - спека 6.2, шаги 1-5. Временный индекс `<git-dir>/sync-index-<pid>` удаляется в `finally`;
    - `createImportCommit(repo, { tag, upstreamCommit, tree, parent }): string`:
      - сообщение - ровно блок из спеки 6.2, короткий sha в 7 символов;
      - `git update-ref refs/heads/upstream <new> <parent или "">`;
      - annotated тег `upstream/<tag>` с сообщением `upstream <tag>`;
    - `ensureImportTag(repo, commit, tag): boolean` - создаёт недостающий тег. Возвращает `true`, если создал;
    - `readImportTrailers(repo, rev): { tag, commit, tree }`. Отсутствующие трейлеры - `null`;
    - `verifySeals(repo, rev): Array<{ commit, reason: 'no-trailers' | 'tree-mismatch' }>` - по `git rev-list --first-parent <rev>`. Пустой массив - всё в порядке;
    - `upstreamRef(repo): 'upstream' | 'origin/upstream' | null` - без fetch;
    - `prepareUpstream(repo): 'local' | 'from-origin' | 'none'` - спека 6.7. Если отстаёт или разошлась - `ToolError('upstream-behind')` или `ToolError('upstream-diverged')`;
    - `checkIdentity(repo): string[]` - что не так в `git config --local` (имя, почта). Пустой массив - всё в порядке.
  - `helpers.mjs` (только тесты):
    - при импорте ставит `process.env.GIT_CONFIG_GLOBAL = os.devNull` и `GIT_CONFIG_NOSYSTEM = '1'`;
    - `tempDir(t): string` - удаляется в `t.after`;
    - `initRepo(dir): void` - `main` и `IDENTITY` в локальном config;
    - `writeFiles(dir, files)` - значение: строка, `Buffer`, `{ symlink: target }` или `{ exec: text }`;
    - `commitAll(dir, msg): string`;
    - `makeOrigin(t, releases: Array<{ tag, files?, pluginName? }>): string` - поддельный оригинал, коммит и annotated тег на каждый релиз;
    - `seedMain(dir): void` - корневые файлы задачи 1 в коммите.

  Базовые файлы `makeOrigin`:
  - `.claude-plugin/plugin.json` с `version`;
  - `.claude-plugin/marketplace.json`;
  - `skills/demo/SKILL.md` с текстом `Use superpowers:demo first.\n`;
  - `assets/logo.png` (байты с 0x00);
  - `scripts/run.sh` (exec);
  - `link` (symlink на `README.md`);
  - `README.md`.

- [ ] **Step 1: Write the failing tests** (`tools/test/upstream.test.mjs`)

```js
test('buildImportTree prefixes plugin/, renames, skips marketplace, transforms manifest', (t) => {
  // origin v1.0.0; repo = initRepo + fetchUpstreamTag
  const { tree } = buildImportTree(repo, 'v1.0.0');
  const ls = git(repo, ['ls-tree', '-r', tree]);
  assert.match(ls, /^120000 blob \S+\tplugin\/link$/m);
  assert.match(ls, /^100755 blob \S+\tplugin\/scripts\/run\.sh$/m);
  assert.doesNotMatch(ls, /plugin\/\.claude-plugin\/marketplace\.json/);
  assert.equal(git(repo, ['show', `${tree}:plugin/skills/demo/SKILL.md`]), 'Use superpowers-cc-native:demo first.');
  assert.equal(git(repo, ['rev-parse', `${tree}:plugin/assets/logo.png`]),
               git(repo, ['rev-parse', 'refs/obra/tags/v1.0.0:assets/logo.png']));
  const pj = JSON.parse(git(repo, ['show', `${tree}:plugin/.claude-plugin/plugin.json`]));
  assert.equal(pj.name, 'superpowers-cc-native'); assert.equal('version' in pj, false);
});
test('buildImportTree is deterministic and leaves no temp index', (t) => {
  assert.equal(buildImportTree(repo, 'v1.0.0').tree, buildImportTree(repo, 'v1.0.0').tree);
  assert.deepEqual(readdirSync(gitDir).filter((f) => f.startsWith('sync-index')), []);
});
test('createImportCommit writes exact message, seal and annotated tag', (t) => {
  const c = createImportCommit(repo, { tag: 'v1.0.0', upstreamCommit, tree, parent: null });
  assert.equal(git(repo, ['log', '-1', '--format=%B', c]),
    `upstream v1.0.0 (${upstreamCommit.slice(0, 7)})\n\nUpstream-Tag: v1.0.0\nUpstream-Commit: ${upstreamCommit}\nSync-Tree: ${tree}`);
  assert.equal(git(repo, ['cat-file', '-t', 'upstream/v1.0.0']), 'tag');
  assert.deepEqual(readImportTrailers(repo, 'upstream'), { tag: 'v1.0.0', commit: upstreamCommit, tree });
});
test('verifySeals flags a hand commit and a tree that does not match its seal', (t) => {
  // commit-tree поверх upstream: без трейлеров; затем с трейлерами прошлого импорта, но другим деревом
  assert.deepEqual(verifySeals(repo, handCommit).map((x) => x.reason), ['no-trailers']);
  assert.deepEqual(verifySeals(repo, fakeSealCommit).map((x) => x.reason), ['tree-mismatch']);
  assert.deepEqual(verifySeals(repo, 'upstream'), []);
});
test('fetchUpstreamTag follows a tag moved to unrelated history and reports a missing tag', (t) => {
  const first = fetchUpstreamTag(repo, 'v1.0.0', origin);
  // в origin: orphan-коммит и git tag -f -a v1.0.0 на нём
  assert.notEqual(fetchUpstreamTag(repo, 'v1.0.0', origin), first);
  assert.throws(() => fetchUpstreamTag(repo, 'v9.9.9', origin), { code: 'no-such-tag' });
});
test('prepareUpstream: none, from-origin, behind, diverged', (t) => {
  assert.equal(prepareUpstream(empty), 'none');
  // bare origin с веткой upstream; свежий клон без локальной upstream
  assert.equal(upstreamRef(clone), 'origin/upstream');
  assert.equal(prepareUpstream(clone), 'from-origin'); assert.equal(upstreamRef(clone), 'upstream');
  // в origin upstream ушла вперёд
  assert.throws(() => prepareUpstream(clone), { code: 'upstream-behind' });
  // локально и в origin разные коммиты поверх общей основы
  assert.throws(() => prepareUpstream(clone2), { code: 'upstream-diverged' });
});
test('checkIdentity reports missing local name and email', (t) => {
  assert.equal(checkIdentity(bareConfigRepo).length, 2);
  assert.deepEqual(checkIdentity(repo), []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test "tools/test/*.test.mjs"`
Expected: FAIL, `git.mjs` и `upstream.mjs` не найдены; тесты задачи 2 проходят.

- [ ] **Step 3: Реализовать `git.mjs` и `upstream.mjs` по Interfaces**

- Обход файлов и запись blob: `git ls-tree -r -z`, `git cat-file blob`, `git hash-object -w --stdin --no-filters`.
- Индекс: `git update-index -z --add --index-info` с `GIT_INDEX_FILE`.
- Трейлеры: `git log -1 --format=%(trailers:key=Upstream-Tag,valueonly)` и так же для двух других ключей.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test "tools/test/*.test.mjs"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tools
git commit -m "feat: build sealed upstream imports"
```

---

### Task 4: `tools/sync.mjs`

**Files:**
- Create: `tools/sync.mjs`
- Test: `tools/test/sync.test.mjs`

**Interfaces:**
- Consumes: задачи 2-3.
- Produces:
  - `runSync({ repo, tag, from, check = true }): { status: 'nothing-to-do' | 'merged' | 'conflict', imported: boolean, branch: string | null, conflicts: string[], numstat: string }`. Если `check` истинно и слияние чистое, функция запускает `check.mjs` дочерним процессом: `process.execPath` и путь `new URL('./check.mjs', import.meta.url)`, `cwd` - корень, вывод наследуется. Проваленная проверка - `ToolError('check-failed')`;
  - CLI `node tools/sync.mjs <tag> [--from <url|path>]`. Коды выхода: 0 - `merged` или `nothing-to-do`; 1 - `ToolError`, сообщение `stop (<code>): <text>`; 2 - `conflict`.

Порядок `runSync` (спека 6.5-6.8):
1. Корень репозитория - `repoRoot`.
2. Проверки рабочей копии: грязная - `dirty`, не те имя и почта - `identity`.
3. Текущая ветка: `main` или `sync/<tag>`, иначе `not-on-main`.
4. `prepareUpstream`, затем `verifySeals` (`upstream-edited`).
5. `parseUpstreamTag`.
6. Импорт:
   - `Upstream-Tag` вершины равен тегу: импорта нет, вызывается `ensureImportTag`;
   - тег не новее прошлого: `not-newer`;
   - иначе `fetchUpstreamTag`, проверка `name` (`not-upstream`), `buildImportTree`, `createImportCommit`.
7. `upstream` уже предок `HEAD`: `nothing-to-do`.
8. Слияние:
   - на `main`: если `sync/<tag>` уже есть - `branch-exists`, иначе `git checkout -b sync/<tag>`;
   - `git merge --no-ff -m "Merge upstream <tag>" upstream`. Если общей основы нет, добавляется `--allow-unrelated-histories`;
   - при конфликте - список из `git diff --name-only --diff-filter=U`.
9. `numstat` - `git diff --numstat upstream HEAD -- plugin/`.

- [ ] **Step 1: Write the failing tests** (`tools/test/sync.test.mjs`, везде `check: false`)

```js
test('first import creates sealed upstream and merges into sync branch', (t) => {
  const res = runSync({ repo, tag: 'v1.0.0', from: origin, check: false });
  assert.equal(res.status, 'merged'); assert.equal(res.branch, 'sync/v1.0.0'); assert.equal(res.imported, true);
  assert.equal(git(repo, ['rev-list', '--count', 'upstream']), '1');
  assert.deepEqual(verifySeals(repo, 'upstream'), []);
  assert.equal(existsSync(join(repo, 'plugin/.claude-plugin/marketplace.json')), false);
  assert.equal(res.numstat, '');
});
test('second release merges cleanly with the previous import as base', (t) => {
  // после v1.0.0 и перевода main; оригинал v1.1.0 меняет только README.md
  const res = runSync({ repo, tag: 'v1.1.0', from: origin, check: false });
  assert.equal(res.status, 'merged'); assert.deepEqual(res.conflicts, []);
  assert.equal(git(repo, ['rev-parse', 'upstream^']), firstImport);
});
test('conflict reports files and the CLI exits with 2', (t) => {
  // наша правка и правка оригинала в одной строке plugin/skills/demo/SKILL.md
  assert.deepEqual(res.conflicts, ['plugin/skills/demo/SKILL.md']);
  assert.equal(spawnSync(process.execPath, [SYNC, 'v1.1.0', '--from', origin], { cwd: repo2 }).status, 2);
});
test('rerun of a merged tag is nothing-to-do and changes no refs', (t) => {
  const before = git(repo, ['for-each-ref']);
  assert.equal(runSync({ repo, tag: 'v1.0.0', from: origin, check: false }).status, 'nothing-to-do');
  assert.equal(git(repo, ['for-each-ref']), before);
});
test('imported but unmerged tag is merged on rerun', (t) => {
  // после импорта: git merge --abort, checkout main, branch -D sync/v1.0.0
  const res = runSync({ repo, tag: 'v1.0.0', from: origin, check: false });
  assert.equal(res.imported, false); assert.equal(res.status, 'merged');
});
test('interrupted run recreates a missing upstream tag', (t) => {          // Review Focus 2
  git(repo, ['tag', '-d', 'upstream/v1.0.0']);
  runSync({ repo, tag: 'v1.0.0', from: origin, check: false });
  assert.equal(git(repo, ['cat-file', '-t', 'upstream/v1.0.0']), 'tag');
});
test('refuses to run outside main and leaves the branch alone', (t) => {   // Review Focus 1
  git(repo, ['checkout', '-b', 'plan/x']);
  assert.throws(() => runSync({ repo, tag: 'v1.0.0', from: origin, check: false }), { code: 'not-on-main' });
  assert.equal(git(repo, ['branch', '--show-current']), 'plan/x');
});
test('CLI works from a subdirectory', (t) => {                             // Review Focus 4
  // v1.0.0 уже импортирован и влит в main; CLI до check.mjs не доходит
  assert.equal(spawnSync(process.execPath, [SYNC, 'v1.0.0', '--from', origin], { cwd: join(repo, 'plugin/skills') }).status, 0);
});
for (const [code, setup] of [
  ['dirty', 'незакоммиченный файл'], ['identity', 'git config --unset user.email'],
  ['bad-tag', "тег 'v1.1.0-rc.1'"],                                        // Review Focus 3
  ['not-newer', 'импорт v1.1.0, затем v1.0.0'], ['not-upstream', "pluginName 'other'"],
  ['upstream-edited', 'ручной commit-tree в upstream'], ['branch-exists', 'заранее созданная sync/v1.0.0'],
]) test(`stops with ${code}`, (t) => {
  const { repo, tag } = prepareStop(t, code); // локальный хелпер теста: состояние из второй колонки
  assert.throws(() => runSync({ repo, tag, from: origin, check: false }), { code });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test "tools/test/*.test.mjs"`
Expected: FAIL, `sync.mjs` не найден.

- [ ] **Step 3: Реализовать `runSync` и CLI по Interfaces**

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test "tools/test/*.test.mjs"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tools
git commit -m "feat: sync.mjs imports and merges upstream releases"
```

---

### Task 5: `check.mjs`: обычная проверка

**Files:**
- Create: `tools/check.mjs`, `tools/lib/checks.mjs`, `tools/lib/validate.mjs`, `tools/lib/original-tests.mjs`
- Test: `tools/test/checks.test.mjs`, `tools/test/validate.test.mjs`, `tools/test/original-tests.test.mjs`

**Interfaces:**
- Consumes: `rename.mjs`, `constants.mjs`, `upstreamRef`, `repoRoot`.
- Produces:
  - `Finding = { level: 'ok' | 'info' | 'warn' | 'fail', code: string, text: string }`.
  - `checks.mjs`:
    - `checkPlugin(root): Finding[]` - пункты 1-3 спеки 7.1. Коды `old-refs`, `plugin-name`, `plugin-version`, `plugin-marketplace`;
    - `checkRootMarketplace(root): { findings: Finding[], version: string | null }` - пункт 4, код `marketplace`;
    - `ourLines(root, upstream: string | null): Finding` - пункт 7, уровень `info`.
  - `validate.mjs`:
    - `filterValidateReport(report): Finding[]` - спека 7.3, код `validate`;
    - `runValidate(root, target, { claudeBin = 'claude', missing = 'warn' }): Finding[]`.
  - `original-tests.mjs`:
    - `RUN_TESTS` - 11 путей из спеки 7.4;
    - `SKIP_FILES` - все файлы из таблицы «не запускаем» спеки 7.4, кроме папок других сред. Семь файлов `brainstorm-server/*.test.js` перечислены поимённо: `auth`, `branding`, `browser-launcher`, `helper`, `lifecycle`, `server`, `ws-protocol`;
    - `SKIP_DIRS = ['antigravity', 'codex', 'codex-plugin-sync', 'devin', 'hermes', 'kimi', 'opencode', 'pi', 'explicit-skill-requests']`;
    - `runOriginalTests(pluginDir, list = RUN_TESTS): Finding[]` - каждый файл запускается `bash <файл>` с `cwd = pluginDir`. Код `original-test`, при провале - хвост вывода;
    - `unknownTestFiles(pluginDir): string[]` - файлы `.sh .js .mjs .cjs .py .ts` в `tests/`, которых нет в двух списках, вне `SKIP_DIRS`.
  - `check.mjs`:
    - `runChecks({ repo, mode = 'default', commit = null, claudeBin, originalTests }): { ok: boolean, findings: Finding[] }`. Задача 6 добавит режимы `release` и `push`;
    - CLI `node tools/check.mjs`: печатает строки `<LEVEL> <code>: <text>`, выходит с 0, если нет `fail`, иначе с 1.

- [ ] **Step 1: Write the failing tests**

`tools/test/validate.test.mjs`. Поддельный `claude` - node-скрипт во временной папке, печатает фикстуру.

```js
const allowed = { path: 'plugins[0] plugin.json → version', message: 'No version specified. Consider adding a version following semver (e.g., "1.0.0")', code: null };
test('allows only the missing-version warning in manifest and contents', () => {
  assert.deepEqual(filterValidateReport(report({ manifestWarnings: [allowed, { ...allowed, path: 'version' }] }))
    .filter((f) => f.level === 'fail'), []);
  assert.equal(filterValidateReport(report({ contents: [{ file: 'skills/x/SKILL.md', errors: [],
    warnings: [{ path: 'frontmatter', message: 'No frontmatter block found.', code: null }] }] }))
    .filter((f) => f.level === 'fail').length, 1);
  assert.equal(filterValidateReport(report({ manifestErrors: [{ path: 'name', message: 'x', code: null }] }))
    .filter((f) => f.level === 'fail').length, 1);
});
test('ignores advice and directory findings', () => {
  const r = report({ advice: [{ message: 'install line' }],
    directory: { findings: [{ code: 'ICON_MISSING', severity: 'warning', blocking: false }] } });
  assert.deepEqual(filterValidateReport(r).filter((f) => f.level === 'fail'), []);
});
test('missing claude is a warning by default and a failure when asked', () => {
  assert.equal(runValidate(root, '.', { claudeBin: '/nonexistent/claude' })[0].level, 'warn');
  assert.equal(runValidate(root, '.', { claudeBin: '/nonexistent/claude', missing: 'fail' })[0].level, 'fail');
});
```

Символ `→` в `allowed.path` взят из вывода CC 2.1.319 дословно. Фильтр сравнивает `message` по началу `No version specified` и `path` по окончанию `version`.

`tools/test/original-tests.test.mjs`:

```js
test('runs listed tests and reports a failure with output', () => {
  // pluginDir/tests/a/test-ok.sh -> exit 0, pluginDir/tests/b/test-bad.sh -> echo boom; exit 1
  const f = runOriginalTests(pluginDir, ['tests/a/test-ok.sh', 'tests/b/test-bad.sh']);
  assert.deepEqual(f.map((x) => x.level), ['ok', 'fail']); assert.match(f[1].text, /boom/);
});
test('lists unknown test files outside skipped dirs', () => {
  // + tests/claude-code/test-new.sh, tests/opencode/test-x.sh, tests/claude-code/README.md
  assert.deepEqual(unknownTestFiles(pluginDir), ['tests/claude-code/test-new.sh']);
});
test('run and skip lists do not overlap and have 11 runnable tests', () => {
  assert.equal(RUN_TESTS.length, 11);
  assert.deepEqual(RUN_TESTS.filter((x) => SKIP_FILES.includes(x)), []);
});
```

`tools/test/checks.test.mjs`. Фикстура - временный репозиторий с минимальным `plugin/` и корневым marketplace, `claudeBin` поддельный, `originalTests: []`.

```js
test('passes on a valid fixture', () => { assert.equal(runChecks({ repo, claudeBin, originalTests: [] }).ok, true); });
for (const [code, breakIt] of [
  ['old-refs', 'superpowers:x в plugin/skills/a/SKILL.md'], ['plugin-version', 'version в plugin.json'],
  ['plugin-marketplace', 'plugin/.claude-plugin/marketplace.json'], ['marketplace', "версия '7.0.2'"],
  ['marketplace', 'два плагина'], ['marketplace', "source './'"],
]) test(`fails with ${code}`, () => {
  assert.ok(runChecks({ repo, claudeBin, originalTests: [] }).findings.some((f) => f.level === 'fail' && f.code === code));
});
test('CLI works from a subdirectory', () => {                              // Review Focus 4
  assert.equal(spawnSync(process.execPath, [CHECK], { cwd: join(repo, 'plugin/skills') }).status, 0);
});
```

Для CLI-теста поддельный `claude` подкладывается через `PATH` дочернего процесса, а тесты оригинала берутся из фикстуры, где все пути `RUN_TESTS` - скрипты с `exit 0`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test "tools/test/*.test.mjs"`
Expected: FAIL, модули не найдены.

- [ ] **Step 3: Реализовать модули и CLI по Interfaces**

- Проверка `old-refs` обходит файлы `plugin/` через `fs` и пропускает нетекстовые (`isText`).
- `runValidate` вызывает `claude plugin validate <target> --json` с `cwd = root`. При `ENOENT` возвращает одну находку `validate` уровня `missing`.
- В режиме `default` `runChecks` выполняет пункты 1-7 спеки 7.1: `runValidate` для `.` и для `./plugin`, затем `runOriginalTests` и `unknownTestFiles`. Каждый неизвестный файл - находка уровня `info` с кодом `unknown-test`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test "tools/test/*.test.mjs"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tools
git commit -m "feat: check.mjs default checks"
```

---

### Task 6: `--release`, `--push` и хук `pre-push`

**Files:**
- Create: `tools/lib/release.mjs`, `tools/hooks/pre-push` (`#!/usr/bin/env node`, режим 100755)
- Modify: `tools/check.mjs` (режимы `release` и `push`)
- Test: `tools/test/release.test.mjs`, `tools/test/pre-push.test.mjs`

**Interfaces:**
- Consumes:
  - из задачи 3: `upstreamRef`, `readImportTrailers`, `verifySeals`, `checkIdentity`;
  - из задачи 2: `parseRelease`, `compareRelease`, `nextReleaseVersion`;
  - из задачи 5: `runChecks`;
  - в тестах: `runSync` (задача 4).
- Produces:
  - `releaseState(root, { commit = 'HEAD', worktree = true }): { state: 'nothing' | 'preparing' | 'error', base, last, expected, version, errors: Finding[] }`. Правила - спека 7.2:
    - при `worktree: true` marketplace и CHANGELOG читаются с диска, иначе из `commit`;
    - `plugin/` всегда берётся из `commit`;
    - коды ошибок: `version-expected`, `changelog-missing`, `no-plugin-change`, `tag-elsewhere`.
  - `runChecks` в режиме `release`:
    - всё из `default`;
    - `checkIdentity` (код `identity`);
    - `plugin/` без незакоммиченных изменений (`plugin-dirty`);
    - `releaseState` в состоянии `nothing` или `preparing`;
    - `validate` с `missing: 'fail'`.
  - `runChecks` в режиме `push`: только `releaseState(root, { commit, worktree: false })`, состояние должно быть `nothing`, иначе `not-released`.
  - CLI: `node tools/check.mjs --release`, `node tools/check.mjs --push <commit>`.
  - Хук `pre-push` читает строки stdin `<local ref> <local sha> <remote ref> <remote sha>`:
    - удалённая ссылка `refs/heads/main` - `runChecks({ mode: 'push', commit: <local sha> })`;
    - `refs/heads/upstream` - `verifySeals(<local sha>)`;
    - `<local sha>` из 40 нулей для этих двух ссылок - блок;
    - любой провал - сообщение и код 1.

- [ ] **Step 1: Write the failing tests**

`tools/test/release.test.mjs`. Состояния строятся через `runSync` с поддельным оригином `v1.0.0`/`v1.1.0`, затем коммиты и теги в тесте.

```js
test('nothing to release before the first import', () => { assert.equal(releaseState(fresh).state, 'nothing'); });
test('first release is prepared as 1.0.0-cc.1', () => {
  // после sync v1.0.0: marketplace 1.0.0-cc.1, CHANGELOG "## 1.0.0-cc.1 - 2026-11-08"
  const s = releaseState(repo); assert.equal(s.state, 'preparing'); assert.equal(s.expected, '1.0.0-cc.1');
});
test('wrong number, missing changelog entry and foreign tag are errors', () => {
  for (const [code, repoX] of [['version-expected', withCc2], ['changelog-missing', noEntry], ['tag-elsewhere', foreignTag]])
    assert.ok(releaseState(repoX).errors.some((e) => e.code === code));
  // withCc2: номер 1.0.0-cc.2; noEntry: нет заголовка; foreignTag: v1.0.0-cc.1 стоит на другом коммите
});
test('after the tag there is nothing to release', () => { assert.equal(releaseState(tagged).state, 'nothing'); });
test('our plugin change on the same base expects cc.2, a new base resets to cc.1', () => {
  // после v1.0.0-cc.1: коммит правки plugin/skills/demo/SKILL.md
  assert.equal(releaseState(repo).expected, '1.0.0-cc.2');
  // затем sync v1.1.0 поверх
  assert.equal(releaseState(repo).expected, '1.1.0-cc.1');
});
test('a bumped number without plugin changes is an error', () => {
  // после тега: только номер 1.0.0-cc.2 в marketplace и запись в CHANGELOG
  assert.ok(releaseState(repo).errors.some((e) => e.code === 'no-plugin-change'));
});
test('push mode checks the given commit, not HEAD', () => {
  // коммит выпуска без тега -> not-released; после тега -> ok; HEAD на другой ветке
  assert.equal(runChecks({ repo, mode: 'push', commit: untagged }).ok, false);
  assert.equal(runChecks({ repo, mode: 'push', commit: tagged }).ok, true);
});
```

`tools/test/pre-push.test.mjs`:

```js
const hook = (cwd, line) => spawnSync(process.execPath, [HOOK], { cwd, input: line + '\n' }).status;
test('blocks main without a release tag and allows a tagged release', () => {
  assert.equal(hook(repo, `refs/heads/main ${untagged} refs/heads/main ${ZERO}`), 1);
  assert.equal(hook(repo, `refs/heads/main ${tagged} refs/heads/main ${ZERO}`), 0);
});
test('blocks a hand-edited upstream', () => {
  assert.equal(hook(repo, `refs/heads/upstream ${handCommit} refs/heads/upstream ${ZERO}`), 1);
});
test('blocks deleting main or upstream', () => {                          // Review Focus 5
  assert.equal(hook(repo, `(delete) ${ZERO} refs/heads/main ${tagged}`), 1);
  assert.equal(hook(repo, `(delete) ${ZERO} refs/heads/upstream ${tagged}`), 1);
});
test('ignores other branches', () => { assert.equal(hook(repo, `refs/heads/plan/x ${untagged} refs/heads/plan/x ${ZERO}`), 0); });
test('a real git push to a bare remote is blocked through core.hooksPath', () => {
  // в временном репозитории core.hooksPath = абсолютный путь к нашему tools/hooks; main с невыпущенным plugin/
  assert.notEqual(spawnSync('git', ['push', bare, 'main'], { cwd: repo }).status, 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test "tools/test/*.test.mjs"`
Expected: FAIL, `release.mjs` и хук не найдены.

- [ ] **Step 3: Реализовать `releaseState`, режимы `runChecks` и хук по Interfaces**

- Основа: `Upstream-Tag` коммита `git merge-base <commit> <upstreamRef>`, без `v`.
- Прошлый выпуск: старший по `compareRelease` из `git tag --merged <commit> --list 'v*-cc.*'`.
- Сравнение `plugin/`: `git rev-parse <commit>:plugin` против `<tag>:plugin`.
- Заголовок CHANGELOG: `^## <номер> - \d{4}-\d{2}-\d{2}$`.
- Хук импортирует модули по пути относительно себя (`new URL('../lib/...', import.meta.url)`).
- Перед `git add` выполнить `chmod +x tools/hooks/pre-push`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test "tools/test/*.test.mjs"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tools
git commit -m "feat: release and push checks, pre-push hook"
```

---

### Task 7: Интеграционный тест на настоящих релизах

**Files:**
- Test: `tools/test/integration.test.mjs`

**Interfaces:**
- Consumes: `runSync` (с `check: false`), `verifySeals`, `countOldRefs`, хелперы задачи 3.

Клон оригинала задаёт переменная `SUPERPOWERS_UPSTREAM_CLONE`. Без неё тест пропускается (`t.skip`).

Тест сверяет коммиты тегов с закреплёнными значениями, по префиксу `git rev-parse <tag>^{commit}`:

```js
const PINNED = { 'v6.3.0': 'b36e082', 'v6.4.1': '5bf4e78', 'v6.4.2': '8ca22db',
                 'v7.0.0': 'bb92a77', 'v7.0.1': '2ce8aa1', 'v7.0.2': '22f0b46' };
```

Пробные правки (`applyTrialEdits`, идемпотентно, строки дословно из прогона спеки 4):
- в конец `plugin/skills/subagent-driven-development/SKILL.md` и `plugin/skills/executing-plans/SKILL.md` - строка `\nIn Claude Code, also read references/cc-tasks.md.\n`, если её нет;
- рядом - файл `references/cc-tasks.md` с текстом `our CC-only text\n`;
- в `plugin/skills/brainstorming/SKILL.md` первое `writing-plans skill` заменяется на `writing-plans skill (CC: see references/cc-handoff.md)`, если `cc-handoff` ещё нет.

Ход теста:
1. `seedMain`, импорт v6.3.0, затем `checkout main`, `merge --ff-only sync/v6.3.0`, `branch -d`.
2. Пробные правки коммитятся в `main`.
3. Для каждого следующего тега: `runSync`.
   - При конфликте: `git checkout --theirs -- <files>`, `applyTrialEdits`, `git add -A`, `git commit --no-edit`.
   - Затем перевод `main`, как в пункте 1, и снова `applyTrialEdits` с коммитом, если есть изменения.

- [ ] **Step 1: Write the test**

```js
const EXPECTED_CONFLICTS = {
  'v6.4.1': ['plugin/skills/executing-plans/SKILL.md'],
  'v6.4.2': [],
  'v7.0.0': ['plugin/skills/brainstorming/SKILL.md'],
  'v7.0.1': ['plugin/skills/executing-plans/SKILL.md', 'plugin/skills/subagent-driven-development/SKILL.md'],
  'v7.0.2': [],
};
// для каждого тега: assert.deepEqual(res.conflicts.sort(), EXPECTED_CONFLICTS[tag]);
// после v6.3.0: в git ls-tree -r upstream есть строка с режимом 120000
// в конце:
assert.deepEqual(verifySeals(repo, 'upstream'), []);
assert.equal(git(repo, ['rev-list', '--count', 'upstream']), '6');
// countOldRefs по всем текстовым файлам plugin/ = 0
// cc-tasks.md упомянут в SKILL.md у SDD и executing-plans, cc-handoff - в brainstorming
assert.deepEqual(git(repo, ['diff', '--name-only', 'upstream', 'HEAD', '--', 'plugin/']).split('\n').sort(), [
  'plugin/skills/brainstorming/SKILL.md',
  'plugin/skills/executing-plans/SKILL.md', 'plugin/skills/executing-plans/references/cc-tasks.md',
  'plugin/skills/subagent-driven-development/SKILL.md', 'plugin/skills/subagent-driven-development/references/cc-tasks.md',
]);
```

- [ ] **Step 2: Получить клон оригинала (только чтение, вне репозитория)**

```bash
git clone --no-checkout https://github.com/obra/superpowers.git "$TMPDIR/obra-superpowers"
```

- [ ] **Step 3: Run the test**

Run: `SUPERPOWERS_UPSTREAM_CLONE="$TMPDIR/obra-superpowers" node --test tools/test/integration.test.mjs`
Expected: PASS. Без переменной тест помечен как skipped.

Если конфликты не совпали с таблицей, это расхождение с прогоном 2026-11-07. Его нужно разобрать, а не подгонять таблицу.

- [ ] **Step 4: Commit**

```bash
git add tools/test/integration.test.mjs
git commit -m "test: integration run over real upstream releases"
```

---

### Task 8: Первый импорт v7.0.2 и выпуск 7.0.2-cc.1

**Files:**
- Создаются скриптом: ветка `upstream`, тег `upstream/v7.0.2`, ветка `sync/v7.0.2` с `plugin/`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Предусловия**

- `git branch --show-current` печатает `main`;
- `git status --porcelain` пуст;
- `node --test "tools/test/*.test.mjs"` - PASS.

- [ ] **Step 2: Импорт**

Run: `node tools/sync.mjs v7.0.2`

Expected:
- импорт v7.0.2 и слияние в `sync/v7.0.2` с `--allow-unrelated-histories`;
- `check.mjs` без `FAIL`: 11 тестов оригинала проходят, validate - только разрешённое предупреждение;
- код выхода 0.

- [ ] **Step 3: Сверить импорт**

```bash
git log -1 --format=%B upstream
test "$(git log -1 --format='%(trailers:key=Sync-Tree,valueonly)' upstream)" = "$(git rev-parse 'upstream^{tree}')" && echo seal-ok
git ls-tree -r --name-only upstream | wc -l
git cat-file -t upstream/v7.0.2
git diff --numstat upstream HEAD -- plugin/
wc -c < plugin/skills/subagent-driven-development/SKILL.md
```

Expected:
- первая строка сообщения `upstream v7.0.2 (22f0b46)`, `Upstream-Commit: 22f0b46...`;
- `seal-ok`;
- `235`;
- `tag`;
- пустой `numstat`;
- `19770`.

- [ ] **Step 4: Автоматическая часть пробы (спека 7.5)**

```bash
out="$(mktemp)"
claude -p --plugin-dir ./plugin --settings '{"enabledPlugins":{"superpowers@superpowers-marketplace":false}}' \
  --output-format stream-json --verbose --max-turns 1 "Reply with the single word OK" > "$out"
node -e '
const L = require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n").map((l) => { try { return JSON.parse(l) } catch { return {} } });
const i = L.find((e) => e.subtype === "init"), h = L.find((e) => e.subtype === "hook_response");
const ctx = JSON.parse(h.output || h.stdout).hookSpecificOutput.additionalContext;
const names = i.plugins.map((p) => p.name), sk = i.skills;
console.log(JSON.stringify({
  ours: names.includes("superpowers-cc-native"), original: names.includes("superpowers"),
  newSkills: sk.filter((s) => s.startsWith("superpowers-cc-native:")).length,
  oldSkills: sk.filter((s) => s.startsWith("superpowers:")).length,
  sessionStart: /name: using-superpowers/.test(ctx), oldRefsInContext: /(?<![\w-])superpowers:[a-z]/.test(ctx) }));' "$out"
rm -f "$out"
```

Expected: `{"ours":true,"original":false,"newSkills":15,"oldSkills":0,"sessionStart":true,"oldRefsInContext":false}`.

Проверено 2026-11-08 на CC 2.1.319 и такой же раскладке во временной копии.

- [ ] **Step 5: Ручная часть пробы - с владельцем**

Владелец запускает в корне репозитория:

```
claude --plugin-dir ./plugin --settings '{"enabledPlugins":{"superpowers@superpowers-marketplace":false}}'
```

и просит что-нибудь построить. Скилл `superpowers-cc-native:brainstorming` должен сработать сам. Дальше - только после подтверждения владельца.

- [ ] **Step 6: Коммит выпуска (по слову владельца, шаги 6-7)**

В `CHANGELOG.md` под `## Unreleased` вставить запись. Дата - день выпуска:

```
## 7.0.2-cc.1 - YYYY-MM-DD
Based on obra/superpowers v7.0.2.
- First release: the original renamed to superpowers-cc-native.
```

Run: `node tools/check.mjs --release`
Expected: нет `FAIL`, ожидаемый номер `7.0.2-cc.1`, состояние «готовится выпуск».

```bash
git add CHANGELOG.md
git commit -m "Release v7.0.2-cc.1"
```

- [ ] **Step 7: Перевод `main` и тег**

```bash
git checkout main
git merge --ff-only sync/v7.0.2
git tag -a v7.0.2-cc.1 -m "Release v7.0.2-cc.1"
git branch -d sync/v7.0.2
node tools/check.mjs --release
node tools/check.mjs --push "$(git rev-parse main)"
```

Expected: обе проверки без `FAIL`, состояние «выпускать нечего».

---

### Task 9: Репозиторий на GitHub и push (по слову владельца)

- [ ] **Step 1: Убедиться, что репозитория ещё нет**

Run: `gh repo view Stashub/superpowers-cc-native`
Expected: ошибка «Could not resolve to a Repository».

- [ ] **Step 2: Создать пустой публичный репозиторий и remote**

Флаги сверить с `gh repo create --help` установленной версии.

```bash
gh repo create Stashub/superpowers-cc-native --public --description "Claude Code native fork of obra/superpowers"
git remote add origin https://github.com/Stashub/superpowers-cc-native.git
```

- [ ] **Step 3: Push**

Run: `git push --follow-tags origin main upstream`
Expected: хук `pre-push` проходит, обе ветки и теги `v7.0.2-cc.1`, `upstream/v7.0.2` отправлены.

- [ ] **Step 4: Сверить**

```bash
git ls-remote origin
gh repo view Stashub/superpowers-cc-native --json visibility,isFork,defaultBranchRef
```

Expected:
- в `ls-remote` есть `refs/heads/main`, `refs/heads/upstream`, `refs/tags/v7.0.2-cc.1`, `refs/tags/upstream/v7.0.2`, и нет `refs/obra/*`;
- `PUBLIC`, `isFork: false`, ветка по умолчанию `main`. Если не `main`: `gh repo edit Stashub/superpowers-cc-native --default-branch main`.

---

### Task 10: Установка и переход (по слову владельца)

Глобальные настройки владельца. Каждый шаг - только после его подтверждения. Личные шаги владельца (вне репозитория) - в его приватной заметке, её читает исполнитель с доступом к памяти владельца.

- [ ] **Step 1: Посмотреть, какой оригинал стоит**

Run: `claude plugin list`

- [ ] **Step 2: Выключить оригинал, затем поставить наш**

```bash
claude plugin disable superpowers@superpowers-marketplace --scope user
claude plugin install superpowers-cc-native --marketplace Stashub/superpowers-cc-native
```

Если стоит оригинал из официального marketplace, в первой команде `superpowers@claude-plugins-official`.

- [ ] **Step 3: Сверить**

Run: `claude plugin list`
Expected: `superpowers-cc-native@superpowers-cc-native`, версия `7.0.2-cc.1`, enabled; оригинал disabled.

- [ ] **Step 4: Проба новой сессией**

Команда из задачи 8, шаг 4, без `--plugin-dir` и `--settings`.
Expected: тот же JSON. Дополнительно путь плагина в `init.plugins` содержит `/superpowers-cc-native/7.0.2-cc.1`.
