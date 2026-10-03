export interface PluginDataPort {
  loadData(): Promise<unknown>;
  saveData(data: unknown): Promise<void>;
}

export interface TransactionChange<T> {
  readonly next: unknown;
  readonly result: T;
}

export interface LetheDataRepository {
  read(): Promise<unknown>;
  readFresh?(): Promise<unknown>;
  transact<T>(mutate: (current: unknown) => TransactionChange<T>): Promise<T>;
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

export class SerializedDataRepository implements LetheDataRepository {
  private loaded = false;
  private current: unknown = {};
  private loadAttempt?: Promise<void>;
  private queue: Promise<void> = Promise.resolve();

  public constructor(private readonly port: PluginDataPort) {}

  public async read(): Promise<unknown> {
    await this.queue;
    await this.ensureLoaded();
    return clone(this.current);
  }

  public readFresh(): Promise<unknown> {
    const operation = async (): Promise<unknown> => {
      const value = (await this.port.loadData()) ?? {};
      this.current = value;
      this.loaded = true;
      this.loadAttempt = undefined;
      return clone(this.current);
    };
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  public transact<T>(mutate: (current: unknown) => TransactionChange<T>): Promise<T> {
    const operation = async (): Promise<T> => {
      await this.ensureLoaded();
      const change = mutate(clone(this.current));
      const next = clone(change.next);
      try {
        await this.port.saveData(next);
      } catch (error) {
        await this.refreshAfterFailedSave();
        throw error;
      }
      this.current = next;
      return change.result;
    };

    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async refreshAfterFailedSave(): Promise<void> {
    try {
      this.current = (await this.port.loadData()) ?? {};
      this.loaded = true;
    } catch {
      // Keep the last known complete snapshot when readback is unavailable.
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }
    if (!this.loadAttempt) {
      this.loadAttempt = this.port.loadData().then(
        (value) => {
          this.current = value ?? {};
          this.loaded = true;
        },
        (error: unknown) => {
          this.loadAttempt = undefined;
          throw error;
        },
      );
    }
    await this.loadAttempt;
  }
}
