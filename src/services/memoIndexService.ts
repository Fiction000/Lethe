import type MemosPlugin from '../index';

const DEBOUNCE_MS = 500;

class MemoIndexService {
  private plugin: MemosPlugin | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  setPlugin(plugin: MemosPlugin) {
    this.plugin = plugin;
  }

  getIndex(): Model.MemoIndex {
    return this.plugin?.memoIndex ?? { version: 1, entries: {} };
  }

  getAllEntries(): Model.MemoIndexEntry[] {
    return Object.values(this.getIndex().entries);
  }

  addEntry(memo: Model.Memo) {
    if (!this.plugin) return;
    this.plugin.memoIndex.entries[memo.id] = {
      id: memo.id,
      createdAt: memo.createdAt,
      updatedAt: memo.updatedAt,
      memoType: memo.memoType ?? 'JOURNAL',
      tags: memo.tags ?? [],
      contentPreview: memo.content.slice(0, 100),
      path: memo.path ?? '',
    };
    this.debouncedSave();
  }

  updateEntry(id: string, partial: Partial<Model.MemoIndexEntry>) {
    if (!this.plugin) return;
    const existing = this.plugin.memoIndex.entries[id];
    if (!existing) return;
    Object.assign(existing, partial);
    this.debouncedSave();
  }

  removeEntry(id: string) {
    if (!this.plugin) return;
    delete this.plugin.memoIndex.entries[id];
    this.debouncedSave();
  }

  rebuildFromMemos(memos: Model.Memo[]) {
    if (!this.plugin) return;
    const entries: Record<string, Model.MemoIndexEntry> = {};
    for (const m of memos) {
      entries[m.id] = {
        id: m.id,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
        memoType: m.memoType ?? 'JOURNAL',
        tags: m.tags ?? [],
        contentPreview: m.content,
        path: m.path ?? '',
      };
    }
    this.plugin.memoIndex = { version: 1, entries };
    this.debouncedSave();
  }

  /**
   * Sync disk memos into the index — adds missing entries and updates existing ones.
   * Entries for deleted files are intentionally kept as archived history.
   */
  syncFromMemos(memos: Model.Memo[]) {
    if (!this.plugin) return;
    let changed = false;
    for (const m of memos) {
      const existing = this.plugin.memoIndex.entries[m.id];
      if (!existing) {
        this.plugin.memoIndex.entries[m.id] = {
          id: m.id,
          createdAt: m.createdAt,
          updatedAt: m.updatedAt,
          memoType: m.memoType ?? 'JOURNAL',
          tags: m.tags ?? [],
          contentPreview: m.content,
          path: m.path ?? '',
        };
        changed = true;
      } else if (existing.updatedAt !== m.updatedAt) {
        // Refresh preview and metadata for modified memos
        existing.updatedAt = m.updatedAt;
        existing.contentPreview = m.content.slice(0, 100);
        existing.tags = m.tags ?? [];
        existing.memoType = m.memoType ?? 'JOURNAL';
        existing.path = m.path ?? '';
        changed = true;
      }
    }
    if (changed) this.debouncedSave();
  }

  getTagsFromIndex(): { tags: string[]; tagsNum: Record<string, number> } {
    const counts: Record<string, number> = {};
    for (const entry of this.getAllEntries()) {
      for (const tag of entry.tags) {
        counts[tag] = (counts[tag] || 0) + 1;
      }
    }
    return { tags: Object.keys(counts), tagsNum: counts };
  }

  private debouncedSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, DEBOUNCE_MS);
  }

  private async save() {
    const plugin = this.plugin;
    if (!plugin) return;
    // MemosPlugin.saveSettings serializes this index with settings and captures
    // through the shared repository instead of writing a stale envelope.
    await plugin.saveSettings();
  }

  async flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.save();
  }
}

const memoIndexService = new MemoIndexService();
export default memoIndexService;
