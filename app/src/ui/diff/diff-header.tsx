import * as React from 'react'
import { PathLabel } from '../lib/path-label'
import { AppFileStatus } from '../../models/status'
import { IDiff, DiffType } from '../../models/diff'
import { Octicon, iconForStatus } from '../octicons'
import { mapStatus } from '../../lib/status'
import { DiffOptions } from './diff-options'
import { Button } from '../lib/button'

interface IDiffHeaderProps {
  readonly path: string
  readonly status: AppFileStatus
  readonly diff: IDiff | null

  /** Whether we should display side by side diffs. */
  readonly showSideBySideDiff: boolean

  /** Called when the user changes the side by side diffs setting. */
  readonly onShowSideBySideDiffChanged: (checked: boolean) => void

  /** Whether we should hide whitespace in diffs. */
  readonly hideWhitespaceInDiff: boolean

  /** Called when the user changes the hide whitespace in diffs setting. */
  readonly onHideWhitespaceInDiffChanged: (checked: boolean) => Promise<void>

  /** Called when the user opens the diff options popover */
  readonly onDiffOptionsOpened: () => void

  /**
   * When provided, shows Apply for Edit From History after the user has
   * edited green lines inline.
   */
  readonly onApplyEditFromHistory?: () => void

  /** Whether Apply is currently running. */
  readonly isApplyingEditFromHistory?: boolean

  /** Number of edited green lines awaiting apply. */
  readonly editFromHistoryDirtyCount?: number
}

/** Displays information about a file */
export class DiffHeader extends React.Component<IDiffHeaderProps, {}> {
  public render() {
    const status = this.props.status
    const fileStatus = mapStatus(status)

    return (
      <div className="header">
        <PathLabel path={this.props.path} status={this.props.status} />

        {this.renderEditFromHistoryActions()}
        {this.renderDiffOptions()}

        <Octicon
          symbol={iconForStatus(status)}
          className={'status status-' + fileStatus.toLowerCase()}
          title={fileStatus}
        />
      </div>
    )
  }

  private renderEditFromHistoryActions() {
    const {
      onApplyEditFromHistory,
      isApplyingEditFromHistory,
      editFromHistoryDirtyCount,
    } = this.props

    if (onApplyEditFromHistory === undefined) {
      return null
    }

    const dirty = (editFromHistoryDirtyCount ?? 0) > 0

    return (
      <div className="diff-header-edit-actions">
        {dirty ? (
          <Button
            onClick={onApplyEditFromHistory}
            disabled={isApplyingEditFromHistory}
            size="small"
          >
            {isApplyingEditFromHistory ? 'Applying…' : 'Apply Changes'}
          </Button>
        ) : (
          <span className="edit-from-history-hint">
            Edit green lines, then Apply
          </span>
        )}
      </div>
    )
  }

  private renderDiffOptions() {
    if (this.props.diff?.kind === DiffType.Submodule) {
      return null
    }

    return (
      <DiffOptions
        isInteractiveDiff={true}
        onHideWhitespaceChangesChanged={
          this.props.onHideWhitespaceInDiffChanged
        }
        hideWhitespaceChanges={this.props.hideWhitespaceInDiff}
        onShowSideBySideDiffChanged={this.props.onShowSideBySideDiffChanged}
        showSideBySideDiff={this.props.showSideBySideDiff}
        onDiffOptionsOpened={this.props.onDiffOptionsOpened}
      />
    )
  }
}
