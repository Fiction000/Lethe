import { Notice, Platform, Plugin, TFile, parseYaml, requestUrl, stringifyYaml } from 'obsidian';
import * as ObsidianApi from 'obsidian';
import { FocusOnEditor, Memos, initializeSettings } from './memos';
// OpenDailyMemosWithMemos removed - was Phase 2 orphaned setting
import { MEMOS_VIEW_TYPE } from './constants';
import addIcons from './obComponents/customIcons';
import { DEFAULT_SETTINGS, MemosSettings, MemosSettingTab } from './setting';
import { QuickCaptureModal } from './obComponents/QuickCaptureModal';
import { dailyNotesService, memoIndexService, memoService } from './services';
import { dailyNotePreCreationService } from './services/dailyNotePreCreationService';
import { ObsidianVaultAdapter } from './capture/obsidianAdapter';
import { CaptureRuntime } from './capture/runtime';
import { SerializedDataRepository, type LetheDataRepository } from './capture/repository';
import { setCaptureRuntime } from './capture/runtimeRegistry';
import {
  JEV_DEFAULT_MANAGED_FOLDERS,
  applyLocalOnlyFallback,
  hasNativeSecretStorage,
  serializeJevSettings,
  type JevSettings,
} from './jevSettings';
import {
  createObsidianFrontmatterPort,
  createObsidianJevTransport,
  ObsidianOrganizationVaultAdapter,
} from './organization/obsidianAdapter';
import { createObsidianSecretReader, OrganizationRuntimeBridge } from './organization/runtimeBridge';

export default class MemosPlugin extends Plugin {
  public settings: MemosSettings;
  public memoIndex: Model.MemoIndex = { version: 1, entries: {} };
  public dataRepository: LetheDataRepository;
  public captureRuntime?: CaptureRuntime;

