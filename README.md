# codex-nav

A small Windows-first terminal navigator for Codex CLI.

It is designed for phone/remote terminal use where a simple numbered menu is more reliable than a full-screen TUI. It reuses HAPI's existing workspace/session metadata without writing to HAPI's database.

## Features

- Discovers HAPI workspace roots from `~/.hapi/runner.state.json`.
- Lists only real project directories under the configured workspace root; historical Codex working directories no longer appear as workspace projects.
- Reads both active sessions from `~/.codex/sessions` and archived sessions from `~/.codex/archived_sessions`.
- Reads `~/.hapi/hapi.db` in **read-only** mode to enrich titles/worktree metadata.
- Groups HAPI/Codex sessions by base project.
- Shows non-workspace Codex history under `Other Codex sessions` and provides an `All Codex sessions` view.
- Marks sessions as `[Codex]` or `[Codex · HAPI]` depending on whether HAPI metadata is attached.
- Shows session title, last update time, worktree and branch information.
- Sorts project sessions by last update time descending and prefixes archived entries with `[已归档]`.
- Paginates long project session lists for mobile terminals.
- Resumes a saved Codex session.
- Detects when a HAPI-managed process still owns a Codex session and offers a verified per-session takeover action.
- Archives a saved Codex session through the official Codex CLI.
- Starts a new Codex session in the main project directory.
- Creates a Git worktree + branch and starts Codex there.
- Creates new workspace directories and can initialize Git.
- Uses `--no-alt-screen` for Codex interactive sessions, which is friendlier to mobile terminals.

## Requirements

- Windows
- Node.js 22+ (Node 24 recommended)
- Git
- Codex CLI available on `PATH`
- HAPI, if you want HAPI session discovery

No npm runtime dependencies are required.

## Install

Clone the repository and install the CLI globally from the local checkout:

```powershell
git clone https://github.com/wnarutou/codex-nav.git
cd codex-nav
npm install -g .
```

Then open your terminal and run:

```text
cx
```

For local development without global installation:

```powershell
node .\bin\codex-nav.js
```

## Typical flow

```text
codex-nav
------------

1. testa      (12 sessions)
2. gitrieve   (5 sessions)
3. testb      (3 sessions)

[C] Other Codex sessions (8)
[A] All Codex sessions (404)
[N] New workspace directory
[Q] Quit
> 1
```

Inside a project:

```text
1. Session title A              [Codex · HAPI]  [hapi-1002-abcd]  2026-10-02 22:30
2. [已归档] Session title B      [Codex]         [main]            2026-10-01 18:15

Page 1/3
[>] Next page
[N] New Codex session in this project
[W] New worktree + branch + Codex session
[B] Back
[Q] Quit
```

When a selected session is still open in HAPI, its detail menu shows the HAPI PID and a `[T] Take over from HAPI and resume` action. `codex-nav` re-checks that the PID is actually a `hapi.exe codex` process before terminating only that session process tree. It first requests a normal tree termination so HAPI can clean up its runtime owner state, and only falls back to a forced termination if needed.

`[C] Other Codex sessions` groups Codex sessions whose working directory is outside the configured workspace roots (for example old `Documents\\Codex\\...` directories). `[A] All Codex sessions` shows active and archived native Codex sessions together, newest first. All long session views are paginated for mobile terminals.

## HAPI integration

`codex-nav` treats Codex's own active and archived session stores as the source of truth and HAPI as a read-only metadata source. This means sessions created directly from `codex-nav` remain visible even if HAPI did not create them.

It reads:

- `~/.hapi/runner.state.json`
- `~/.hapi/hapi.db`

It does **not** update, delete, or otherwise modify `hapi.db`.

Session actions are delegated to Codex itself:

```text
codex resume <session-id>
codex archive <session-id>
codex unarchive <session-id>
```

Worktree creation is delegated to Git.

## Worktree naming

New worktrees are created beside the base repository:

```text
projects/
  demo/
  demo-worktrees/
    1003-a1b2/
```

The corresponding branch is named:

```text
codex-1003-a1b2
```

## Tests

```powershell
npm test
```

## Notes

This is an early version aimed at a specific workflow: Windows + HAPI + Codex CLI + remote/mobile terminal.

The project deliberately keeps the UI simple and avoids cursor-driven full-screen interfaces so that it remains usable through remote terminal apps.

## License

MIT
