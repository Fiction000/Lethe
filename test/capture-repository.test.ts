import assert from 'node:assert/strict';
import test from 'node:test';
import { SerializedDataRepository } from '../src/capture/repository';

test('serializes a fresh read with writes so a stale load cannot overwrite newer state', async () => {
  let disk = { value: 0 };
  let release: (() => void) | undefined;
  let announce: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    announce = resolve;
  });
  let delayRead = false;
  let saves = 0;
  const repository = new SerializedDataRepository({
    loadData: async () => {
      const snapshot = { ...disk };
      if (delayRead) {
        delayRead = false;
        await new Promise<void>((resolve) => {
          release = resolve;
          announce?.();
        });
      }
      return snapshot;
    },
    saveData: async (data) => {
      saves += 1;
      disk = data as typeof disk;
    },
  });
  await repository.read();
  delayRead = true;
  const refresh = repository.readFresh();
  await started;
  const write = repository.transact(() => ({ next: { value: 1 }, result: undefined }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const overlapped = saves > 0;
  release?.();
  await Promise.all([refresh, write]);
  assert.equal(overlapped, false, 'writes must wait until the fresh read completes');
  assert.deepEqual(await repository.read(), { value: 1 });
});
