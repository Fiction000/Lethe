import { autocompletion, CompletionContext, CompletionResult, Completion } from '@codemirror/autocomplete';
import { EditorView } from '@codemirror/view';
import { getSuggestions } from '../../obComponents/obFileSuggester';
import appStore from '../../stores/appStore';

/**
 * Get all tags from the vault's metadata cache (same source as TagInput)
 */
function getVaultTags(): string[] {
  const app = appStore.getState().dailyNotesState?.app;
  if (!app) return [];

  const allTags = new Set<string>();
  const files = app.vault.getMarkdownFiles();

  files.forEach((file) => {
    const cache = app.metadataCache.getFileCache(file);
    if (cache?.tags) {
      cache.tags.forEach((tag) => {
        const tagName = tag.tag.startsWith('#') ? tag.tag.slice(1) : tag.tag;
        allTags.add(tagName);
      });
    }
    if (cache?.frontmatter?.tags) {
      const fmTags = cache.frontmatter.tags;
      if (Array.isArray(fmTags)) {
        fmTags.forEach((tag) => {
          const tagName = typeof tag === 'string' ? tag : String(tag);
          allTags.add(tagName.replace(/^#/, ''));
        });
      }
    }
  });

  return Array.from(allTags).sort();
}

/**
 * Tag completion — triggered by #
 */
function tagCompletion(context: CompletionContext): CompletionResult | null {
  const match = context.matchBefore(/#[^\s]*/);
  if (!match) return null;
  if (match.text.length < 1) return null;

  const query = match.text.slice(1).toLowerCase();
  const allTags = getVaultTags();
  const filtered = allTags.filter((tag) => tag.toLowerCase().includes(query)).slice(0, 15);

  if (filtered.length === 0) return null;

  const options: Completion[] = filtered.map((tag) => ({
    label: `#${tag}`,
    apply: `#${tag} `,
    type: 'keyword',
  }));

  return {
    from: match.from,
    options,
    filter: false,
  };
}

/**
 * File/wiki link completion — triggered by [[
 */
function fileLinkCompletion(context: CompletionContext): CompletionResult | null {
  // Match [[ followed by optional text (no closing ]])
  const match = context.matchBefore(/\[\[[^\]]*$/);
  if (!match) return null;

  const query = match.text.slice(2); // Remove the [[
  const suggestions = getSuggestions('[' + query).slice(0, 10);

  if (suggestions.length === 0) return null;

  const app = appStore.getState().dailyNotesState?.app;
  if (!app) return null;
  const { fileManager } = app;

  const options: Completion[] = suggestions.map((s: { name: string; char: string; file: any }) => ({
    label: s.name,
    displayLabel: s.name,
    apply: (view: EditorView, _completion: Completion, _from: number, to: number) => {
      // Generate the full markdown link
      const filePath = fileManager.generateMarkdownLink(s.file, s.file.path, '', '');

      // Replace from [[ to current position
      view.dispatch({
        changes: { from: match.from, to, insert: filePath },
      });
    },
    type: 'text',
  }));

  return {
    from: match.from,
    options,
    filter: false,
  };
}

/**
 * CM6 autocompletion extension with tag and file link completions
 */
export const editorAutocompletion = autocompletion({
  override: [tagCompletion, fileLinkCompletion],
  defaultKeymap: true,
  icons: false,
  activateOnTyping: true,
  interactionDelay: 0,
});
