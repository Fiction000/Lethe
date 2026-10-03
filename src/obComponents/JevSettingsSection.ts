import { App, Setting } from 'obsidian';
import * as ObsidianApi from 'obsidian';

import {
  JEV_DEFAULT_SECRET_ID,
  JEV_MAX_APPROVED_TAGS,
  JEV_MAX_DESCRIPTION_LENGTH,
  JEV_MAX_MODEL_LENGTH,
  JEV_MAX_TAG_LENGTH,
  JevSettings,
  applyLocalOnlyFallback,
  hasNativeSecretStorage,
  normalizeJevSettings,
  validateApprovedTags,
} from '../jevSettings';

type SecretComponentLike = {
  setValue(value: string): SecretComponentLike;
  onChange(callback: (value: string | null) => unknown): SecretComponentLike;
};

type SecretComponentConstructor = new (app: App, containerEl: HTMLElement) => SecretComponentLike;

interface ObsidianSecretExports {
  SecretComponent?: SecretComponentConstructor;
}

export interface JevSettingsSectionOptions {
  app: App;
  containerEl: HTMLElement;
  settings: JevSettings;
  onChange: (settings: JevSettings) => void | Promise<void>;
}

export const JEV_DISCLOSURE =
  'Jev is optional. When you submit a capture, its submitted body, profile, fields, added tags, and removed tags are sent to TypeSafe; drafts, keystrokes, and the whole vault are not sent. Local saving continues if the network fails.';

export const JEV_AUTOMATIC_DISCLOSURE =
  'Automatic operation remains quality-gated and may abstain. A confidence threshold is not a measured accuracy claim.';

export const JEV_TAXONOMY_DISCLOSURE =
  'Jev may suggest only approved content tags here. Structural type/state markers are not allowed, and existing user or manual tags are never changed.';

function getSecretComponentConstructor(): SecretComponentConstructor | null {
  const candidate = (ObsidianApi as unknown as ObsidianSecretExports).SecretComponent;
  return typeof candidate === 'function' ? candidate : null;
}

function rejectionMessage(reason: string): string {
  switch (reason) {
    case 'structural-tag':
      return 'Type/state structural tags are not allowed in the Jev taxonomy.';
    case 'tag-too-long':
      return `Tags must be ${JEV_MAX_TAG_LENGTH} characters or fewer.`;
    case 'description-too-long':
      return `Descriptions must be ${JEV_MAX_DESCRIPTION_LENGTH} characters or fewer.`;
    case 'duplicate-tag':
      return 'That approved tag is already listed.';
    case 'too-many-tags':
      return `Use at most ${JEV_MAX_APPROVED_TAGS} approved tags.`;
    case 'invalid-description':
      return 'The description must be text.';
    case 'entry-not-object':
    case 'invalid-tag':
    default:
      return 'Enter one non-empty tag without spaces or additional # characters.';
  }
}

function setMaxLength(input: HTMLInputElement, maxLength: number): void {
  input.maxLength = maxLength;
}

export class JevSettingsSection {
  private readonly options: JevSettingsSectionOptions;
  private settings: JevSettings;
  private sectionEl?: HTMLElement;
  private secretComponentUnavailable = false;

  constructor(options: JevSettingsSectionOptions) {
    this.options = options;
    this.settings = normalizeJevSettings(options.settings);
  }

  render(): void {
    if (!this.sectionEl) {
      this.sectionEl = this.options.containerEl.createDiv({ cls: 'lethe-jev-settings' });
    } else {
      this.sectionEl.empty();
    }

    const containerEl = this.sectionEl;
    containerEl.createEl('h2', { text: 'Jev (optional)' });
    containerEl.createEl('p', { text: JEV_DISCLOSURE, cls: 'setting-item-description' });

    const secretComponent = this.secretComponentUnavailable ? null : getSecretComponentConstructor();
    const secretStorageAvailable = hasNativeSecretStorage(this.options.app) && secretComponent !== null;
    const safeSettings = applyLocalOnlyFallback(this.settings, this.options.app, secretComponent !== null);
    if (safeSettings.mode !== this.settings.mode) {
      this.settings = safeSettings;
      this.notifyChange();
    }

    new Setting(containerEl)
      .setName('Jev mode')
      .setDesc(
        secretStorageAvailable
          ? `Off keeps processing local. Advisory records bounded suggestions without applying them. ${JEV_AUTOMATIC_DISCLOSURE}`
          : 'Secure secret storage is unavailable in this Obsidian version. Lethe remains local-only and does not offer a plaintext key field.',
      )
      .addDropdown((dropdown) => {
        dropdown
          .addOption('off', 'Off')
          .addOption('advisory', 'Advisory')
          .addOption('automatic', 'Automatic')
          .setValue(this.settings.mode)
          .setDisabled(!secretStorageAvailable)
          .onChange((value) => {
            this.commit({ ...this.settings, mode: value });
          });
      });

    new Setting(containerEl)
      .setName('Jev model')
      .setDesc('Model identifier used for future submitted text. It is stored as configuration, not as a credential.')
      .addText((text) => {
        text.setValue(this.settings.model);
        setMaxLength(text.inputEl, JEV_MAX_MODEL_LENGTH);
        text.onChange((value) => {
          this.settings = normalizeJevSettings({ ...this.settings, model: value });
          this.notifyChange();
        });
      });

    const renderedSecretReference = this.renderSecretReference(containerEl, secretComponent, secretStorageAvailable);
    if (!renderedSecretReference) {
      return;
    }
    this.renderTaxonomy(containerEl);
  }

