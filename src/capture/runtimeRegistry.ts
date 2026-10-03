import type { CaptureRuntime } from './runtime';

let captureRuntime: CaptureRuntime | undefined;

export function getCaptureRuntime(): CaptureRuntime | undefined {
  return captureRuntime;
}

export function setCaptureRuntime(runtime: CaptureRuntime | undefined): void {
  captureRuntime = runtime;
}
