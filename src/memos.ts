import { debounce, HoverPopover, ItemView, Platform, TFile, WorkspaceLeaf } from 'obsidian';
import { MEMOS_VIEW_TYPE } from './constants';
import React from 'react';
import ReactDOM from 'react-dom';
import App from './App';
import type MemosPlugin from './index';
import { dailyNotesService, globalStateService, memoService } from './services';
import { getDateFromFile } from 'obsidian-daily-notes-interface';

export class Memos extends ItemView {
  plugin: MemosPlugin;
  hoverPopover: HoverPopover | null;
  private memosComponent: React.ReactElement;

  constructor(leaf: WorkspaceLeaf, plugin: MemosPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getDisplayText(): string {
    // TODO: Make this interactive: Either the active workspace or the local graph
    return 'Lethe';
  }

  getIcon(): string {
    return 'Memos';
  }

  getViewType(): string {
    return MEMOS_VIEW_TYPE;
  }

  private onMemosSettingsUpdate(): void {
    // Update all exported settings (Phase 3: reduced to 10 essential settings)
    MemoStorageMode = this.plugin.settings.MemoStorageMode;
    InsertAfter = this.plugin.settings.InsertAfter;
    IndividualMemoFolder = this.plugin.settings.IndividualMemoFolder;
    DefaultPrefix = this.plugin.settings.DefaultPrefix;
    DefaultMemoComposition = this.plugin.settings.DefaultMemoComposition;
    UserName = this.plugin.settings.UserName;
    ShowInSidebar = this.plugin.settings.ShowInSidebar;
    SidebarLocation = this.plugin.settings.SidebarLocation;
    FocusOnEditor = this.plugin.settings.FocusOnEditor;

    memoService.clearMemos();
    memoService.fetchAllMemos(true); // Force refetch on settings change
  }

  private async onFileDeleted(file: TFile): Promise<void> {
    if (getDateFromFile(file, 'day')) {
      await dailyNotesService.getMyAllDailyNotes();
      memoService.clearMemos();
      memoService.fetchAllMemos(true); // Force refetch on file delete
    }
  }

  private async onFileModified(file: TFile): Promise<void> {
    const date = getDateFromFile(file, 'day');
    if (globalStateService.getState().changedByMemos) {
      globalStateService.setChangedByMemos(false);
      return;
    }
    if (date && this.memosComponent) {
      memoService.fetchAllMemos(true); // Force refetch on file modify
    }
  }

  private onFileCreated(file: TFile): void {
    if (this.app.workspace.layoutReady && this.memosComponent) {
      if (getDateFromFile(file, 'day')) {
        dailyNotesService.getMyAllDailyNotes();
        memoService.fetchAllMemos(true); // Force refetch on file create
      }
    }
  }

  async handleResize() {
    const leaves = this.app.workspace.getLeavesOfType(MEMOS_VIEW_TYPE);
    if (leaves.length > 0) {
      const leaf = leaves[0];
      if (leaf.width > 875) {
        // hide the sidebar

        globalStateService.setIsMobileView(false);
        leaf.view.containerEl.classList.remove('mobile-view');
        globalStateService.setIsMobileView(leaf.width <= 875);
        return;
      }

      // ShowLeftSideBar removed in Phase 3 - simplified mobile view logic

      globalStateService.setIsMobileView(true);
      leaf.view.containerEl.classList.add('mobile-view');
      globalStateService.setIsMobileView(leaf.width <= 875);
    }
  }

  async onOpen(): Promise<void> {
    this.onMemosSettingsUpdate = this.onMemosSettingsUpdate.bind(this);
    this.onFileCreated = this.onFileCreated.bind(this);
    this.onFileDeleted = this.onFileDeleted.bind(this);
    this.onFileModified = this.onFileModified.bind(this);

    this.registerEvent(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (<any>this.app.workspace).on('lethe:settings-updated', this.onMemosSettingsUpdate),
    );

    this.registerEvent(this.app.vault.on('create', this.onFileCreated));
    this.registerEvent(this.app.vault.on('delete', this.onFileDeleted));
    this.registerEvent(this.app.vault.on('modify', debounce(this.onFileModified, 2000, true)));
    this.registerEvent(
      this.app.workspace.on('resize', () => {
        this.handleResize();
      }),
    );
    // Dataview event listeners removed (Phase 4)

    dailyNotesService.getApp(this.app);

    // Initialize exported settings (Phase 3: reduced to 9 essential settings)
    MemoStorageMode = this.plugin.settings.MemoStorageMode;
    InsertAfter = this.plugin.settings.InsertAfter;
    IndividualMemoFolder = this.plugin.settings.IndividualMemoFolder;
    DefaultPrefix = this.plugin.settings.DefaultPrefix;
    DefaultMemoComposition = this.plugin.settings.DefaultMemoComposition;
    UserName = this.plugin.settings.UserName;
    ShowInSidebar = this.plugin.settings.ShowInSidebar;
    SidebarLocation = this.plugin.settings.SidebarLocation;
    FocusOnEditor = this.plugin.settings.FocusOnEditor;

    this.memosComponent = React.createElement(App);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ReactDOM.render(this.memosComponent, (this as any).contentEl);

    // Fetch memos after rendering to populate the list
    memoService.fetchAllMemos().catch((err) => {
      console.error('[Lethe] Failed to fetch memos during initialization:', err);
    });
  }

  async onClose() {
    // Nothing to clean up.
  }
}

// Phase 3: Reduced to 9 essential setting exports
export let MemoStorageMode: 'daily-notes' | 'individual-files';
export let InsertAfter: string;
export let IndividualMemoFolder: string;
export let DefaultPrefix: string;
export let DefaultMemoComposition: string;
export let UserName: string;
export let ShowInSidebar: boolean;
export let SidebarLocation: 'left' | 'right';
export let FocusOnEditor: boolean;

// Initialize settings from plugin settings
// Called early in plugin lifecycle so Quick Capture and other features can access settings
export function initializeSettings(settings: any) {
  MemoStorageMode = settings.MemoStorageMode;
  InsertAfter = settings.InsertAfter;
  IndividualMemoFolder = settings.IndividualMemoFolder;
  DefaultPrefix = settings.DefaultPrefix;
  DefaultMemoComposition = settings.DefaultMemoComposition;
  UserName = settings.UserName;
  ShowInSidebar = settings.ShowInSidebar;
  SidebarLocation = settings.SidebarLocation;
  FocusOnEditor = settings.FocusOnEditor;
}
