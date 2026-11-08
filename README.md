# superpowers-cc-native

A Claude Code native fork of [obra/superpowers](https://github.com/obra/superpowers),
the core skills library for Claude Code: TDD, debugging, collaboration
patterns and proven techniques.

This fork targets Claude Code only. We add Claude Code capabilities on top of
the original and keep its support for other environments as is, without
maintaining it. If you use another environment (Codex, Gemini, OpenCode and so
on), use the original: [obra/superpowers](https://github.com/obra/superpowers).

Version numbers look like `7.0.2-cc.1`: the original release the fork is based
on, plus our own counter `-cc.N`.

## Install

Claude Code 2.1.275 or newer, one command:

```
claude plugin install superpowers-cc-native --marketplace Stashub/superpowers-cc-native
```

The command adds the marketplace to your user settings itself. The default
scope is `user`.

Older Claude Code versions, two commands:

```
claude plugin marketplace add Stashub/superpowers-cc-native
claude plugin install superpowers-cc-native@superpowers-cc-native --scope user
```

## Switching from the original

Disable the original first, then install this plugin. That way no new session
gets two sets of skills and two SessionStart hooks. The original comes from two
marketplaces; disable the one you have (see `claude plugin list`):

```
claude plugin disable superpowers@superpowers-marketplace --scope user
claude plugin disable superpowers@claude-plugins-official --scope user
```

Do not uninstall the original while sessions still run on it. Finish by
checking `claude plugin list`.

- **Skill names change.** `/superpowers:brainstorming` becomes
  `/superpowers-cc-native:brainstorming`. Fix such references in your own
  CLAUDE.md files and notes.
- **Running sessions** stay on the old plugin until `/reload-plugins`, `/cd`, a
  restart or `--resume`. `--resume` loads the plugin that is installed now.
- **Finish a plan started on the original with the original.** In the command
  below, replace `superpowers@superpowers-marketplace` with
  `superpowers@claude-plugins-official` if that is where you got it:

  ```
  claude --resume <id> --settings '{"enabledPlugins":{"superpowers@superpowers-marketplace":true,"superpowers-cc-native@superpowers-cc-native":false}}'
  ```

- **Roll back.** Disable this plugin and enable the original:

  ```
  claude plugin disable superpowers-cc-native@superpowers-cc-native --scope user
  claude plugin enable superpowers@superpowers-marketplace --scope user
  ```

## Updates

Updates are manual. Auto-update is off by default for third-party marketplaces
and we do not turn it on:

```
claude plugin marketplace update superpowers-cc-native
claude plugin update superpowers-cc-native@superpowers-cc-native
```

The new version loads in the next session or after `/reload-plugins`. A running
session stays on the old version, but Claude Code deletes the old version's
folder from its cache 14 days after an update. If a session must run longer
than that, postpone the update until the session ends.

## Differences from the original in v0

Only the name. The plugin is the original 7.0.2 under the name
`superpowers-cc-native`, with `superpowers:<skill>` references renamed to
`superpowers-cc-native:<skill>`. Known behavior that we do not change in v0:

- The visual companion page shows "Superpowers v<original version>" and links
  to obra. It reads the version from `plugin/package.json`, which keeps the
  original's number.
- The `diagnosing-superpowers` skill searches and files issues in
  `obra/superpowers`.

## Reporting a problem

If the problem also happens on the clean original, file the issue in
[obra/superpowers](https://github.com/obra/superpowers/issues). Otherwise file
it in this repository.

## How we track the original

Two branches:

- `upstream` holds only `plugin/`: one sealed, already renamed import per
  original release.
- `main` is `upstream` merged in, plus our own files.

Our differences from the original are always visible with one command:

```
git diff upstream main -- plugin/
```

A new original release is imported with `node tools/sync.mjs <tag>`.

## License

MIT. Copyright (c) 2025 Jesse Vincent, Copyright (c) 2026 Stashub. The original
license is kept in `plugin/LICENSE`.
