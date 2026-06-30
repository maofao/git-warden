# git-warden

`git-warden` is a lightweight CLI wrapper around `git` that asks for confirmation before potentially risky commands after a long terminal idle period.

## Why

After long inactivity, it is easy to forget to sync your branch before running commands like `commit` or `push`. This tool adds a quick confirmation checkpoint.

## MVP behavior

- Wraps `git` commands through `git-guard`.
- Tracks the last command timestamp in `~/.git-activity-guard-timestamp`.
- For `push`, `commit`, and `checkout`, asks for `y/n` confirmation when idle time exceeds threshold.
- For other commands, forwards directly to `git`.

## Install

### Local (recommended for project development)

```bash
npm install --save-dev git-warden
```

### Global

```bash
npm install --global git-warden
```

## Usage

Run `git` subcommands via `git-warden` (or `git-guard`):

```bash
git-warden status
git-warden commit -m "feat: add core logic"
git-warden push origin main
```

## Team setup (`init`)

To enable repository-level protection for everyone in a project, run:

```bash
git-warden init
```

This command:

- creates repo config `.git-warden.json` (if missing)
- installs hooks:
  - `.git/hooks/pre-commit`
  - `.git/hooks/pre-push`
  - `.git/hooks/post-checkout`

`pre-commit` and `pre-push` run idle checks via `git-warden hook-check`, so even plain `git commit` / `git push` are protected.

## Use with regular `git` commands

If you want protection while typing normal `git ...`, add a shell wrapper that redirects all git calls to `git-warden`.

### PowerShell (Windows)

Open your PowerShell profile:

```powershell
notepad $PROFILE
```

Add this function:

```powershell
function git { git-warden @args }
```

Restart PowerShell. After that, your usual commands work as-is:

```powershell
git status
git commit -m "..."
git push
```

To bypass wrapper once:

```powershell
git.exe status
```

If idle time is over threshold and command is dangerous, the tool prompts:

```text
Warning: terminal idle for about 92 minute(s). Run "git push origin main"? (y/n):
```

- `y` -> command proceeds.
- `n` -> command is cancelled with success exit code (`0`).

## Configuration

`git-warden` supports both repository and user config.

Repository config (recommended for teams):

- `./.git-warden.json`

User config (fallback):

- `~/.git-warden.json`

Configs are created automatically with defaults:

```json
{
  "thresholdSeconds": 3600
}
```

You can change `thresholdSeconds` to any positive integer.

Priority of settings:

1. `GIT_ACTIVITY_THRESHOLD` environment variable
2. `./.git-warden.json` (`thresholdSeconds`)
3. `~/.git-warden.json` (`thresholdSeconds`)
4. Default value (`3600`)

Environment variable:

- `GIT_ACTIVITY_THRESHOLD` - idle threshold in seconds.
  - Default: `3600` (1 hour).
  - Invalid or non-positive values fall back to default.

Example:

```bash
GIT_ACTIVITY_THRESHOLD=1800 git-warden push
```

## Notes

- This is an MVP focused on interactive terminal usage.
- Timestamp updates when a command is allowed to execute.
