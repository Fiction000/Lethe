export type ProfileRadioKey = 'ArrowRight' | 'ArrowDown' | 'ArrowLeft' | 'ArrowUp' | 'Home' | 'End' | string;

export interface SendShortcutLabels {
  readonly key: string;
  readonly title: string;
}

export function getProfileRadioNextIndex(
  currentIndex: number,
  key: ProfileRadioKey,
  optionCount: number,
): number | undefined {
  if (optionCount <= 0) return undefined;
  if (key === 'Home') return 0;
  if (key === 'End') return optionCount - 1;
  if (key === 'ArrowRight' || key === 'ArrowDown') return (currentIndex + 1 + optionCount) % optionCount;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (currentIndex - 1 + optionCount) % optionCount;
  return undefined;
}

export function getSendShortcutLabels(isMacOS: boolean): SendShortcutLabels {
  return isMacOS ? { key: '⌘↵', title: 'Send (⌘+Enter)' } : { key: 'Ctrl↵', title: 'Send (Ctrl+Enter)' };
}
