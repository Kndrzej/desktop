import { mkdir, writeFile } from 'fs/promises'
import * as Path from 'path'
import { Repository } from '../../models/repository'
import { resolveWithin } from '../path'
import { git } from './core'
import { getBlobContents } from './show'
import { revRange } from './rev-list'

/**
 * Result of the Edit From History safety check.
 *
 * Historical commits are treated as a read-only reference. Editing is only
 * allowed when no later commit on the current branch has touched the same
 * path, so writing the edited content into the working tree cannot silently
 * overwrite newer committed changes.
 */
export type EditFromHistorySafetyResult =
  | { readonly kind: 'safe' }
  | {
      readonly kind: 'unsafe'
      readonly reason: EditFromHistoryUnsafeReason
      readonly message: string
    }

export type EditFromHistoryUnsafeReason =
  | 'modified-after-commit'
  | 'not-ancestor'

export const editFromHistoryBlockedMessage =
  'This file has changed after this commit. Editing is disabled to prevent overwriting newer changes.'

/** Reject path traversal / absolute paths / control characters before any git or fs use. */
export function assertSafeRepositoryRelativePath(path: string): void {
  if (path.length === 0 || path.length > 4096) {
    throw new Error('Invalid repository-relative path.')
  }

  if (path.includes('\0') || /[\r\n]/.test(path)) {
    throw new Error('Invalid repository-relative path.')
  }

  if (Path.isAbsolute(path) || /^[a-zA-Z]:[\\/]/.test(path)) {
    throw new Error('Absolute paths are not allowed.')
  }

  const normalized = Path.posix.normalize(path.replace(/\\/g, '/'))
  if (
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.split('/').includes('..')
  ) {
    throw new Error('Path traversal is not allowed.')
  }
}

/**
 * Only allow commit identifiers that look like SHAs or simple refs.
 * Git is invoked with argument arrays (no shell), but we still reject odd
 * values that should never come from Desktop's commit list UI.
 */
export function assertSafeCommitish(commitish: string): void {
  if (commitish.length === 0 || commitish.length > 256) {
    throw new Error('Invalid commit identifier.')
  }

  if (commitish.includes('\0') || /[\r\n\s]/.test(commitish)) {
    throw new Error('Invalid commit identifier.')
  }

  // Full or abbreviated SHA, or a conservative ref-like token (no option dashes).
  const sha = /^[0-9a-fA-F]{7,40}$/
  const ref = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/
  if (!sha.test(commitish) && !ref.test(commitish)) {
    throw new Error('Invalid commit identifier.')
  }

  if (commitish.includes('..') || commitish.startsWith('-')) {
    throw new Error('Invalid commit identifier.')
  }
}

/**
 * Returns true when any commit reachable from HEAD (but not from `commitish`)
 * has modified `path`.
 *
 * Safety decision: we intentionally look at path history after the selected
 * commit rather than rewriting or checking out that commit. An empty result
 * means the blob at `commitish` is still the tip content for this path on the
 * current branch lineage, so applying an edit as a working-tree change is safe.
 */
export async function isPathModifiedAfterCommit(
  repository: Repository,
  commitish: string,
  path: string
): Promise<boolean> {
  assertSafeCommitish(commitish)
  assertSafeRepositoryRelativePath(path)

  const args = ['rev-list', '-1', revRange(commitish, 'HEAD'), '--', path]

  const result = await git(args, repository.path, 'isPathModifiedAfterCommit', {
    // 128: unborn HEAD / bad revision
    successExitCodes: new Set([0, 128]),
  })

  if (result.exitCode === 128) {
    return true
  }

  return result.stdout.trim().length > 0
}

/**
 * Whether `commitish` is an ancestor of HEAD on the current branch.
 */
export async function isCommitAncestorOfHead(
  repository: Repository,
  commitish: string
): Promise<boolean> {
  assertSafeCommitish(commitish)

  const result = await git(
    ['merge-base', '--is-ancestor', commitish, 'HEAD'],
    repository.path,
    'isCommitAncestorOfHead',
    {
      // 0 = yes, 1 = no, 128 = missing refs
      successExitCodes: new Set([0, 1, 128]),
    }
  )

  return result.exitCode === 0
}

/**
 * Decide whether editing a historical file version into the working tree is safe.
 *
 * Does not amend, rebase, checkout, or otherwise rewrite history.
 */
export async function getEditFromHistorySafety(
  repository: Repository,
  commitish: string,
  path: string
): Promise<EditFromHistorySafetyResult> {
  assertSafeCommitish(commitish)
  assertSafeRepositoryRelativePath(path)

  const ancestor = await isCommitAncestorOfHead(repository, commitish)
  if (!ancestor) {
    return {
      kind: 'unsafe',
      reason: 'not-ancestor',
      message: editFromHistoryBlockedMessage,
    }
  }

  const modifiedAfter = await isPathModifiedAfterCommit(
    repository,
    commitish,
    path
  )

  if (modifiedAfter) {
    return {
      kind: 'unsafe',
      reason: 'modified-after-commit',
      message: editFromHistoryBlockedMessage,
    }
  }

  return { kind: 'safe' }
}

/**
 * Load UTF-8 text content of a file at a historical commit.
 *
 * Returns null when the blob appears binary (contains a NUL byte).
 */
