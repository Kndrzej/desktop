# Edit From History

## Problem

AI coding agents create many commits. During review, developers often spot
small mistakes in earlier commits — a typo, a wrong constant, a missing null
check.

Rewriting history (amend, rebase, force-push) is risky and disruptive,
especially on shared branches. Developers need a way to fix the mistake **now**
without changing any commit hashes.

## Solution

**Edit From History** lets you open a file from a historical commit, edit its
content, and apply that edit as a normal uncommitted working-tree change.

The mental model is similar to DBeaver:

1. See a historical value (database row / file at commit).
2. Edit it.
3. The tool generates an operation (SQL `UPDATE` / file patch).
4. The operation is applied to the live state (database / working tree).

## Feature UX (MVP)

In History, select a commit and a text file. **Green (added) lines** in the
diff on the right become editable inputs in place — no separate editor window.

1. Edit one or more green lines.
2. Click **Apply Changes** in the diff header.
3. Desktop writes the resulting file into the working tree and switches to Changes.

If later commits touched the same path, editing is blocked with:

> This file has changed after this commit. Editing is disabled to prevent
> overwriting newer changes.

## Guarantees

- **Commits are unchanged** — no amend, rebase, reset, or checkout of old commits.
- **History is immutable** — commit hashes stay the same.
- **Only working-tree changes are created** — the result is a regular file
  modification you can review, stage, and commit separately.

Historical commits are a **reference/source**, never a write target.

## Safety / security

- Paths must stay inside the repository (`resolveWithin` + traversal checks).
- Commit identifiers are validated before being passed to Git.
- Git is invoked with argument arrays (no shell string concatenation).
- Line edits cannot introduce embedded newlines.
- Binary files (NUL bytes) are refused.
- No extra npm packages, native addons, or install hooks were added for this feature.

Before editing is enabled for `(commit SHA, file path)`:

1. The commit must be an ancestor of `HEAD`.
2. No later commit on the current branch may have touched the same path:

   ```
   git rev-list -1 <commit>..HEAD -- <path>
   ```

Safety is checked again immediately before applying.

## Architecture

| Layer | Role |
|-------|------|
| `app/src/lib/git/edit-from-history.ts` | Validation, safety checks, blob load, working-tree write |
| `app/src/lib/stores/app-store.ts` | `_applyEditFromHistory` → write + refresh + switch to Changes |
| `app/src/ui/dispatcher/dispatcher.ts` | UI-facing API |
| `app/src/ui/history/selected-commits.tsx` | History wiring + Apply |
| `app/src/ui/diff/side-by-side-diff-row.tsx` | Inline green-line inputs |
| `app/src/lib/feature-flag.ts` | `enableEditFromHistory()` (on by default in this fork) |

## Using this fork

Standard Desktop setup only — no special env vars, no extra libraries:

```shell
yarn
yarn build:dev
yarn start
```

See [setup docs](contributing/setup.md) for platform prerequisites (Node, Yarn, Python, VS build tools on Windows). Those are the normal GitHub Desktop build requirements, not feature-specific.

## Limitations (MVP)

- Text files only (binary / image / submodule diffs are excluded).
- Single-commit selection only (commit ranges not supported).
- Only green (added) lines are editable in the commit diff.
- Does not merge into newer file content — blocked instead when unsafe.
- Does not warn about existing uncommitted edits to the same path (overwrite).
