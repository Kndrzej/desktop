import * as React from 'react'
import { clipboard } from 'electron'
import * as Path from 'path'

import { Repository } from '../../models/repository'
import { AppFileStatusKind, CommittedFileChange } from '../../models/status'
import { Commit } from '../../models/commit'
import { DiffType, IDiff, ImageDiffType } from '../../models/diff'

import { encodePathAsUrl } from '../../lib/path'
import { revealInFileManager } from '../../lib/app-shell'

import { openFile } from '../lib/open-file'
import {
  isSafeFileExtension,
  CopyFilePathLabel,
  DefaultEditorLabel,
  RevealInFileManagerLabel,
  OpenWithDefaultProgramLabel,
  CopyRelativeFilePathLabel,
} from '../lib/context-menu'
import { ThrottledScheduler } from '../lib/throttled-scheduler'

import { Dispatcher } from '../dispatcher'
import { Resizable } from '../resizable'
import { showContextualMenu } from '../../lib/menu-item'

import { FileList } from './file-list'
import { SeamlessDiffSwitcher } from '../diff/seamless-diff-switcher'
import { getDotComAPIEndpoint } from '../../lib/api'
import { IMenuItem } from '../../lib/menu-item'
import { IChangesetData } from '../../lib/git'
import { IConstrainedValue } from '../../lib/app-state'
import { clamp } from '../../lib/clamp'
import { pathExists } from '../../lib/path-exists'
import { UnreachableCommitsTab } from './unreachable-commits-dialog'
import { ExpandableCommitSummary } from './expandable-commit-summary'
import { DiffHeader } from '../diff/diff-header'
import { Account } from '../../models/account'
import { Emoji } from '../../lib/emoji'
import { enableEditFromHistory } from '../../lib/feature-flag'
import {
  applyLineEditsToFileContents,
} from '../../lib/git/edit-from-history'

interface ISelectedCommitsProps {
  readonly repository: Repository
  readonly dispatcher: Dispatcher
  readonly emoji: Map<string, Emoji>
  readonly selectedCommits: ReadonlyArray<Commit>
  readonly shasInDiff: ReadonlyArray<string>
  readonly localCommitSHAs: ReadonlyArray<string>
  readonly changesetData: IChangesetData
  readonly selectedFile: CommittedFileChange | null
  readonly currentDiff: IDiff | null
  readonly commitSummaryWidth: IConstrainedValue
  readonly selectedDiffType: ImageDiffType
  /** The name of the currently selected external editor */
  readonly externalEditorLabel?: string

  /**
   * Called to open a file using the user's configured applications
   *
   * @param path The path of the file relative to the root of the repository
   */
  readonly onOpenInExternalEditor: (path: string) => void
  readonly onViewCommitOnGitHub: (SHA: string, filePath?: string) => void
  readonly hideWhitespaceInDiff: boolean

  /** Whether we should display side by side diffs. */
  readonly showSideBySideDiff: boolean

  /**
   * Called when the user requests to open a binary file in an the
   * system-assigned application for said file type.
   */
  readonly onOpenBinaryFile: (fullPath: string) => void

  /** Called when the user requests to open a submodule. */
  readonly onOpenSubmodule: (fullPath: string) => void

  /**
   * Called when the user is viewing an image diff and requests
   * to change the diff presentation mode.
   */
  readonly onChangeImageDiffType: (type: ImageDiffType) => void

  /** Called when the user opens the diff options popover */
  readonly onDiffOptionsOpened: () => void

  /** Whether or not to show the drag overlay */
  readonly showDragOverlay: boolean

  /** Whether or not the selection of commits is contiguous */
  readonly isContiguous: boolean

  readonly accounts: ReadonlyArray<Account>
}

interface ISelectedCommitsState {
  readonly isExpanded: boolean
  /** Whether there is at least one pending green-line edit */
  readonly hasLineEdits: boolean
  readonly editBlockedMessage: string | null
  readonly isEditApplying: boolean
  readonly historicalContents: string | null
  readonly editFileKey: string | null
}

/** The History component. Contains the commit list, commit summary, and diff. */
export class SelectedCommits extends React.Component<
  ISelectedCommitsProps,
  ISelectedCommitsState