export async function getHistoricalTextContents(
  repository: Repository,
  commitish: string,
  path: string
): Promise<string | null> {
  assertSafeCommitish(commitish)
  assertSafeRepositoryRelativePath(path)

  const buffer = await getBlobContents(repository, commitish, path)

  // Heuristic: treat files with embedded NUL as binary and refuse in-app editing.
  if (buffer.includes(0)) {
    return null
  }

  return buffer.toString('utf8')
}

/**
 * Build a unified diff that replaces `before` with `after` for `path`.
 *
 * Used as the conceptual "patch" for Edit From History. The MVP applies the
 * result by writing `after` to the working tree (equivalent to applying this
 * full-file replacement when the on-disk content matches `before`).
 */
export function generateFullFileReplacementPatch(
  path: string,
  before: string,
  after: string
): string {
  assertSafeRepositoryRelativePath(path)

  const beforeLines = splitLines(before)
  const afterLines = splitLines(after)

  const lines: string[] = [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
  ]

  for (const line of beforeLines) {
    lines.push(`-${line}`)
  }
  for (const line of afterLines) {
    lines.push(`+${line}`)
  }

  return `${lines.join('\n')}\n`
}

/**
 * Write edited historical content into the current working tree only.
 *
 * Guarantees:
 * - Does not amend, rebase, reset, or checkout commits
 * - Does not stage the change (leaves it as a normal uncommitted modification)
 * - Refuses to write outside the repository root
 */
export async function applyHistoricalEditToWorkingTree(
  repository: Repository,
  path: string,
  contents: string
): Promise<void> {
  assertSafeRepositoryRelativePath(path)

  // Soft cap to avoid accidental huge writes from a bad UI state.
  if (contents.length > 50 * 1024 * 1024) {
    throw new Error('Refusing to write unusually large file contents.')
  }

  const absolutePath = await resolveWritableRepositoryPath(
    repository.path,
    path
  )

  await mkdir(Path.dirname(absolutePath), { recursive: true })
  await writeFile(absolutePath, contents, 'utf8')
}

/**
 * Resolve a repository-relative path to an absolute path that is safe to write.
 *
 * `resolveWithin` uses `realpath`, which fails when the file does not yet
 * exist on disk. For Edit From History we therefore resolve the parent
 * directory (which must exist under the repo) and join the basename.
 */
async function resolveWritableRepositoryPath(
  repositoryPath: string,
  relativePath: string
): Promise<string> {
  assertSafeRepositoryRelativePath(relativePath)

  const existing = await resolveWithin(repositoryPath, relativePath).catch(
    () => null
  )
  if (existing !== null) {
    return existing
  }

  const parentRelative = Path.dirname(relativePath)
  const parentAbsolute =
    parentRelative === '.' || parentRelative === ''
      ? await resolveWithin(repositoryPath, '.')
      : await resolveWithin(repositoryPath, parentRelative)

  if (parentAbsolute === null) {
    throw new Error(
      `Refusing to write path outside the repository: ${relativePath}`
    )
  }

  const absolutePath = Path.join(parentAbsolute, Path.basename(relativePath))

  // Final containment check after join (defends against odd basename edge cases).
  const repoRoot = await resolveWithin(repositoryPath, '.')
  if (repoRoot === null) {
    throw new Error('Unable to resolve repository root.')
  }

  const relative = Path.relative(repoRoot, absolutePath)
  if (
    relative.startsWith('..') ||
    Path.isAbsolute(relative) ||
    relative.split(Path.sep).includes('..')
  ) {
    throw new Error(
      `Refusing to write path outside the repository: ${relativePath}`
    )
  }

  return absolutePath
}

/**
 * Apply per-line edits (1-based new-file line numbers) onto a full file string.
 *
 * Used by Edit From History when the user changes green (added) lines in the
 * commit diff: those line numbers refer to the file as it existed in that
 * commit ("new" side of the diff).
 */
export function applyLineEditsToFileContents(
  originalContents: string,
  lineEdits: ReadonlyMap<number, string>
): string {
  if (lineEdits.size === 0) {
    return originalContents
  }

  const endsWithNewline = originalContents.endsWith('\n')
  const lines =
    originalContents.length === 0
      ? []
      : (endsWithNewline
          ? originalContents.slice(0, -1)
          : originalContents
        ).split('\n')

  for (const [lineNumber, content] of lineEdits) {
    if (
      !Number.isInteger(lineNumber) ||
      lineNumber < 1 ||
      lineNumber > lines.length
    ) {
      continue
    }

    // Edits are plain text line replacements only (no multi-line injection).
    if (content.includes('\n') || content.includes('\r')) {
      throw new Error('Line edits must not contain newline characters.')
    }

    lines[lineNumber - 1] = content
  }

  if (lines.length === 0) {
    return endsWithNewline ? '\n' : ''
  }

  return endsWithNewline ? `${lines.join('\n')}\n` : lines.join('\n')
}

function splitLines(text: string): ReadonlyArray<string> {
  if (text.length === 0) {
    return []
  }

  const normalized = text.endsWith('\n') ? text.slice(0, -1) : text
  return normalized.split('\n')
}
