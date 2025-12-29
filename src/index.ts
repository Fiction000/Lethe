import { Notice, Platform, Plugin, TFile } from 'obsidian';
import { FocusOnEditor, Memos } from './memos';
// OpenDailyMemosWithMemos removed - was Phase 2 orphaned setting
import { MEMOS_VIEW_TYPE } from './constants';
import addIcons from './obComponents/customIcons';
import { DEFAULT_SETTINGS, MemosSettings, MemosSettingTab } from './setting';
import { QuickCaptureModal } from './obComponents/QuickCaptureModal';
import { t } from './translations/helper';
import { memoService } from './services';
import { dailyNotePreCreationService } from './services/dailyNotePreCreationService';

export default class MemosPlugin extends Plugin {
  public settings: MemosSettings;

  async onload(): Promise<void> {
    console.log('lethe loading...');
    await this.loadSettings();

    this.registerView(MEMOS_VIEW_TYPE, (leaf) => new Memos(leaf, this));

    this.app.workspace.onLayoutReady(this.onLayoutReady.bind(this));
    console.log(t('welcome'));
  }

  public async loadSettings() {
    const loadedData = await this.loadData();

    // Clean up removed settings from old versions (Phase 2 + Phase 3)
    if (loadedData) {
      // Phase 2 orphaned settings
      delete loadedData.OpenDailyMemosWithMemos;
      delete loadedData.ShareFooterStart;
      delete loadedData.ShareFooterEnd;
      delete loadedData.AutoSaveWhenOnMobile;
      delete loadedData.QueryFileName;
      delete loadedData.DefaultDarkBackgroundImage;
      delete loadedData.DefaultLightBackgroundImage;

      // Phase 3 settings to be removed
      delete loadedData.SaveMemoButtonLabel;
      delete loadedData.SaveMemoButtonIcon;
      delete loadedData.ShowTaskLabel;
      delete loadedData.ShowLeftSideBar;
      delete loadedData.UseButtonToShowEditor;
      delete loadedData.DefaultEditorLocation;
      delete loadedData.UseDailyOrPeriodic;
      delete loadedData.CommentOnMemos;
      delete loadedData.ShowCommentOnMemos;
      delete loadedData.CommentsInOriginalNotes;
      delete loadedData.OpenMemosAutomatically;
      delete loadedData.IndividualMemoFileNameLength;
      delete loadedData.ProcessEntriesBelow;
      delete loadedData.Language;
      delete loadedData.UseVaultTags;
      delete loadedData.InsertDateFormat;
      delete loadedData.DeleteFileName;
      delete loadedData.FetchMemosMark;
      delete loadedData.FetchMemosFromNote;
      delete loadedData.AddBlankLineWhenDate;
      delete loadedData.HideDoneTasks;
      delete loadedData.ShowTime;
      delete loadedData.ShowDate;
    }

    this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedData);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(MEMOS_VIEW_TYPE);
    new Notice(t('Close Lethe Successfully'));
  }

  registerMobileEvent() {
    this.registerEvent(
      this.app.workspace.on('receive-text-menu', (menu, source) => {
        menu.addItem((item: any) => {
          item
            .setIcon('popup-open')
            .setTitle(t('Insert as Memo'))
            .onClick(async () => {
              const newMemo = await memoService.createMemo(source, false);
              memoService.pushMemo(newMemo);
            });
        });
      }),
    );

    this.registerEvent(
      this.app.workspace.on('receive-files-menu', (menu, source) => {
        menu.addItem((item) => {
          item
            .setIcon('popup-open')
            .setTitle(t('Insert file as memo content'))
            .onClick(async () => {
              const fileName = source.map((file: TFile) => {
                return this.app.fileManager.generateMarkdownLink(file, file.path);
              });
              const newMemo = await memoService.createMemo(fileName.join('\n'), false);
              memoService.pushMemo(newMemo);
              // console.log(source, 'hello world');
            });
        });
      }),
    );
  }

  onRegisterProjectView(data: DataFrame, contentEl: HTMLElement) {
    contentEl.createEl('h1', { text: 'Debug' });

    const ul = contentEl.createEl('ul');

    for (const field of data.fields) {
      ul.createEl('li', {
        text: field.name,
      });
    }
  }

  async onLayoutReady(): Promise<void> {
    addIcons();
    this.addSettingTab(new MemosSettingTab(this.app, this));

    // Set plugin instance for daily note pre-creation service
    dailyNotePreCreationService.setPlugin(this);

    // Pre-create daily notes (non-blocking) if enabled in settings
    if (this.settings.PreCreateDailyNotes) {
      dailyNotePreCreationService.initialize().catch((err) => {
        console.error('[Lethe] Failed to initialize daily note pre-creation:', err);
      });
    }

    // Register midnight rollover check (every 60 seconds)
    this.registerInterval(
      window.setInterval(() => {
        dailyNotePreCreationService.checkAndRollover();
      }, 60 * 1000),
    );

    this.addCommand({
      id: 'open-memos',
      name: 'Open Lethe',
      callback: () => this.openMemos(),
      hotkeys: [],
    });

    this.addCommand({
      id: 'quick-capture',
      name: 'Quick Capture',
      callback: () => this.quickCapture(),
      hotkeys: [],
    });

    this.addCommand({
      id: 'focus-on-memos-editor',
      name: 'Focus On Lethe Editor',
      callback: () => this.focusOnEditor(),
      hotkeys: [],
    });

    this.addCommand({
      id: 'note-it',
      name: 'Note It',
      callback: () => this.noteIt(),
      hotkeys: [],
    });

    this.addCommand({
      id: 'focus-on-search-bar',
      name: 'Search It',
      callback: () => this.searchIt(),
      hotkeys: [],
    });

    this.addCommand({
      id: 'change-status',
      name: 'Change Status Between Task Or List',
      callback: () => this.changeStatus(),
      hotkeys: [],
    });

    this.addCommand({
      id: 'show-memos-in-popover',
      name: 'Show Lethe in Popover',
      callback: () => this.showInPopover(),
      hotkeys: [],
    });

    this.addCommand({
      id: 'toggle-sidebar-display',
      name: 'Toggle Sidebar Display',
      callback: () => this.toggleSidebarDisplay(),
      hotkeys: [],
    });

    if (Platform.isMobile) {
      this.registerMobileEvent();
    }

    this.addRibbonIcon('Memos', t('ribbonIconTitle'), () => {
      this.openMemos();
    });

    const leaves = this.app.workspace.getLeavesOfType(MEMOS_VIEW_TYPE);
    if (!(leaves.length > 0)) {
      return;
    }
    if (this.settings.FocusOnEditor) {
      const leaf = leaves[0];
      leaf.view.containerEl.querySelector('textarea').focus();
      return;
    }
    if (!this.settings.OpenMemosAutomatically) {
      return;
    }
    this.openMemos();
  }

  async openMemos() {
    const workspace = this.app.workspace;
    workspace.detachLeavesOfType(MEMOS_VIEW_TYPE);

    let leaf;
    if (this.settings.ShowInSidebar) {
      // Open in sidebar
      const sidebarLeaf =
        this.settings.SidebarLocation === 'left'
          ? workspace.getLeftLeaf(false)
          : workspace.getRightLeaf(false);
      leaf = sidebarLeaf ?? workspace.getLeaf(false);
    } else {
      // Open in tab (default behavior)
      leaf = workspace.getLeaf(false);
    }

    await leaf.setViewState({ type: MEMOS_VIEW_TYPE });
    workspace.revealLeaf(leaf);

    if (!FocusOnEditor) {
      return;
    }

    if (leaf.view.containerEl.querySelector('textarea') !== undefined) {
      leaf.view.containerEl.querySelector('textarea').focus();
    }
  }

  searchIt() {
    const workspace = this.app.workspace;
    const leaves = workspace.getLeavesOfType(MEMOS_VIEW_TYPE);
    if (!(leaves.length > 0)) {
      this.openMemos();
      return;
      // this.openMemos();
    }

    const leaf = leaves[0];
    workspace.setActiveLeaf(leaf);
    (leaf.view.containerEl.querySelector('.search-bar-inputer .text-input') as HTMLElement).focus();
  }

  focusOnEditor() {
    const workspace = this.app.workspace;
    const leaves = workspace.getLeavesOfType(MEMOS_VIEW_TYPE);
    if (!(leaves.length > 0)) {
      this.openMemos();
      return;
      // this.openMemos();
    }

    const leaf = leaves[0];
    workspace.setActiveLeaf(leaf);
    leaf.view.containerEl.querySelector('textarea').focus();
  }

  noteIt() {
    const workspace = this.app.workspace;
    const leaves = workspace.getLeavesOfType(MEMOS_VIEW_TYPE);
    if (!(leaves.length > 0)) {
      new Notice(t('Please Open Lethe First'));
      return;
      // this.openMemos();
    }

    const leaf = leaves[0];
    workspace.setActiveLeaf(leaf);
    leaf.view.containerEl.querySelector('.memo-editor .confirm-btn').click();
  }

  changeStatus() {
    const workspace = this.app.workspace;
    const leaves = workspace.getLeavesOfType(MEMOS_VIEW_TYPE);
    if (!(leaves.length > 0)) {
      new Notice(t('Please Open Lethe First'));
      return;
      // this.openMemos();
    }

    const leaf = leaves[0];
    workspace.setActiveLeaf(leaf);
    leaf.view.containerEl.querySelector('.list-or-task').click();
  }

  async showInPopover() {
    const workspace = this.app.workspace;
    workspace.detachLeavesOfType(MEMOS_VIEW_TYPE);
    const leaf = await window.app.plugins.getPlugin('obsidian-hover-editor')?.spawnPopover();

    await leaf.setViewState({ type: MEMOS_VIEW_TYPE });
    workspace.revealLeaf(leaf);
    leaf.view.containerEl.classList.add('mobile-view');
    if (!FocusOnEditor) {
      return;
    }

    if (leaf.view.containerEl.querySelector('textarea') !== undefined) {
      leaf.view.containerEl.querySelector('textarea').focus();
    }
  }

  async toggleSidebarDisplay() {
    // Toggle the setting
    this.settings.ShowInSidebar = !this.settings.ShowInSidebar;
    await this.saveSettings();

    // Trigger settings update event
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (<any>this.app.workspace).trigger('lethe:settings-updated');

    // Reopen Lethe with new setting
    const workspace = this.app.workspace;
    const leaves = workspace.getLeavesOfType(MEMOS_VIEW_TYPE);

    if (leaves.length > 0) {
      // Close current instance and reopen with new setting
      workspace.detachLeavesOfType(MEMOS_VIEW_TYPE);
      await this.openMemos();

      new Notice(
        this.settings.ShowInSidebar
          ? 'Lethe will now open in sidebar'
          : 'Lethe will now open in tab'
      );
    } else {
      // Just save the setting
      new Notice(
        this.settings.ShowInSidebar
          ? 'Lethe will open in sidebar next time'
          : 'Lethe will open in tab next time'
      );
    }
  }

  quickCapture() {
    new QuickCaptureModal(this.app).open();
  }
}
