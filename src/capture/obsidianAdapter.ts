import type { App, TFile } from 'obsidian';

import type { NoteRef } from './core';
import type { VaultPort } from './writer';
import { validateVaultPath } from './writer';

export interface ObsidianVaultAdapterOptions {
  readonly app: App;
}

/**
 * The small Obsidian boundary used by the capture writer.
 * It deliberately owns only vault reads, creates, and opening a written note.
 */
export class ObsidianVaultAdapter implements VaultPort {
  public constructor(public readonly app: App) {}

  public async list(folder: string): Promise<readonly string[]> {
    const normalizedFolder = validateVaultPath(folder);
    const prefix = `${normalizedFolder}/`;
    return this.app.vault
      .getMarkdownFiles()
      .map((file) => file.path)
      .filter((path) => path.startsWith(prefix));
  }

  public async read(path: string): Promise<string | null> {
    const normalizedPath = validateVaultPath(path);
    const abstractFile = this.app.vault.getAbstractFileByPath(normalizedPath);
    if (!isVaultFile(abstractFile)) {
      return null;
    }
    try {
      return await this.app.vault.read(abstractFile);
    } catch (error) {
      if (this.app.vault.getAbstractFileByPath(normalizedPath) === null) {
        return null;
      }
      throw error;
    }
  }

  public async create(path: string, content: string): Promise<void> {
    const normalizedPath = validateVaultPath(path);
    await this.ensureParentFolder(normalizedPath);
    await this.app.vault.create(normalizedPath, content);
    const readBack = await this.read(normalizedPath);
    if (readBack !== content) {
      throw new Error(`Vault readback did not match created note: ${normalizedPath}`);
    }
  }

  public async openNote(note: NoteRef): Promise<void> {
    const normalizedPath = validateVaultPath(note.path);
    const abstractFile = this.app.vault.getAbstractFileByPath(normalizedPath);
    if (!isVaultFile(abstractFile)) {
      throw new Error(`Vault note does not exist: ${normalizedPath}`);
    }
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(abstractFile);
  }

  private async ensureParentFolder(path: string): Promise<void> {
    const separator = path.lastIndexOf('/');
    if (separator <= 0) {
      return;
    }
    const parent = path.slice(0, separator);
    const segments = parent.split('/');
    let current = '';
    for (const segment of segments) {
      current = current === '' ? segment : `${current}/${segment}`;
      if (this.app.vault.getAbstractFileByPath(current) !== null) {
        continue;
      }
      try {
        await this.app.vault.createFolder(current);
      } catch (error) {
        if (this.app.vault.getAbstractFileByPath(current) === null) {
          throw error;
        }
      }
    }
  }
}

export { ObsidianVaultAdapter as ObsidianCaptureAdapter };

export function createObsidianVaultAdapter(app: App): ObsidianVaultAdapter {
  return new ObsidianVaultAdapter(app);
}

function isVaultFile(value: unknown): value is TFile {
  return isRecord(value) && typeof value.path === 'string' && typeof value.extension === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
