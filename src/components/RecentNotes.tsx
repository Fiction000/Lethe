import React, { useContext, useEffect, useState } from 'react';
import appContext from '../stores/appContext';
import { TFile } from 'obsidian';
import '../less/recent-notes.less';

const MAX_RECENT = 20;

function getRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  if (diffDay < 30) return `${Math.floor(diffDay / 7)}w ago`;
  return `${Math.floor(diffDay / 30)}mo ago`;
}

interface RecentFile {
  path: string;
  name: string;
  ctime: number;
}

const RecentNotes: React.FC = () => {
  const { dailyNotesState } = useContext(appContext);
  const app = dailyNotesState?.app;
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>([]);

  useEffect(() => {
    if (!app?.vault) return;

    const loadRecent = () => {
      const files = app.vault.getMarkdownFiles()
        .sort((a: TFile, b: TFile) => b.stat.ctime - a.stat.ctime)
        .slice(0, MAX_RECENT)
        .map((f: TFile) => ({
          path: f.path,
          name: f.basename,
          ctime: f.stat.ctime,
        }));
      setRecentFiles(files);
    };

    loadRecent();

    // Refresh when files change
    const ref = app.vault.on('create', loadRecent);
    const ref2 = app.vault.on('rename', loadRecent);
    const ref3 = app.vault.on('delete', loadRecent);

    return () => {
      app.vault.offref(ref);
      app.vault.offref(ref2);
      app.vault.offref(ref3);
    };
  }, [app]);

  if (recentFiles.length === 0) return null;

  const handleClick = (path: string) => {
    if (!app) return;
    const file = app.vault.getAbstractFileByPath(path);
    if (file && file instanceof TFile) {
      app.workspace.getLeaf(false).openFile(file);
    }
  };

  return (
    <div className="recent-notes-container">
      <div className="recent-notes-label">RECENT</div>
      <div className="recent-notes-list">
        {recentFiles.map((f) => (
          <div
            key={f.path}
            className="recent-note-item"
            onClick={() => handleClick(f.path)}
          >
            <span className="recent-note-preview">{f.name}</span>
            <span className="recent-note-time">{getRelativeTime(f.ctime)}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

export default RecentNotes;
