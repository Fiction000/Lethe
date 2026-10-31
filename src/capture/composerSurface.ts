import type { CaptureProfile, NoteWriteState } from './core';
import type { OrganizationJobStatus } from '../organization/types';
import {
  isOrganizationPendingStatus,
  isOrganizationRetryableStatus,
  isOrganizationUndoableStatus,
} from './composerActions';

export type ComposerSurface = 'main' | 'quick';
export type ComposerSection = 'editor' | 'action' | 'details' | 'recent';
export type RecentRowAction = 'retry' | 'skip' | 'undo';

const SHELL_PATHS = new Set(['/recycle', '/setting', '/timeline']);

/** Writing first, then the action, then quiet metadata. Quick Capture has no stream. */
export function composerSectionOrder(surface: ComposerSurface): readonly ComposerSection[] {
  const order: ComposerSection[] = ['editor', 'action', 'details'];
  return surface === 'quick' ? order : [...order, 'recent'];
}

/** The username column, header, and legacy list stay for daily notes, edits, and other routes. */
export function shouldShowMemosShell(pathname: string, legacyEditor: boolean): boolean {
  if (SHELL_PATHS.has(pathname)) return true;
  return legacyEditor;
}

export function shouldOfferKeepProfile(profile: CaptureProfile | undefined): boolean {
  return profile === 'book' || profile === 'movie';
}

/**
 * A settled capture does not announce its write or organization state.
 * Retry, skip, and undo appear only when the person can still act.
 */
export function recentRowAction(
  writeState: NoteWriteState,
  organizationStatus: OrganizationJobStatus | undefined,
): RecentRowAction | undefined {
  if (writeState === 'conflict') return undefined;
  if (writeState === 'failed' || writeState === 'pending') return 'retry';
  if (organizationStatus !== undefined && isOrganizationRetryableStatus(organizationStatus)) return 'retry';
  if (organizationStatus !== undefined && isOrganizationPendingStatus(organizationStatus)) return 'skip';
  if (organizationStatus !== undefined && isOrganizationUndoableStatus(organizationStatus)) return 'undo';
  return undefined;
}

export function noteWriteLabel(state: NoteWriteState): string {
  switch (state) {
    case 'written':
      return 'Saved';
    case 'pending':
      return 'Queued';
    case 'failed':
      return 'Write failed';
    case 'conflict':
      return 'Write conflict';
    case 'deleted':
      return 'Note deleted';
    case 'not-started':
      return 'Waiting to write';
  }
}

export function formatCaptureAge(createdAt: string, now: Date): string {
  const then = Date.parse(createdAt);
  if (Number.isNaN(then)) return '';
  const minutes = Math.max(0, Math.floor((now.getTime() - then) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function composerPlaceholder(isMacOS: boolean): string {
  return isMacOS ? 'Write. Cmd+Enter sends.' : 'Write. Ctrl+Enter sends.';
}
