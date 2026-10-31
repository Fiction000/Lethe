export interface NativeCommandRegistry {
  findCommand(id: string): unknown;
  executeCommandById(id: string): boolean;
}

export type NativeNoteSearch = 'global-search:open' | 'switcher:open' | undefined;

export function availableNativeNoteSearch(commands: NativeCommandRegistry): NativeNoteSearch {
  if (commands.findCommand('global-search:open')) return 'global-search:open';
  if (commands.findCommand('switcher:open')) return 'switcher:open';
  return undefined;
}

export function openNativeNoteSearch(commands: NativeCommandRegistry): boolean {
  const command = availableNativeNoteSearch(commands);
  if (!command) return false;
  try {
    return commands.executeCommandById(command);
  } catch {
    return false;
  }
}
