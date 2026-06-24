# pi-cc-commands

Browse Claude Code-format slash commands (`.claude/commands/**/*.md`) from
inside pi, without polluting context with their definitions.

Pi already loads Claude Code skills if you point its `skills` setting at the
right directories — this extension is intentionally **commands-only**.

## What it does

Registers two commands:

| Command | Purpose |
|---|---|
| `/cc-commands` | Open a picker over every Claude Code command discovered from the current cwd, then prefill the editor with the expanded body of the selected one |
| `/cc-commands-info` | Show which roots and individual commands were resolved, for debugging |

The expanded body lands in the editor via `setEditorText` so you can review,
edit, or augment it before pressing Enter. Nothing gets added to the system
prompt or the autocomplete list, so a monorepo with hundreds of CC commands
costs zero tokens during normal use.

The picker uses pi's `SelectList` component with a layered fuzzy filter:

- **type to filter** — fuzzy match across command name and description (uses `fuzzyFilter` from `@earendil-works/pi-tui`, so all query chars must appear in order; multiple space-separated tokens all have to match)
- **Backspace** removes one character from the filter; **Ctrl+U** (or `deleteToLineStart`) clears it
- `↑`/`↓` navigate, **Enter** picks, **Esc** cancels
- 15-row scrolling viewport regardless of how many commands you have
- Filter status (`Filter: foo  (12/169)`) renders under the list so you can see the active query and match count

## Discovery

Walks from `cwd` up to the git/worktree root, collecting every `.claude/commands`
along the way (deepest wins on name collision), then adds `~/.claude/commands`,
then any directories under `extraCommandRoots` in config.

Names follow the Claude Code namespacing convention:

```
.claude/commands/git/silver-bullet.md  → /cc-commands git:silver-bullet
.claude/commands/walkthrough.md        → /cc-commands walkthrough
.claude/commands/zip-intro/triage.md   → /cc-commands zip-intro:triage
```

Files under any `references/` subdirectory are skipped — that's the CC
convention for companion docs that aren't themselves commands.

## Usage

```text
/cc-commands                            # picker
/cc-commands git:silver-bullet          # load by name; will ask for args if needed
/cc-commands git:silver-bullet --watch  # load by name with args
/cc-commands-info                       # debug: show roots and what was found
```

When a command's body references `$ARGUMENTS`/`$1`/etc. or its frontmatter has
an `argument-hint`, you'll be prompted for arguments before the editor is
prefilled. Supported substitutions:

- `$1` … `$9`
- `$@`, `$ARGUMENTS`, `${ARGUMENTS}`
- `${1:-default}` (POSIX-style default)
- `${@:N}` (args from N onward), `${@:N:L}` (L args starting at N)

Quoted arguments work as expected: `--message "hello world"` → `$1 = --message`,
`$2 = hello world`.

## Configuration

All defaults are sensible — no config required. To override, drop a file at
`~/.pi/agent/cc-commands.json`:

```json
{
  "extraCommandRoots": ["/path/to/extra/commands"],
  "expandAtRefs": false,
  "execBashOnExpand": false,
  "maxFileBytes": 204800,
  "execTimeoutMs": 30000
}
```

Env-var overrides:

| Env | Effect |
|---|---|
| `PI_CC_EXPAND_AT_REFS=1` | Inline `@path/to/file` references in command bodies |
| `PI_CC_EXEC_BASH=1` | Execute `!cmd` lines at expand time and inline output |

Both expansion knobs are **off by default**. They were designed for Claude
Code's permission model and you almost certainly don't want them firing every
time you pick a command in pi. Leave them off unless you know you need them.

If you enable them, the extension warns when a selected command contains
unsupported syntax so it's clear what would have happened in Claude Code.

## Install

This package is shaped like a standard pi local package. Add the absolute path
to the `packages` array in `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "/home/you/git/mikansoro/pi-cc-commands"
  ]
}
```

Then `/reload` (or restart pi) and run `/cc-commands-info` to confirm
discovery.

## Notes

- Skills are intentionally not handled here. Add `~/.claude/skills` and/or
  `.claude/skills` to pi's `skills` setting if you want them — pi has
  first-class support for that.
- `allowed-tools` and `model` frontmatter is parsed but not enforced. Both
  fields are CC-specific and the safer default is to let you keep the model
  and tools you already had selected when invoking the command.
- The git-root walk recognizes worktrees (`.git` may be a file, not a
  directory), so per-worktree `.claude/commands` overrides work correctly.