  private renderSecretReference(
    containerEl: HTMLElement,
    secretComponent: SecretComponentConstructor | null,
    secretStorageAvailable: boolean,
  ): boolean {
    const setting = new Setting(containerEl)
      .setName('TypeSafe key')
      .setDesc(
        secretStorageAvailable
          ? 'Select a key managed by Obsidian Secret Storage. Lethe stores only its ID reference; the key value is never placed in plugin data.'
          : 'Unavailable: this Obsidian version does not expose both Secret Storage and SecretComponent. No plaintext fallback is provided.',
      );

    if (!secretStorageAvailable || secretComponent === null) {
      return true;
    }

    const secretContainer = setting.controlEl.createDiv({ cls: 'lethe-jev-secret-control' });
    try {
      const component = new secretComponent(this.options.app, secretContainer);
      component.setValue(this.settings.secretId).onChange((secretId) => {
        this.commit({ ...this.settings, secretId: secretId ?? JEV_DEFAULT_SECRET_ID });
      });
    } catch {
      // A partially backported API is treated as unsupported; never create a
      // text input that could place a credential in plugin data.
      this.secretComponentUnavailable = true;
      secretContainer.empty();
      secretContainer.createEl('span', {
        text: 'Unavailable: native secret storage could not be initialized. Lethe remains local-only.',
        cls: 'setting-item-description',
      });
      const safeSettings = applyLocalOnlyFallback(this.settings, this.options.app, false);
      if (safeSettings.mode !== this.settings.mode) {
        this.settings = safeSettings;
        this.notifyChange();
      }
      this.render();
      return false;
    }

    return true;
  }

  private renderTaxonomy(containerEl: HTMLElement): void {
    const taxonomyEl = containerEl.createDiv({ cls: 'lethe-jev-taxonomy' });
    taxonomyEl.createEl('h3', { text: 'Approved content tags' });
    taxonomyEl.createEl('p', { text: JEV_TAXONOMY_DISCLOSURE, cls: 'setting-item-description' });

    this.settings.approvedTags.forEach((descriptor, index) => {
      new Setting(taxonomyEl)
        .setName(`#${descriptor.tag}`)
        .setDesc(descriptor.description || 'No description')
        .addButton((button) => {
          button
            .setButtonText('Remove')
            .setWarning()
            .onClick(() => {
              this.commit({
                ...this.settings,
                approvedTags: this.settings.approvedTags.filter((_, currentIndex) => currentIndex !== index),
              });
            });
        });
    });

    let tagValue = '';
    let descriptionValue = '';
    const feedbackEl = taxonomyEl.createDiv({ cls: 'setting-item-description' });
    const addSetting = new Setting(taxonomyEl)
      .setName('Add approved tag')
      .setDesc(`Up to ${JEV_MAX_APPROVED_TAGS} tags. Tags are normalized without a leading #.`)
      .addText((text) => {
        text.setPlaceholder('e.g. reading');
        setMaxLength(text.inputEl, JEV_MAX_TAG_LENGTH);
        text.onChange((value) => {
          tagValue = value;
        });
      })
      .addText((text) => {
        text.setPlaceholder('Short description (optional)');
        setMaxLength(text.inputEl, JEV_MAX_DESCRIPTION_LENGTH);
        text.onChange((value) => {
          descriptionValue = value;
        });
      });

    addSetting.addButton((button) => {
      button
        .setButtonText('Add')
        .setCta()
        .onClick(() => {
          const nextIndex = this.settings.approvedTags.length;
          const validation = validateApprovedTags([
            ...this.settings.approvedTags,
            { tag: tagValue, description: descriptionValue },
          ]);
          const rejection = validation.rejected.find(({ index }) => index === nextIndex);
          if (rejection || validation.accepted.length !== nextIndex + 1) {
            feedbackEl.textContent = rejectionMessage(rejection?.reason ?? 'invalid-tag');
            return;
          }

          this.commit({ ...this.settings, approvedTags: validation.accepted });
        });
    });
  }

  private commit(input: unknown): void {
    this.settings = normalizeJevSettings(input);
    this.notifyChange();
    this.render();
  }

  private notifyChange(): void {
    try {
      const result = this.options.onChange(this.settings);
      if (result && typeof (result as Promise<void>).then === 'function') {
        void (result as Promise<void>).catch(() => undefined);
      }
    } catch {
      // Settings UI remains usable if a host save hook fails. Local capture is
      // independent from Jev/network work and must never be blocked here.
    }
  }
}

export function renderJevSettingsSection(options: JevSettingsSectionOptions): JevSettingsSection {
  const section = new JevSettingsSection(options);
  section.render();
  return section;
}
