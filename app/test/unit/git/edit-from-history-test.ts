import { describe, it } from 'node:test'
import assert from 'node:assert'
import { readFile } from 'fs/promises'
import * as Path from 'path'
import { exec } from 'dugite'

import { setupEmptyRepository } from '../../helpers/repositories'
import { makeCommit } from '../../helpers/repository-scaffolding'
import { getTipOrError } from '../../helpers/git'
import {
  applyHistoricalEditToWorkingTree,
  applyLineEditsToFileContents,
  generateFullFileReplacementPatch,
  getEditFromHistorySafety,
  getHistoricalTextContents,
  isPathModifiedAfterCommit,
} from '../../../src/lib/git/edit-from-history'

describe('git/edit-from-history', () => {
  describe('isPathModifiedAfterCommit / getEditFromHistorySafety', () => {
    it('allows editing when a later commit touched a different file', async t => {
      const repository = await setupEmptyRepository(t)

      await makeCommit(repository, {
        entries: [{ path: 'Player.cpp', contents: 'int x = 1;\n' }],
        commitMessage: 'add Player',
      })
      const playerCommit = await getTipOrError(repository)

      await makeCommit(repository, {
        entries: [{ path: 'UI.cpp', contents: 'void draw() {}\n' }],
        commitMessage: 'add UI',
      })

      assert.equal(
        await isPathModifiedAfterCommit(
          repository,
          playerCommit.sha,
          'Player.cpp'
        ),
        false
      )

      const safety = await getEditFromHistorySafety(
        repository,
        playerCommit.sha,
        'Player.cpp'
      )
      assert.equal(safety.kind, 'safe')
    })

    it('blocks editing when a later commit touched the same file', async t => {
      const repository = await setupEmptyRepository(t)

      await makeCommit(repository, {
        entries: [{ path: 'Player.cpp', contents: 'int x = 1;\n' }],
        commitMessage: 'add Player',
      })
      const playerCommit = await getTipOrError(repository)

      await makeCommit(repository, {
        entries: [{ path: 'Player.cpp', contents: 'int x = 2;\n' }],
        commitMessage: 'update Player',
      })

      assert.equal(
        await isPathModifiedAfterCommit(
          repository,
          playerCommit.sha,
          'Player.cpp'
        ),
        true
      )

      const safety = await getEditFromHistorySafety(
        repository,
        playerCommit.sha,
        'Player.cpp'
      )
      assert.equal(safety.kind, 'unsafe')
      if (safety.kind === 'unsafe') {
        assert.equal(safety.reason, 'modified-after-commit')
        assert.match(safety.message, /changed after this commit/i)
      }
    })
  })

  describe('generateFullFileReplacementPatch', () => {
    it('produces a unified diff from before to after content', () => {
      const patch = generateFullFileReplacementPatch(
        'Player.cpp',
        'int x = 1;\n',
        'int x = 42;\n'
      )

      assert.match(patch, /diff --git a\/Player\.cpp b\/Player\.cpp/)
      assert.match(patch, /^-int x = 1;$/m)
      assert.match(patch, /^\+int x = 42;$/m)
    })
  })

  describe('applyLineEditsToFileContents', () => {
    it('replaces specific 1-based lines', () => {
      const result = applyLineEditsToFileContents(
        'a\nb\nc\n',
        new Map([[2, 'B']])
      )
      assert.equal(result, 'a\nB\nc\n')
    })
  })

  describe('applyHistoricalEditToWorkingTree', () => {
    it('writes working-tree changes without rewriting commits', async t => {
      const repository = await setupEmptyRepository(t)

      await makeCommit(repository, {
        entries: [{ path: 'Player.cpp', contents: 'int x = 1;\n' }],
        commitMessage: 'add Player',
      })
      const first = await getTipOrError(repository)

      await makeCommit(repository, {
        entries: [{ path: 'UI.cpp', contents: 'void draw() {}\n' }],
        commitMessage: 'add UI',
      })
      const headBefore = await getTipOrError(repository)

      const historical = await getHistoricalTextContents(
        repository,
        first.sha,
        'Player.cpp'
      )
      assert.equal(historical, 'int x = 1;\n')

      const edited = 'int x = 99;\n'
      const patch = generateFullFileReplacementPatch(
        'Player.cpp',
        historical!,
        edited
      )
      assert.match(patch, /\+int x = 99;/)

      await applyHistoricalEditToWorkingTree(
        repository,
        'Player.cpp',
        edited
      )

      const onDisk = await readFile(
        Path.join(repository.path, 'Player.cpp'),
        'utf8'
      )
      assert.equal(onDisk, edited)

      const headAfter = await getTipOrError(repository)
      assert.equal(headAfter.sha, headBefore.sha)
      assert.equal(headAfter.sha, (await getTipOrError(repository)).sha)

      // Confirm the historical commit object is unchanged.
      const show = await exec(
        ['cat-file', '-p', first.sha],
        repository.path
      )
      assert.equal(show.exitCode, 0)

      const status = await exec(['status', '--porcelain'], repository.path)
      assert.match(status.stdout, /Player\.cpp/)
    })
  })
})