> {
  private readonly loadChangedFilesScheduler = new ThrottledScheduler(200)
  /** Latest green-line edits; kept in a ref so typing does not re-render the diff. */
  private readonly lineEditsRef = new Map<number, string>()

  public constructor(props: ISelectedCommitsProps) {
    super(props)

    this.state = {
      isExpanded: false,
      hasLineEdits: false,
      editBlockedMessage: null,
      isEditApplying: false,
      historicalContents: null,
      editFileKey: null,
    }
  }

  private onFileSelected = (file: CommittedFileChange) => {
    this.clearEditFromHistory()
    this.props.dispatcher.changeFileSelection(this.props.repository, file)
  }

  private onRowDoubleClick = (row: number) => {
    const files = this.props.changesetData.files
    const file = files[row]

    this.props.onOpenInExternalEditor(file.path)
  }

  public componentWillUpdate(nextProps: ISelectedCommitsProps) {
    // reset isExpanded if we're switching commits.
    const currentValue = this.props.selectedCommits.map(c => c.sha).join('')
    const nextValue = nextProps.selectedCommits.map(c => c.sha).join('')

    if (currentValue !== nextValue) {
      if (this.state.isExpanded) {
        this.setState({ isExpanded: false })
      }
      this.clearEditFromHistory()
    }

    const nextFileKey = getEditFileKey(nextProps.selectedFile)
    if (
      this.state.editFileKey !== null &&
      nextFileKey !== this.state.editFileKey
    ) {
      this.clearEditFromHistory()
    }
  }

  public componentDidUpdate(prevProps: ISelectedCommitsProps) {
    const prevKey = getEditFileKey(prevProps.selectedFile)
    const nextKey = getEditFileKey(this.props.selectedFile)
    if (
      nextKey !== null &&
      nextKey !== prevKey &&
      this.canEditFromHistory(this.props.selectedFile)
    ) {
      void this.ensureHistoricalContentsLoaded(this.props.selectedFile!)
    }
  }

  public componentWillUnmount() {
    this.loadChangedFilesScheduler.clear()
  }

  private canEditFromHistory(
    file: CommittedFileChange | null = this.props.selectedFile
  ): boolean {
    if (!enableEditFromHistory()) {
      return false
    }

    if (file === null) {
      return false
    }

    if (this.props.selectedCommits.length !== 1) {
      return false
    }

    if (file.status.kind === AppFileStatusKind.Deleted) {
      return false
    }

    const diff = this.props.currentDiff
    if (
      diff !== null &&
      (diff.kind === DiffType.Binary ||
        diff.kind === DiffType.Image ||
        diff.kind === DiffType.Submodule ||
        diff.kind === DiffType.Unrenderable)
    ) {
      return false
    }

    return true
  }

  private clearEditFromHistory = () => {
    this.lineEditsRef.clear()

    if (
      !this.state.hasLineEdits &&
      this.state.editBlockedMessage === null &&
      this.state.historicalContents === null &&
      !this.state.isEditApplying
    ) {
      return
    }

    this.setState({
      hasLineEdits: false,
      editBlockedMessage: null,
      isEditApplying: false,
      historicalContents: null,
      editFileKey: null,
    })
  }

  private ensureHistoricalContentsLoaded = async (
    file: CommittedFileChange
  ): Promise<string | null> => {
    if (
      this.state.historicalContents !== null &&
      this.state.editFileKey === getEditFileKey(file) &&
      this.state.editBlockedMessage === null
    ) {
      return this.state.historicalContents
    }

    const safety = await this.props.dispatcher.getEditFromHistorySafety(
      this.props.repository,
      file.commitish,
      file.path
    )

    if (safety.kind === 'unsafe') {
      this.lineEditsRef.clear()
      this.setState({
        editBlockedMessage: safety.message,
        hasLineEdits: false,
        historicalContents: null,
        editFileKey: getEditFileKey(file),
      })
      return null
    }

    const contents = await this.props.dispatcher.getHistoricalTextContents(
      this.props.repository,
      file.commitish,
      file.path
    )

    if (contents === null) {
      this.lineEditsRef.clear()
      this.setState({
        editBlockedMessage:
          'This file appears to be binary. Editing is not supported.',
        hasLineEdits: false,
        historicalContents: null,
        editFileKey: getEditFileKey(file),
      })
      return null
    }

    this.setState({
      historicalContents: contents,
      editBlockedMessage: null,
      editFileKey: getEditFileKey(file),
    })

    return contents
  }

  private getEditFromHistoryLine = (
    lineNumber: number
  ): string | undefined => {
    return this.lineEditsRef.get(lineNumber)
  }

  private onEditFromHistoryLineChanged = (
    lineNumber: number,
    content: string
  ) => {
    const file = this.props.selectedFile
    if (
      !this.canEditFromHistory(file) ||
      file === null ||
      this.state.editBlockedMessage !== null
    ) {
      return
    }

    // Never await here — async parent updates reset the caret and drop keystrokes.
    const historical = this.state.historicalContents
    if (historical === null) {
      const wasEmpty = this.lineEditsRef.size === 0
      this.lineEditsRef.set(lineNumber, content)
      if (wasEmpty) {
        this.setState({ hasLineEdits: true })
      }
      void this.ensureHistoricalContentsLoaded(file)
      return
    }

    const lines = (
      historical.endsWith('\n') ? historical.slice(0, -1) : historical
    ).split('\n')
    const original = lines[lineNumber - 1]
    const wasEmpty = this.lineEditsRef.size === 0

    if (original !== undefined && content === original) {
      this.lineEditsRef.delete(lineNumber)
    } else {
      this.lineEditsRef.set(lineNumber, content)
    }

    const isEmpty = this.lineEditsRef.size === 0
    if (wasEmpty !== isEmpty) {
      this.setState({ hasLineEdits: !isEmpty })
    }
  }

  private onApplyEditFromHistory = async () => {
    const file = this.props.selectedFile
    if (
      file === null ||
      this.state.editBlockedMessage !== null ||
      this.lineEditsRef.size === 0
    ) {
      return
    }

    this.setState({ isEditApplying: true })

    try {
      const safety = await this.props.dispatcher.getEditFromHistorySafety(
        this.props.repository,
        file.commitish,
        file.path
      )

      if (safety.kind === 'unsafe') {
        this.lineEditsRef.clear()
        this.setState({
          isEditApplying: false,
          editBlockedMessage: safety.message,
          hasLineEdits: false,
        })
        return
      }

      const historical =
        this.state.historicalContents ??
        (await this.props.dispatcher.getHistoricalTextContents(
          this.props.repository,
          file.commitish,
          file.path
        ))

      if (historical === null) {
        this.setState({
          isEditApplying: false,
          editBlockedMessage:
            'Unable to load historical file contents for apply.',
        })
        return
      }

      const nextContents = applyLineEditsToFileContents(
        historical,
        this.lineEditsRef
      )

      await this.props.dispatcher.applyEditFromHistory(
        this.props.repository,
        file.path,
        nextContents
      )

      this.clearEditFromHistory()
    } catch (error) {
      this.setState({ isEditApplying: false })
      this.props.dispatcher.postError(
        error instanceof Error
          ? error
          : new Error('Unable to apply edit from history.')
      )
    }
  }

  private renderDiff() {
    const file = this.props.selectedFile
    const diff = this.props.currentDiff

    if (file == null) {
      // don't show both 'empty' messages
      const message =
        this.props.changesetData.files.length === 0 ? '' : 'No file selected'

      return (
        <div className="panel blankslate" id="diff">
          {message}
        </div>
      )
    }

    const allowInlineEdit = this.canEditFromHistory(file)

    return (
      <div className="diff-container">
        {this.renderDiffHeader()}
        {this.state.editBlockedMessage !== null && (
          <div className="edit-from-history-banner blocked-inline">
            <p>{this.state.editBlockedMessage}</p>
          </div>
        )}
        <div className="edit-from-history-diff">
          <SeamlessDiffSwitcher
            repository={this.props.repository}
            imageDiffType={this.props.selectedDiffType}
            file={file}
            diff={diff}
            readOnly={true}
            hideWhitespaceInDiff={this.props.hideWhitespaceInDiff}
            showDiffCheckMarks={false}
            showSideBySideDiff={this.props.showSideBySideDiff}
            onOpenBinaryFile={this.props.onOpenBinaryFile}
            onChangeImageDiffType={this.props.onChangeImageDiffType}
            onHideWhitespaceInDiffChanged={this.onHideWhitespaceInDiffChanged}
            onOpenSubmodule={this.props.onOpenSubmodule}
            getEditFromHistoryLine={
              allowInlineEdit && this.state.editBlockedMessage === null
                ? this.getEditFromHistoryLine
                : undefined
            }
            onEditFromHistoryLineChanged={
              allowInlineEdit && this.state.editBlockedMessage === null
                ? this.onEditFromHistoryLineChanged
                : undefined
            }
          />
        </div>
      </div>
    )
  }

  private renderDiffHeader() {
    const { selectedFile } = this.props
    if (selectedFile === null) {
      return null
    }

    const { path, status } = selectedFile
    const showApply = this.canEditFromHistory(selectedFile)

    return (
      <DiffHeader
        diff={this.props.currentDiff}
        path={path}
        status={status}
        showSideBySideDiff={this.props.showSideBySideDiff}
        onShowSideBySideDiffChanged={this.onShowSideBySideDiffChanged}
        hideWhitespaceInDiff={this.props.hideWhitespaceInDiff}
        onHideWhitespaceInDiffChanged={this.onHideWhitespaceInDiffChanged}
        onDiffOptionsOpened={this.props.onDiffOptionsOpened}
        onApplyEditFromHistory={
          showApply ? this.onApplyEditFromHistory : undefined
        }
        isApplyingEditFromHistory={this.state.isEditApplying}
        editFromHistoryDirtyCount={this.state.hasLineEdits ? 1 : 0}
      />
    )
  }

  private renderCommitSummary(commits: ReadonlyArray<Commit>) {
    return (
      <ExpandableCommitSummary
        selectedCommits={commits}
        shasInDiff={this.props.shasInDiff}
        changesetData={this.props.changesetData}
        emoji={this.props.emoji}
        repository={this.props.repository}
        onExpandChanged={this.onExpandChanged}
        isExpanded={this.state.isExpanded}
        onHighlightShas={this.onHighlightShas}
        showUnreachableCommits={this.showUnreachableCommits}
        accounts={this.props.accounts}
      />
    )
  }

  private showUnreachableCommits = (selectedTab: UnreachableCommitsTab) => {
    this.props.dispatcher.showUnreachableCommits(selectedTab)
  }

  private onHighlightShas = (shasToHighlight: ReadonlyArray<string>) => {
    this.props.dispatcher.updateShasToHighlight(
      this.props.repository,
      shasToHighlight
    )
  }

  private onExpandChanged = (isExpanded: boolean) => {
    this.setState({ isExpanded })
  }

  private onHideWhitespaceInDiffChanged = (hideWhitespaceInDiff: boolean) => {
    return this.props.dispatcher.onHideWhitespaceInHistoryDiffChanged(
      hideWhitespaceInDiff,
      this.props.repository,
      this.props.selectedFile as CommittedFileChange
    )
  }

  private onShowSideBySideDiffChanged = (showSideBySideDiff: boolean) => {
    this.props.dispatcher.onShowSideBySideDiffChanged(showSideBySideDiff)
  }

  private onCommitSummaryReset = () => {
    this.props.dispatcher.resetCommitSummaryWidth()
  }

  private onCommitSummaryResize = (width: number) => {
    this.props.dispatcher.setCommitSummaryWidth(width)
  }

  private renderFileList() {
    const files = this.props.changesetData.files
    if (files.length === 0) {
      return <div className="fill-window">No files in commit</div>
    }

    // -1 for right hand side border
    const availableWidth = clamp(this.props.commitSummaryWidth) - 1

    return (
      <>
        {this.renderFileHeader()}
        <FileList
          files={files}
          onSelectedFileChanged={this.onFileSelected}
          selectedFile={this.props.selectedFile}
          availableWidth={availableWidth}
          onContextMenu={this.onContextMenu}
          onRowDoubleClick={this.onRowDoubleClick}
        />
      </>
    )
  }

  private renderFileHeader() {
    const fileCount = this.props.changesetData.files.length
    const filesPlural = fileCount === 1 ? 'file' : 'files'
    return (
      <div className="file-list-header">
        {fileCount} changed {filesPlural}
      </div>
    )
  }

  /**
   * Open file with default application.
   *
   * @param path The path of the file relative to the root of the repository
   */
  private onOpenItem = (path: string) => {
    const fullPath = Path.join(this.props.repository.path, path)
    openFile(fullPath, this.props.dispatcher)
  }

  public render() {
    const { selectedCommits, isContiguous } = this.props

    if (selectedCommits.length > 1 && !isContiguous) {
      return this.renderMultipleCommitsBlankSlate()
    }

    if (selectedCommits.length === 0) {
      return <NoCommitSelected />
    }

    const className = this.state.isExpanded ? 'expanded' : 'collapsed'
    const { commitSummaryWidth } = this.props

    return (
      <div id="history" className={className}>
        {this.renderCommitSummary(selectedCommits)}
        <div className="commit-details">
          <Resizable
            width={commitSummaryWidth.value}
            minimumWidth={commitSummaryWidth.min}
            maximumWidth={commitSummaryWidth.max}
            onResize={this.onCommitSummaryResize}
            onReset={this.onCommitSummaryReset}
            description="Selected commit file list"
          >
            {this.renderFileList()}
          </Resizable>
          {this.renderDiff()}
        </div>
        {this.renderDragOverlay()}
      </div>
    )
  }

  private renderDragOverlay(): JSX.Element | null {
    if (!this.props.showDragOverlay) {
      return null
    }

    return <div id="drag-overlay-background"></div>
  }

  private renderMultipleCommitsBlankSlate(): JSX.Element {
    const BlankSlateImage = encodePathAsUrl(
      __dirname,
      'static/empty-no-commit.svg'
    )

    return (
      <div id="multiple-commits-selected" className="blankslate">
        <div className="panel blankslate">
          <img src={BlankSlateImage} className="blankslate-image" alt="" />
          <div>
            <p>
              Unable to display diff when multiple non-consecutive selected.
            </p>
            <div>You can:</div>
            <ul>
              <li>
                Select a single commit or a range of consecutive commits to view
                a diff.
              </li>
              <li>Drag the commits to the branch menu to cherry-pick them.</li>
              <li>Drag the commits to squash or reorder them.</li>
              <li>Right click on multiple commits to see options.</li>
            </ul>
          </div>
        </div>
        {this.renderDragOverlay()}
      </div>
    )
  }

  private onContextMenu = async (
    file: CommittedFileChange,
    event: React.MouseEvent<HTMLDivElement>
  ) => {
    event.preventDefault()

    const {
      selectedCommits,
      localCommitSHAs,
      repository,
      externalEditorLabel,
    } = this.props

    const fullPath = Path.join(repository.path, file.path)
    const fileExistsOnDisk = await pathExists(fullPath)
    if (!fileExistsOnDisk) {
      showContextualMenu([
        {
          label: __DARWIN__
            ? 'File Does Not Exist on Disk'
            : 'File does not exist on disk',
          enabled: false,
        },
      ])
      return
    }

    const extension = Path.extname(file.path)

    const isSafeExtension = isSafeFileExtension(extension)
    const openInExternalEditor = externalEditorLabel
      ? `Open in ${externalEditorLabel}`
      : DefaultEditorLabel

    const items: IMenuItem[] = [
      {
        label: RevealInFileManagerLabel,
        action: () => revealInFileManager(repository, file.path),
        enabled: fileExistsOnDisk,
      },
      {
        label: openInExternalEditor,
        action: () => this.props.onOpenInExternalEditor(file.path),
        enabled: fileExistsOnDisk,
      },
      {
        label: OpenWithDefaultProgramLabel,
        action: () => this.onOpenItem(file.path),
        enabled: isSafeExtension && fileExistsOnDisk,
      },
      { type: 'separator' },
      {
        label: CopyFilePathLabel,
        action: () => clipboard.writeText(fullPath),
      },
      {
        label: CopyRelativeFilePathLabel,
        action: () => clipboard.writeText(Path.normalize(file.path)),
      },
      { type: 'separator' },
    ]

    let viewOnGitHubLabel = 'View on GitHub'
    const gitHubRepository = repository.gitHubRepository

    if (
      gitHubRepository &&
      gitHubRepository.endpoint !== getDotComAPIEndpoint()
    ) {
      viewOnGitHubLabel = 'View on GitHub Enterprise'
    }

    items.push({
      label: viewOnGitHubLabel,
      action: () => this.onViewOnGitHub(selectedCommits[0].sha, file),
      enabled:
        selectedCommits.length === 1 &&
        !localCommitSHAs.includes(selectedCommits[0].sha) &&
        !!gitHubRepository &&
        this.props.selectedCommits.length > 0,
    })

    showContextualMenu(items)
  }

  private onViewOnGitHub = (sha: string, file: CommittedFileChange) => {
    this.props.onViewCommitOnGitHub(sha, file.path)
  }
}

function NoCommitSelected() {
  const BlankSlateImage = encodePathAsUrl(
    __dirname,
    'static/empty-no-commit.svg'
  )

  return (
    <div className="panel blankslate">
      <img src={BlankSlateImage} className="blankslate-image" alt="" />
      No commit selected
    </div>
  )
}

function getEditFileKey(file: CommittedFileChange | null): string | null {
  if (file === null) {
    return null
  }

  return `${file.commitish}:${file.path}`
}
