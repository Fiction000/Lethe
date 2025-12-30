import { App, DropdownComponent, PluginSettingTab, Setting } from 'obsidian';
import type MemosPlugin from './index';
import memoService from './services/memoService';
import { getDailyNotePath } from './helpers/utils';

export interface MemosSettings {
  // Section 1: Storage & Content
  MemoStorageMode: 'daily-notes' | 'individual-files';
  InsertAfter: string;
  IndividualMemoFolder: string;
  DefaultPrefix: string;
  DefaultMemoComposition: string;
  // Section 2: User Interface
  UserName: string;
  ShowInSidebar: boolean;
  SidebarLocation: 'left' | 'right';
  FocusOnEditor: boolean;
  // Section 3: Performance
  PreCreateDailyNotes: boolean;
}

export const DEFAULT_SETTINGS: MemosSettings = {
  // Section 1: Storage & Content
  MemoStorageMode: 'individual-files',
  InsertAfter: '# Journal',
  IndividualMemoFolder: 'Thino/Memos',
  DefaultPrefix: 'List',
  DefaultMemoComposition: '{TIME} {CONTENT}',
  // Section 2: User Interface
  UserName: 'MEMO 😉',
  ShowInSidebar: false,
  SidebarLocation: 'right',
  FocusOnEditor: true,
  // Section 3: Performance
  PreCreateDailyNotes: false,
};

export class MemosSettingTab extends PluginSettingTab {
  plugin: MemosPlugin;
  //eslint-disable-next-line
  private applyDebounceTimer: number = 0;

  constructor(app: App, plugin: MemosPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  applySettingsUpdate() {
    clearTimeout(this.applyDebounceTimer);
    const plugin = this.plugin;
    this.applyDebounceTimer = window.setTimeout(() => {
      plugin.saveSettings();
    }, 100);
    memoService.updateTagsState();
  }

  async changeFileName(originalFileName: string, fileName: string) {
    const filePath = getDailyNotePath();
    const absolutePath = filePath + '/' + originalFileName + '.md';
    const newFilePath = filePath + '/' + fileName + '.md';
    const getFile = this.app.vault.getAbstractFileByPath(absolutePath);
    await this.app.fileManager.renameFile(getFile, newFilePath);
  }

  //eslint-disable-next-line
  async hide() {}

  async display() {
    await this.plugin.loadSettings();

    const { containerEl } = this;
    this.containerEl.empty();

    let dropdown: DropdownComponent;

    // ====================
    // SECTION 1: STORAGE & CONTENT
    // ====================
    this.containerEl.createEl('h2', { text: 'Storage & Content' });
    containerEl.createEl('p', {
      text: 'Configure where and how your memos are stored',
      cls: 'setting-item-description',
    });

    // Memo Storage Mode
    new Setting(containerEl)
      .setName('Memo storage mode')
      .setDesc(
        'Choose where to store memos: in daily notes (one file per day) or as individual files (one file per memo).',
      )
      .addDropdown((dropdownComponent) => {
        dropdown = dropdownComponent;
        dropdown
          .addOption('daily-notes', 'Daily Notes')
          .addOption('individual-files', 'Individual Files')
          .setValue(this.plugin.settings.MemoStorageMode)
          .onChange(async (value: 'daily-notes' | 'individual-files') => {
            this.plugin.settings.MemoStorageMode = value;
            this.applySettingsUpdate();
          });
      });

    // Insert After (for daily notes mode)
    new Setting(containerEl)
      .setName('Insert after heading')
      .setDesc('Heading in daily notes where memos will be inserted (e.g., "# Journal"). Only used in daily notes mode.')
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.InsertAfter)
          .setValue(this.plugin.settings.InsertAfter)
          .onChange(async (value) => {
            this.plugin.settings.InsertAfter = value;
            this.applySettingsUpdate();
          }),
      );

