export type LegacyCaptureSurface = 'main' | 'quick';

export interface LegacyCaptureOrigin {
  readonly surface: LegacyCaptureSurface;
  /** Empty for a fresh draft; populated only by the main editor's edit flow. */
  readonly editMemoId: string;
}

export interface LegacyEditorScope {
  readonly surface: LegacyCaptureSurface;
  readonly usesSharedEditMemoId: boolean;
  readonly usesSharedContentCache: boolean;
  readonly usesSharedMarkMemoId: boolean;
}

export interface LegacyUploadToken {
  readonly generation: number;
  readonly requestId: number;
  readonly origin: LegacyCaptureOrigin;
}

export interface LegacyCaptureSnapshot {
  readonly pendingUploads: number;
  readonly submitting: boolean;
  readonly mounted: boolean;
}

export function createLegacyEditorScope(forceNew = false): LegacyEditorScope {
  if (forceNew) {
    return {
      surface: 'quick',
      usesSharedEditMemoId: false,
      usesSharedContentCache: false,
      usesSharedMarkMemoId: false,
    };
  }

  return {
    surface: 'main',
    usesSharedEditMemoId: true,
    usesSharedContentCache: true,
    usesSharedMarkMemoId: true,
  };
}

export function createLegacyCaptureOrigin(forceNew: boolean, editMemoId: string): LegacyCaptureOrigin {
  return forceNew ? { surface: 'quick', editMemoId: '' } : { surface: 'main', editMemoId };
}

/** Normalize the legacy entity without changing user-authored whitespace. */
export function normalizeLegacyContent(content: string): string {
  return content.replaceAll('&nbsp;', ' ');
}

type LegacyCaptureListener = () => void;

/**
 * Coordinates legacy uploads and submissions for one editor instance.
 *
 * Upload tokens are valid only for the origin and generation that created
 * them. Rotating a draft therefore makes every late upload a no-op, rather
 * than allowing it to insert into whichever editor happens to be current.
 */
export class LegacyCaptureActions {
  private currentOrigin: LegacyCaptureOrigin;
  private generation = 0;
  private nextRequestId = 0;
  private readonly pending = new Map<number, LegacyUploadToken>();
  private readonly listeners = new Set<LegacyCaptureListener>();
  private mounted = true;
  private submitting = false;

  public constructor(origin: LegacyCaptureOrigin) {
    this.currentOrigin = cloneOrigin(origin);
  }

  public snapshot(): LegacyCaptureSnapshot {
    return {
      pendingUploads: this.pending.size,
      submitting: this.submitting,
      mounted: this.mounted,
    };
  }

  public subscribe(listener: LegacyCaptureListener): () => void {
    if (!this.mounted) return () => undefined;
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public setOrigin(origin: LegacyCaptureOrigin): void {
    if (!this.mounted || sameOrigin(this.currentOrigin, origin)) return;
    this.currentOrigin = cloneOrigin(origin);
    this.rotateGeneration();
  }

  public beginUpload(origin = this.currentOrigin): LegacyUploadToken | undefined {
    if (!this.mounted || this.submitting) return undefined;

    this.setOrigin(origin);
    const token: LegacyUploadToken = {
      generation: this.generation,
      requestId: ++this.nextRequestId,
      origin: cloneOrigin(this.currentOrigin),
    };
    this.pending.set(token.requestId, token);
    this.notify();
    return token;
  }

  /** Return true only when the completion still belongs to this live draft. */
  public completeUpload(token: LegacyUploadToken): boolean {
    return this.settleUpload(token);
  }

  /** Return true only when an error still belongs to this live draft. */
  public failUpload(token: LegacyUploadToken): boolean {
    return this.settleUpload(token);
  }

  /** Lock submission and rotate the upload generation for the submitted draft. */
  public beginSubmit(): boolean {
    if (!this.mounted || this.submitting || this.pending.size > 0) return false;
    this.generation += 1;
    this.submitting = true;
    this.notify();
    return true;
  }

  public finishSubmit(): void {
    if (!this.mounted || !this.submitting) return;
    this.submitting = false;
    this.notify();
  }

  /** Invalidate all pending work when the user cancels the current draft. */
  public cancel(): boolean {
    if (!this.mounted || this.submitting) return false;
    this.rotateGeneration();
    return true;
  }

  /** Stop all callbacks and state notifications after the editor unmounts. */
  public dispose(): void {
    if (!this.mounted) return;
    this.mounted = false;
    this.generation += 1;
    this.pending.clear();
    this.listeners.clear();
  }

  private settleUpload(token: LegacyUploadToken): boolean {
    if (
      !this.mounted ||
      token.generation !== this.generation ||
      !sameOrigin(token.origin, this.currentOrigin) ||
      !this.pending.delete(token.requestId)
    ) {
      return false;
    }

    this.notify();
    return true;
  }

  private rotateGeneration(): void {
    this.generation += 1;
    this.pending.clear();
    this.notify();
  }

  private notify(): void {
    if (!this.mounted) return;
    for (const listener of this.listeners) listener();
  }
}

function sameOrigin(left: LegacyCaptureOrigin, right: LegacyCaptureOrigin): boolean {
  return left.surface === right.surface && left.editMemoId === right.editMemoId;
}

function cloneOrigin(origin: LegacyCaptureOrigin): LegacyCaptureOrigin {
  return {
    surface: origin.surface,
    editMemoId: origin.editMemoId,
  };
}