  async onload(): Promise<void> {
    console.log('lethe loading...');
    this.dataRepository = new SerializedDataRepository({
      loadData: () => this.loadData(),
      saveData: (data) => this.saveData(data),
    });
    await this.loadSettings();

    const vaultAdapter = new ObsidianVaultAdapter(this.app);
    const organizationVault = new ObsidianOrganizationVaultAdapter(this.app);
    const organization = new OrganizationRuntimeBridge({
      repository: this.dataRepository,
      vault: organizationVault,
      frontmatter: createObsidianFrontmatterPort({ parseYaml, stringifyYaml }),
      settings: this.settings.Jev,
      readApiKey: createObsidianSecretReader(this.app, hasNativeSecretComponent()),
      transport: createObsidianJevTransport(requestUrl),
      remoteProcessingAvailable: () => hasNativeJevSecretCapabilities(this.app),
      inboxFolder: JEV_DEFAULT_MANAGED_FOLDERS.inbox,
      notesFolder: JEV_DEFAULT_MANAGED_FOLDERS.notes,
    });
    this.captureRuntime = new CaptureRuntime({
      repository: this.dataRepository,
      vault: vaultAdapter,
      organization,
      defaultTags: this.settings.DefaultTag === '' ? [] : [this.settings.DefaultTag],
      openNote: (note) => vaultAdapter.openNote(note),
    });
    setCaptureRuntime(this.captureRuntime);
    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        void this.captureRuntime?.handleVaultDelete(file.path);
      }),
    );
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        void this.captureRuntime?.handleVaultRename(oldPath, file.path);
      }),
    );

    this.registerView(MEMOS_VIEW_TYPE, (leaf) => new Memos(leaf, this));

    this.app.workspace.onLayoutReady(this.onLayoutReady.bind(this));
    console.log('Welcome to Lethe');
  }

  public async loadSettings() {
    if (!this.dataRepository) {
      this.dataRepository = new SerializedDataRepository({
        loadData: () => this.loadData(),
        saveData: (data) => this.saveData(data),
      });
    }
    const envelope = await this.dataRepository.read();
    const loadedData = isRecord(envelope) ? { ...envelope } : {};

    // Clean up removed settings from old versions (Phase 2 + Phase 3)
    // Extract memo index before cleaning. Reserved runtime namespaces never become settings.
    if (isMemoIndex(loadedData._memoIndex)) {
      this.memoIndex = loadedData._memoIndex;
    }
    delete loadedData._memoIndex;
    delete loadedData._captureStore;
    delete loadedData._captureSessions;
    delete loadedData._organizationStore;
    delete loadedData._organizationEnrollment;

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

    this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedData);
    this.settings.Jev = runtimeJevSettings(this.app, loadedData.Jev);
    await this.captureRuntime?.updateOrganizationSettings(this.settings.Jev);
  }

  async saveSettings(): Promise<void> {
    if (!this.dataRepository) {
      this.dataRepository = new SerializedDataRepository({
        loadData: () => this.loadData(),
        saveData: (data) => this.saveData(data),
      });
    }
    this.settings.Jev = runtimeJevSettings(this.app, this.settings.Jev);
    // Quiesce organization first. This closes the settings-update race where
    // an in-flight request could finish while the new settings are serialized.
    await this.captureRuntime?.updateOrganizationSettings(this.settings.Jev);
    await this.dataRepository.transact((current) => {
      const root = isRecord(current) ? { ...current } : {};
      const settings = { ...(this.settings as unknown as Record<string, unknown>) };
      settings.Jev = serializeJevSettings(this.settings.Jev);
      delete settings._captureStore;
      delete settings._captureSessions;
      delete settings._organizationStore;
      delete settings._organizationEnrollment;
      delete settings._memoIndex;
      return {
        next: { ...root, ...settings, _memoIndex: this.memoIndex },
        result: undefined,
      };
    });
    this.captureRuntime?.setDefaultTags(this.settings.DefaultTag === '' ? [] : [this.settings.DefaultTag]);
  }

  async onunload(): Promise<void> {
    const runtime = this.captureRuntime;
    setCaptureRuntime(undefined);
    await runtime?.dispose().catch(() => undefined);
    memoIndexService.flush();
    this.app.workspace.detachLeavesOfType(MEMOS_VIEW_TYPE);
    new Notice('Close Lethe Successfully');
  }

  registerMobileEvent() {
    this.registerEvent(
      this.app.workspace.on('receive-text-menu', (menu, source) => {
        menu.addItem((item: any) => {
          item
            .setIcon('popup-open')
            .setTitle('Insert as Memo')
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
            .setTitle('Insert file as memo content')
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

    // Initialize the app in the store BEFORE any commands can be used
    // This ensures Quick Capture and other features work even if the main view hasn't been opened yet
    dailyNotesService.getApp(this.app);

    // Initialize exported settings EARLY so Quick Capture can access them
    // This ensures MemoStorageMode and other settings are available before the main view opens
    initializeSettings(this.settings);

    // Initialize memo index service
    memoIndexService.setPlugin(this);

    // Recover pending capture notes once Obsidian's layout and vault are ready.
    if (this.captureRuntime) {
      this.captureRuntime.initialize().catch((error: unknown) => {
        console.error('[Lethe] Failed to recover capture notes:', error);
      });
    }

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

    this.addRibbonIcon('Memos', 'Lethe', () => {
      this.openMemos();
    });

    const leaves = this.app.workspace.getLeavesOfType(MEMOS_VIEW_TYPE);
    if (!(leaves.length > 0)) {
      return;
    }
    if (this.settings.FocusOnEditor) {
      const leaf = leaves[0];
      focusEditor(leaf.view.containerEl);
      return;
    }
    // OpenMemosAutomatically removed - hardcoded to false (don't auto-open)
    return;
  }

  async openMemos() {
    const workspace = this.app.workspace;
    workspace.detachLeavesOfType(MEMOS_VIEW_TYPE);

    let leaf;
    if (this.settings.ShowInSidebar) {
      // Open in sidebar
      const sidebarLeaf =
        this.settings.SidebarLocation === 'left' ? workspace.getLeftLeaf(false) : workspace.getRightLeaf(false);
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

    focusEditor(leaf.view.containerEl);
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
    focusEditor(leaf.view.containerEl);
  }

  noteIt() {
    const workspace = this.app.workspace;
    const leaves = workspace.getLeavesOfType(MEMOS_VIEW_TYPE);
    if (!(leaves.length > 0)) {
      new Notice('Please Open Lethe First');
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
      new Notice('Please Open Lethe First');
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

    focusEditor(leaf.view.containerEl);
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

      new Notice(this.settings.ShowInSidebar ? 'Lethe will now open in sidebar' : 'Lethe will now open in tab');
    } else {
      // Just save the setting
      new Notice(
        this.settings.ShowInSidebar ? 'Lethe will open in sidebar next time' : 'Lethe will open in tab next time',
      );
    }
  }

  quickCapture() {
    new QuickCaptureModal(this.app).open();
  }
}

interface ObsidianSecretExports {
  SecretComponent?: unknown;
}

function hasNativeSecretComponent(): boolean {
  const candidate = (ObsidianApi as unknown as ObsidianSecretExports).SecretComponent;
  return typeof candidate === 'function';
}

function hasNativeJevSecretCapabilities(app: unknown): boolean {
  return hasNativeSecretStorage(app) && hasNativeSecretComponent();
}

function runtimeJevSettings(app: unknown, input: unknown): JevSettings {
  return applyLocalOnlyFallback(input, app, hasNativeSecretComponent());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMemoIndex(value: unknown): value is Model.MemoIndex {
  return isRecord(value) && typeof value.version === 'number' && isRecord(value.entries);
}

function focusEditor(containerEl: HTMLElement): void {
  const editor = containerEl.querySelector<HTMLElement>('.cm-content, textarea');
  editor?.focus();
}
