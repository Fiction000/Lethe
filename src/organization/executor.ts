import { createSafeMetadataMergePlan, createSafeUndoPlan, sameDocument, type ParsedMarkdown } from './metadata';
import type {
  OrganizationAppliedMetadata,
  OrganizationApplyRequest,
  OrganizationApplyResult,
  OrganizationExecutorPort,
  OrganizationUndoRequest,
  OrganizationUndoResult,
} from './types';

export interface FrontmatterPort {
  parse(content: string): ParsedMarkdown;
  serialize(document: ParsedMarkdown): string;
}

/** The adapter must use Obsidian's rename operation so links can be updated. */
export interface OrganizationVaultPort {
  list(folder: string): Promise<readonly string[]>;
  read(path: string): Promise<string | null>;
  /** Atomically replace content only when it still equals expectedContent. */
  write(path: string, content: string, expectedContent: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

export interface OrganizationExecutorOptions {
  readonly vault: OrganizationVaultPort;
  readonly frontmatter: FrontmatterPort;
  readonly inboxFolder?: string;
  readonly notesFolder?: string;
}

interface LocatedNote {
  readonly path: string;
  readonly content: string;
  readonly document: ParsedMarkdown;
}

interface DestinationResult {
  readonly path?: string;
  readonly conflict?: string;
}

const CAPTURE_MARKER = 'lethe_capture_id';
const REVISION_MARKER = 'lethe_capture_revision';

export class OrganizationExecutor implements OrganizationExecutorPort {
  private readonly inboxFolder: string;
  private readonly notesFolder: string;

  public constructor(private readonly options: OrganizationExecutorOptions) {
    this.inboxFolder = validatePath(options.inboxFolder ?? 'Inbox');
    this.notesFolder = validatePath(options.notesFolder ?? 'Notes');
  }

  public async apply(request: OrganizationApplyRequest): Promise<OrganizationApplyResult> {
    assertNotAborted(request.signal);
    if (request.decision.outcome !== 'certain') {
      return { status: 'conflict', code: 'decision-not-certain', notePath: request.notePath };
    }
    const baseline = this.parseSafe(request.baseline.content);
    if (baseline === undefined) {
      return { status: 'conflict', code: 'baseline-frontmatter-invalid', notePath: request.baseline.path };
    }
    if (baseline.body !== request.capture.body || !hasMarker(baseline, request.capture.id, request.capture.revision)) {
      return { status: 'conflict', code: 'baseline-capture-mismatch', notePath: request.baseline.path };
    }

    const located = await this.locate(request.notePath, request.capture.id, request.capture.revision, request.signal);
    if ('status' in located) {
      return located;
    }

    const expectedPlan = createSafeMetadataMergePlan({
      baseline,
      current: baseline,
      decision: request.decision,
      overrides: request.overrides,
      path: located.path,
    });
    if (expectedPlan.kind !== 'apply') {
      return { status: 'conflict', code: expectedPlan.reason, notePath: located.path };
    }

    const alreadyApplied = sameDocument(located.document, expectedPlan.document);
    const destination = await this.destinationFor(
      request.capture.body,
      request.capture.id,
      request.capture.revision,
      located.path,
      request.signal,
    );
    if (destination.conflict !== undefined) {
      return { status: 'conflict', code: destination.conflict, notePath: located.path };
    }

    let applied = expectedPlan.applied;
    if (!alreadyApplied) {
      const plan = createSafeMetadataMergePlan({
        baseline,
        current: located.document,
        decision: request.decision,
        overrides: request.overrides,
        path: located.path,
      });
      if (plan.kind !== 'apply') {
        return { status: 'conflict', code: plan.reason, notePath: located.path };
      }
      assertNotAborted(request.signal);
      await this.options.vault.write(located.path, this.options.frontmatter.serialize(plan.document), located.content);
      applied = plan.applied;
    }

    const finalPath = destination.path ?? located.path;
    let promotion: OrganizationAppliedMetadata['promotion'];
    if (finalPath !== located.path) {
      assertNotAborted(request.signal);
      await this.options.vault.rename(located.path, finalPath);
      promotion = { from: located.path, to: finalPath };
    } else if (
      located.path !== request.baseline.path &&
      request.baseline.path.startsWith(`${this.inboxFolder}/`) &&
      this.isPromotionCandidate(located.path, request.capture.body, request.capture.id)
    ) {
      // The metadata write may have succeeded before the process lost the
      // completion receipt. Recover the deterministic move so Undo can safely
      // promote the note back to the exact baseline path.
      promotion = { from: request.baseline.path, to: located.path };
    }

    const completeApplied: OrganizationAppliedMetadata = {
      ...applied,
      path: finalPath,
      body: request.capture.body,
      ...(promotion === undefined ? {} : { promotion }),
    };
    return { status: 'applied', notePath: finalPath, applied: completeApplied };
  }

  public async undo(request: OrganizationUndoRequest): Promise<OrganizationUndoResult> {
    assertNotAborted(request.signal);
    const located = await this.locate(request.notePath, request.capture.id, request.capture.revision, request.signal);
    if ('status' in located) {
      return located;
    }
    const plan = createSafeUndoPlan({ current: located.document, applied: request.applied });
    if (plan.kind === 'decline') {
      return { status: 'conflict', code: plan.reason, notePath: located.path };
    }
    let notePath = located.path;
    const metadataChanged = plan.restoredProperties.length > 0 || plan.removedTags.length > 0;
    if (metadataChanged) {
      assertNotAborted(request.signal);
      await this.options.vault.write(located.path, this.options.frontmatter.serialize(plan.document), located.content);
    }

    const promotion = request.applied.promotion;
    if (promotion !== undefined && located.path === promotion.to) {
      validatePath(promotion.from);
      validatePath(promotion.to);
      const original = await this.options.vault.read(promotion.from);
      if (original === null) {
        assertNotAborted(request.signal);
        await this.options.vault.rename(promotion.to, promotion.from);
        notePath = promotion.from;
      }
    }
    if (!metadataChanged && notePath === located.path) {
      return { status: 'unchanged', notePath: located.path };
    }
    return { status: 'undone', notePath };
  }

  private async locate(
    notePath: string,
    captureId: string,
    revision: number,
    signal: AbortSignal,
  ): Promise<
    | LocatedNote
    | { readonly status: 'deleted'; readonly code: 'known-deletion'; readonly notePath?: string }
    | { readonly status: 'conflict'; readonly code: string; readonly notePath?: string }
  > {
    validatePath(notePath);
    assertNotAborted(signal);
    const known = await this.options.vault.read(notePath);
    if (known !== null) {
      const document = this.parseSafe(known);
      if (document === undefined) {
        return { status: 'conflict', code: 'frontmatter-invalid', notePath };
      }
      if (!hasMarker(document, captureId, revision)) {
        return { status: 'conflict', code: 'marker-mismatch', notePath };
      }
      return { path: notePath, content: known, document };
    }

    const matches: LocatedNote[] = [];
    const folders = new Set([this.inboxFolder, this.notesFolder]);
    for (const folder of folders) {
      assertNotAborted(signal);
      for (const path of await this.options.vault.list(folder)) {
        validatePath(path);
        const content = await this.options.vault.read(path);
        if (content === null) {
          continue;
        }
        const document = this.parseSafe(content);
        if (document !== undefined && hasMarker(document, captureId, revision)) {
          matches.push({ path, content, document });
        }
      }
    }
    if (matches.length > 1) {
      return { status: 'conflict', code: 'duplicate-marker' };
    }
    if (matches.length === 1) {
      return matches[0];
    }
    return { status: 'deleted', code: 'known-deletion', notePath };
  }

  private async destinationFor(
    body: string,
    captureId: string,
    revision: number,
    currentPath: string,
    signal: AbortSignal,
  ): Promise<DestinationResult> {
    if (currentPath.startsWith(`${this.notesFolder}/`)) {
      return { path: currentPath };
    }
    if (!currentPath.startsWith(`${this.inboxFolder}/`)) {
      return { conflict: 'unsupported-source-folder' };
    }

    const stem = safeStem(body) || 'capture';
    const idStem = sanitizeSegment(captureId) || 'capture';
    const base = `${this.notesFolder}/${stem}-${idStem}.md`;
    for (let index = 0; ; index += 1) {
      assertNotAborted(signal);
      const candidate = index === 0 ? base : base.replace(/\.md$/u, `-${index}.md`);
      const existing = await this.options.vault.read(candidate);
      if (existing === null) {
        return { path: candidate };
      }
      const existingDocument = this.parseSafe(existing);
      if (existingDocument !== undefined && hasMarker(existingDocument, captureId, revision)) {
        return { conflict: 'duplicate-marker' };
      }
      // An existing unrelated file is never overwritten. The next
      // deterministic suffix is the collision-safe destination.
    }
  }

  private isPromotionCandidate(path: string, body: string, captureId: string): boolean {
    const stem = safeStem(body) || 'capture';
    const idStem = sanitizeSegment(captureId) || 'capture';
    const base = `${this.notesFolder}/${stem}-${idStem}.md`;
    if (path === base) {
      return true;
    }
    const prefix = base.replace(/\.md$/u, '-');
    return path.startsWith(prefix) && /^\d+\.md$/u.test(path.slice(prefix.length));
  }

  private parseSafe(content: string): ParsedMarkdown | undefined {
    try {
      return this.options.frontmatter.parse(content);
    } catch {
      return undefined;
    }
  }
}

function hasMarker(document: ParsedMarkdown, captureId: string, revision: number): boolean {
  const markerId = document.frontmatter[CAPTURE_MARKER];
  const markerRevision = document.frontmatter[REVISION_MARKER];
  return (
    markerId === captureId &&
    ((typeof markerRevision === 'number' && markerRevision === revision) ||
      (typeof markerRevision === 'string' && Number(markerRevision) === revision))
  );
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error('organization operation cancelled');
  }
}

function validatePath(path: string): string {
  const normalized = path.replace(/\\/gu, '/').replace(/\/+$/u, '');
  if (
    normalized === '' ||
    normalized.startsWith('/') ||
    normalized.includes('\0') ||
    normalized.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`unsafe organization path: ${path}`);
  }
  return normalized;
}

function safeStem(body: string): string {
  const firstLine = body.split(/\r?\n/u).find((line) => line.trim() !== '') ?? '';
  return sanitizeSegment(firstLine).slice(0, 80);
}

function sanitizeSegment(value: string): string {
  return [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && codePoint < 32 ? ' ' : character;
    })
    .join('')
    .replace(/[\\/:*?"<>|]/gu, ' ')
    .trim()
    .replace(/\s+/gu, '-')
    .replace(/[^\p{L}\p{N}._-]/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^[-.]+|[-.]+$/gu, '');
}