    // Individual Memo Folder (for individual files mode)
    new Setting(containerEl)
      .setName('Individual memo folder')
      .setDesc('Folder path for individual memo files. Only used in individual files mode.')
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.IndividualMemoFolder)
          .setValue(this.plugin.settings.IndividualMemoFolder)
          .onChange(async (value) => {
            this.plugin.settings.IndividualMemoFolder = value;
            this.applySettingsUpdate();
          }),
      );

    // Default Prefix
    new Setting(containerEl)
      .setName('Default memo type')
      .setDesc('Choose whether new memos are list items or tasks (with checkbox).')
      .addDropdown((dropdownComponent) => {
        dropdown = dropdownComponent;
        dropdown
          .addOption('List', 'List')
          .addOption('Task', 'Task')
          .setValue(this.plugin.settings.DefaultPrefix)
          .onChange(async (value) => {
            this.plugin.settings.DefaultPrefix = value;
            this.applySettingsUpdate();
          });
      });

    // Default Memo Composition
    new Setting(containerEl)
      .setName('Memo format template')
      .setDesc(
        'Template for how memos are formatted. Use {TIME} for timestamp and {CONTENT} for memo text. Example: "{TIME} {CONTENT}"',
      )
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.DefaultMemoComposition)
          .setValue(this.plugin.settings.DefaultMemoComposition)
          .onChange(async (value) => {
            this.plugin.settings.DefaultMemoComposition = value;
            this.applySettingsUpdate();
          }),
      );

    // ====================
    // SECTION 2: USER INTERFACE
    // ====================
    this.containerEl.createEl('h2', { text: 'User Interface' });
    containerEl.createEl('p', {
      text: 'Configure how Lethe looks and behaves',
      cls: 'setting-item-description',
    });

    // User Name
    new Setting(containerEl)
      .setName('User name')
      .setDesc('Your display name in memos. Default: "MEMO 😉"')
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.UserName)
          .setValue(this.plugin.settings.UserName)
          .onChange(async (value) => {
            this.plugin.settings.UserName = value;
            this.applySettingsUpdate();
          }),
      );

    // Show in Sidebar
    new Setting(containerEl)
      .setName('Show in sidebar')
      .setDesc('Open Lethe in the sidebar instead of as a tab.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.ShowInSidebar).onChange(async (value) => {
          this.plugin.settings.ShowInSidebar = value;
          this.applySettingsUpdate();
        }),
      );

    // Sidebar Location
    new Setting(containerEl)
      .setName('Sidebar location')
      .setDesc('Which sidebar to use when "Show in sidebar" is enabled.')
      .addDropdown((dropdownComponent) => {
        dropdown = dropdownComponent;
        dropdown
          .addOption('left', 'Left')
          .addOption('right', 'Right')
          .setValue(this.plugin.settings.SidebarLocation)
          .onChange(async (value: 'left' | 'right') => {
            this.plugin.settings.SidebarLocation = value;
            this.applySettingsUpdate();
          });
      });

    // Focus on Editor
    new Setting(containerEl)
      .setName('Focus on editor when opening')
      .setDesc('Automatically focus the editor when Lethe opens for quick memo capture.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.FocusOnEditor).onChange(async (value) => {
          this.plugin.settings.FocusOnEditor = value;
          this.applySettingsUpdate();
        }),
      );

    // ====================
    // SECTION 3: PERFORMANCE
    // ====================
    this.containerEl.createEl('h2', { text: 'Performance' });
    containerEl.createEl('p', {
      text: 'Optional optimizations for faster memo capture',
      cls: 'setting-item-description',
    });

    // Pre-create Daily Notes
    new Setting(containerEl)
      .setName('Pre-create daily notes')
      .setDesc(
        "Automatically create today and tomorrow's daily notes in the background. Eliminates 200-500ms delay on first memo save of the day. Only affects daily notes mode.",
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.PreCreateDailyNotes).onChange(async (value) => {
          this.plugin.settings.PreCreateDailyNotes = value;
          await this.plugin.saveSettings();

          // If enabled, trigger immediate pre-creation
          if (value) {
            const { dailyNotePreCreationService } = await import('./services/dailyNotePreCreationService');
            dailyNotePreCreationService.initialize().catch((err) => {
              console.error('[Lethe] Failed to initialize daily note pre-creation:', err);
            });
          }
        }),
      );
  }
}
