import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import appContext from '../stores/appContext';
import { locationService, memoIndexService, memoService } from '../services';
import { TAG_REG, NOP_FIRST_TAG_REG, FIRST_TAG_REG } from '../helpers/consts';
import utils from '../helpers/utils';
import { formatMemoContent } from '../components/Memo';
import { sanitizeTimelineHtml } from '../helpers/timelineHtml';
import MemoImage from '../components/MemoImage';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { showMemoInDailyNotes } from '../obComponents/obShowMemo';
import { globalStateService } from '../services';
import dailyNotesService from '../services/dailyNotesService';
import appStore from '../stores/appStore';
import { Notice, Platform } from 'obsidian';
import showMemoCardDialog from '../components/MemoCardDialog';
import More from '../icons/more.svg?react';
import '../less/timeline.less';

interface DateGroup {
  date: string;
  memos: Model.Memo[];
}

const PAGE_SIZE = 10;

function Timeline() {
  const {
    memoState: { memos },
  } = useContext(appContext);

  const [isFetching, setFetchStatus] = useState(true);
  const [displayCount, setDisplayCount] = useState(PAGE_SIZE);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    memoService
      .fetchAllMemos()
      .then(() => {
        setFetchStatus(false);
      })
      .catch((err) => {
        console.error('[Lethe] Failed to fetch memos:', err);
        new Notice('Failed to fetch memos');
      });

    dailyNotesService.getMyAllDailyNotes().catch(() => {});
  }, []);

  const effectiveMemos = useMemo(() => {
    // Merge disk memos with archived index entries (memos whose files were deleted)
    const diskIds = new Set(memos.map((m) => m.id));
    const archivedFromIndex = memoIndexService
      .getAllEntries()
      .filter((entry) => !diskIds.has(entry.id))
      .map((entry) => ({
        id: entry.id,
        content: entry.contentPreview,
        deletedAt: '',
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        memoType: entry.memoType,
        path: entry.path,
        tags: entry.tags,
        _fromIndex: true,
      }));
    return [...memos, ...archivedFromIndex];
  }, [memos]);

  const sortedMemos = useMemo(() => {
    return effectiveMemos
      .filter((memo) => !memo.content.includes('comment:'))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [effectiveMemos]);

  const hasMore = displayCount < sortedMemos.length;

  const paginatedMemos = useMemo(() => {
    return sortedMemos.slice(0, displayCount);
  }, [sortedMemos, displayCount]);

  const dateGroups = useMemo(() => {
    const groups: Map<string, Model.Memo[]> = new Map();
    for (const memo of paginatedMemos) {
      const dateKey = memo.createdAt.split(' ')[0]; // "YYYY/MM/DD"
      if (!groups.has(dateKey)) {
        groups.set(dateKey, []);
      }
      groups.get(dateKey)!.push(memo);
    }
    return Array.from(groups.entries()).map(([date, memos]) => ({
      date,
      memos,
    }));
  }, [paginatedMemos]);

  const handleBackClick = useCallback(() => {
    locationService.pushHistory('/');
  }, []);

  const handleMemoClick = useCallback((event: React.MouseEvent) => {
    const app = appStore.getState().dailyNotesState?.app;
    if (!app) return;
    const { workspace } = app;

    const targetEl = event.target as HTMLElement;
    if (targetEl.tagName === 'SPAN' && targetEl.className === 'tag-span') {
      // Tag clicks don't navigate in timeline - just visual
    } else if (targetEl.tagName === 'A' && targetEl.className === 'internal-link') {
      const sourcePath = targetEl.getAttribute('data-filepath');
      if (Platform.isMobile) {
        workspace.openLinkText(sourcePath, sourcePath, false);
      } else {
        workspace.openLinkText(sourcePath, sourcePath, true);
      }
    }
  }, []);

  const handleSourceClick = useCallback((memo: Model.Memo) => {
    showMemoInDailyNotes(memo.id, memo.path);
  }, []);

  return (
    <div className="timeline-page">
      <div className="timeline-header">
        <button className="timeline-back-btn" onClick={handleBackClick}>
          ← Back
        </button>
        <h2 className="timeline-title">Timeline</h2>
        <span className="timeline-count">
          {displayCount < sortedMemos.length
            ? `${paginatedMemos.length} / ${sortedMemos.length} notes`
            : `${sortedMemos.length} notes`}
        </span>
      </div>

      <div className="timeline-content" ref={wrapperRef} onClick={handleMemoClick}>
        {isFetching ? (
          <div className="timeline-loading">
            <LoadingSpinner />
          </div>
        ) : dateGroups.length === 0 ? (
          <div className="timeline-empty">
            <p>No notes yet</p>
          </div>
        ) : (
          <>
            {dateGroups.map((group) => (
              <div key={group.date} className="timeline-date-group">
                <div className="timeline-date-header">
                  <span className="timeline-date">{group.date}</span>
                  <span className="timeline-date-count">{group.memos.length}</span>
                </div>
                <div className="timeline-entries">
                  {group.memos.map((memo) => (
                    <TimelineEntry key={`${memo.id}-${memo.updatedAt}`} memo={memo} onSourceClick={handleSourceClick} />
                  ))}
                </div>
              </div>
            ))}
            {hasMore && (
              <button
                className="timeline-load-more"
                onClick={(e) => {
                  e.stopPropagation();
                  setDisplayCount((c) => c + PAGE_SIZE);
                }}
              >
                Load more ({sortedMemos.length - displayCount} remaining)
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

interface TimelineEntryProps {
  memo: Model.Memo;
  onSourceClick: (memo: Model.Memo) => void;
}

const TimelineEntry: React.FC<TimelineEntryProps> = React.memo(({ memo, onSourceClick }) => {
  const timeStr = memo.createdAt.split(' ')[1] || ''; // "HH:mm:ss"
  const isArchived = (memo as any)._fromIndex === true;

  const handleReadClick = () => {
    showMemoCardDialog(memo);
  };

  const handleSourceBtnClick = () => {
    onSourceClick(memo);
  };

  return (
    <div className={`timeline-entry${isArchived ? ' timeline-entry-archived' : ''}`}>
      <div className="timeline-entry-time">
        <span className="time-text">{timeStr}</span>
        {memo.tags && memo.tags.length > 0 && (
          <div className="timeline-entry-tags">
            {memo.tags.map((tag) => (
              <span key={tag} className="memo-tag">
                #{tag}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="timeline-entry-body">
        <div
          className="timeline-entry-content memo-content-text"
          dangerouslySetInnerHTML={{
            __html: sanitizeTimelineHtml(formatMemoContent(memo.content, memo.id)),
          }}
        />
        <MemoImage memo={memo.content} />
        <div className="timeline-entry-actions">
          <button className="timeline-action-btn" onClick={handleReadClick}>
            READ
          </button>
          <button className="timeline-action-btn" onClick={handleSourceBtnClick}>
            SOURCE
          </button>
        </div>
      </div>
    </div>
  );
});

export default Timeline;
