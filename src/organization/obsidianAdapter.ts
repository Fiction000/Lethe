import type { App, TAbstractFile, TFile } from 'obsidian';

import { MAX_JEV_TIMEOUT_MS, type JevTransport, type JevTransportRequest, type JevTransportResponse } from '../jev';
import { validateVaultPath } from '../capture/writer';
import type { FrontmatterPort, OrganizationVaultPort } from './executor';
import type { ParsedMarkdown } from './metadata';

export interface ObsidianYamlApi {
  parseYaml(yaml: string): unknown;
  stringifyYaml(value: unknown): string;
}

export interface ObsidianRequestUrlResponse {
  readonly status: number;
  readonly text: string;
}

export type ObsidianRequestUrl = (request: {
  readonly url: string;
  readonly method?: string;
  readonly contentType?: string;
  readonly body?: string;
  readonly headers?: Record<string, string>;
  readonly throw?: boolean;
}) => Promise<ObsidianRequestUrlResponse>;

interface PendingObsidianRequest {
  readonly promise: Promise<ObsidianRequestUrlResponse>;
  readonly expiry: ReturnType<typeof setTimeout>;
}

const OBSIDIAN_REQUEST_RETENTION_MS = MAX_JEV_TIMEOUT_MS;

export class ObsidianOrganizationAdapterError extends Error {
  public constructor(
    public readonly code: 'missing-note' | 'compare-and-swap-conflict' | 'process-unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'ObsidianOrganizationAdapterError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * The frontmatter boundary uses Obsidian's YAML implementation while keeping
 * the bytes after the closing fence untouched.
 */
export class ObsidianFrontmatterAdapter implements FrontmatterPort {
  public constructor(private readonly yaml: ObsidianYamlApi) {}

  public parse(content: string): ParsedMarkdown {
    const split = splitFrontmatter(content);
    const parsed = this.yaml.parseYaml(split.yaml);
    if (!isRecord(parsed)) {
      throw new Error('Obsidian frontmatter must decode to an object');
    }
    return { frontmatter: cloneRecord(parsed), body: split.body };
  }

  public serialize(document: ParsedMarkdown): string {
    const rawYaml = this.yaml.stringifyYaml(cloneRecord(document.frontmatter));
    if (typeof rawYaml !== 'string') {
      throw new Error('Obsidian YAML serializer returned a non-string value');
    }
    const yaml = rawYaml.replace(/(?:\r?\n)+$/u, '');
    return `---\n${yaml}\n---\n${document.body}`;
  }
}

export { ObsidianFrontmatterAdapter as ObsidianFrontmatterPort };

export function createObsidianFrontmatterPort(yaml: ObsidianYamlApi): FrontmatterPort {
  return new ObsidianFrontmatterAdapter(yaml);
}

/** Obsidian-aware vault port for organization writes and link-preserving moves. */
export class ObsidianOrganizationVaultAdapter implements OrganizationVaultPort {
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

  /**
   * Commit only when the exact bytes observed by the executor are still the
   * current file. Vault.process supplies the serialized read/modify/write
   * operation instead of a racy read followed by modify.
   */
  public async write(path: string, content: string, expectedContent: string): Promise<void> {
    const normalizedPath = validateVaultPath(path);
    const abstractFile = this.app.vault.getAbstractFileByPath(normalizedPath);
    if (!isVaultFile(abstractFile)) {
      throw new ObsidianOrganizationAdapterError('missing-note', `Organization note is missing: ${normalizedPath}`);
    }

    const vault = this.app.vault as unknown as {
      process?: (file: TFile, callback: (current: string) => string) => Promise<void>;
    };
    if (typeof vault.process !== 'function') {
      throw new ObsidianOrganizationAdapterError(
        'process-unavailable',
        'This Obsidian version does not expose atomic vault.process writes',
      );
    }

    await vault.process.call(this.app.vault, abstractFile, (current: string) => {
      if (current !== expectedContent) {
        throw new ObsidianOrganizationAdapterError(
          'compare-and-swap-conflict',
          `Organization note changed before compare-and-swap could update it: ${normalizedPath}`,
        );
      }
      return content;
    });
  }

  /** Move through FileManager so Obsidian updates links and embeds. */
  public async rename(from: string, to: string): Promise<void> {
    const normalizedFrom = validateVaultPath(from);
    const normalizedTo = validateVaultPath(to);
    if (normalizedFrom === normalizedTo) {
      return;
    }
    const source = this.app.vault.getAbstractFileByPath(normalizedFrom);
    if (!isVaultFile(source)) {
      throw new ObsidianOrganizationAdapterError('missing-note', `Organization note is missing: ${normalizedFrom}`);
    }
    await this.ensureParentFolder(normalizedTo);

    const fileManager = this.app.fileManager as unknown as {
      renameFile?: (file: TAbstractFile, newPath: string) => Promise<void>;
    };
    if (typeof fileManager.renameFile !== 'function') {
      throw new Error('Obsidian FileManager.renameFile is unavailable');
    }
    await fileManager.renameFile.call(this.app.fileManager, source, normalizedTo);
  }

  private async ensureParentFolder(path: string): Promise<void> {
    const separator = path.lastIndexOf('/');
    if (separator <= 0) {
      return;
    }
    const parent = path.slice(0, separator);
    let current = '';
    for (const segment of parent.split('/')) {
      current = current === '' ? segment : `${current}/${segment}`;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (existing !== null) {
        if (!isVaultFolder(existing)) {
          throw new Error(`Organization destination is not a folder: ${current}`);
        }
        continue;
      }
      try {
        await this.app.vault.createFolder(current);
      } catch (error) {
        const after = this.app.vault.getAbstractFileByPath(current);
        if (after === null) {
          throw error;
        }
        if (!isVaultFolder(after)) {
          throw new Error(`Organization destination is not a folder: ${current}`);
        }
      }
    }
  }
}

export { ObsidianOrganizationVaultAdapter as ObsidianVaultOrganizationAdapter };

export function createObsidianOrganizationVaultAdapter(app: App): ObsidianOrganizationVaultAdapter {
  return new ObsidianOrganizationVaultAdapter(app);
}

/** Adapt Obsidian's non-abortable requestUrl to the Jev transport contract. */
export function createObsidianJevTransport(requestUrl: ObsidianRequestUrl): JevTransport {
  const inFlight = new Map<string, PendingObsidianRequest>();

  return async (request: JevTransportRequest): Promise<JevTransportResponse> => {
    if (request.signal.aborted) {
      throw new Error('Jev request was aborted');
    }
    const key = requestKey(request);
    let pending = inFlight.get(key);
    if (pending === undefined) {
      const underlying = Promise.resolve().then(() =>
        requestUrl({
          url: request.url,
          method: request.method,
          headers: { ...request.headers },
          body: request.body,
          contentType: 'application/json',
          throw: false,
        }),
      );
      const safe = underlying.catch(() => {
        throw new Error('Jev request failed before a response was received');
      });
      const expiry = setTimeout(() => {
        if (inFlight.get(key)?.promise === safe) {
          inFlight.delete(key);
        }
      }, OBSIDIAN_REQUEST_RETENTION_MS);
      pending = { promise: safe, expiry };
      inFlight.set(key, pending);
      void safe.then(
        () => removePendingRequest(inFlight, key, pending as PendingObsidianRequest),
        () => removePendingRequest(inFlight, key, pending as PendingObsidianRequest),
      );
    }
    const response = await waitForObsidianResponse(pending.promise, request.signal);
    return {
      status: response.status,
      text: () => Promise.resolve(response.text),
    };
  };
}

function requestKey(request: JevTransportRequest): string {
  return JSON.stringify([
    request.url,
    request.method,
    request.body,
    Object.entries(request.headers).sort(([left], [right]) => left.localeCompare(right)),
  ]);
}

function removePendingRequest(
  inFlight: Map<string, PendingObsidianRequest>,
  key: string,
  pending: PendingObsidianRequest,
): void {
  clearTimeout(pending.expiry);
  if (inFlight.get(key) === pending) {
    inFlight.delete(key);
  }
}

function waitForObsidianResponse<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new Error('Jev request was aborted'));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener('abort', onAbort);
      reject(new Error('Jev request was aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void pending.then(
      (value) => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

interface FrontmatterSplit {
  readonly yaml: string;
  readonly body: string;
}

function splitFrontmatter(content: string): FrontmatterSplit {
  const openingLength = content.startsWith('---\r\n') ? 5 : content.startsWith('---\n') ? 4 : 0;
  if (openingLength === 0) {
    throw new Error('Markdown note has no opening frontmatter fence');
  }

  let cursor = openingLength;
  while (cursor <= content.length) {
    const lineEnd = content.indexOf('\n', cursor);
    const end = lineEnd === -1 ? content.length : lineEnd;
    const line = content.slice(cursor, end).replace(/\r$/u, '');
    if (line === '---') {
      const bodyStart = lineEnd === -1 ? content.length : lineEnd + 1;
      return {
        yaml: content.slice(openingLength, cursor),
        body: content.slice(bodyStart),
      };
    }
    if (lineEnd === -1) {
      break;
    }
    cursor = lineEnd + 1;
  }
  throw new Error('Markdown note has no closing frontmatter fence');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isVaultFile(value: unknown): value is TFile {
  return isRecord(value) && typeof value.path === 'string' && typeof value.extension === 'string';
}

function isVaultFolder(value: unknown): value is { readonly children: readonly unknown[] } {
  return isRecord(value) && Array.isArray(value.children);
}

function cloneRecord(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = clone(child);
  }
  return result;
}

function clone<T>(value: T): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => clone(item)) as T;
  }
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    result[key] = clone(child);
  }
  return result as T;
}
