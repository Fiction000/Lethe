import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';

/**
 * CM6 base theme — quiet editorial input, no hard borders.
 */
export const obsidianEditorTheme = EditorView.theme({
  '&': {
    width: '100%',
    fontSize: 'var(--font-size-base)',
    backgroundColor: 'transparent',
    color: 'var(--color-fg)',
    border: 'none',
    borderRadius: '0',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-content': {
    padding: 'var(--spacing-sm) 0',
    fontFamily: 'inherit',
    lineHeight: '1.65',
    caretColor: 'var(--color-fg)',
    minHeight: '80px',
  },
  '.cm-content[contenteditable=true]': {
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  '.cm-line': {
    padding: '0',
  },
  '.cm-cursor': {
    borderLeftColor: 'var(--color-fg)',
  },
  '.cm-selectionBackground': {
    backgroundColor: 'var(--color-accent) !important',
    opacity: '0.15',
  },
  '&.cm-focused .cm-selectionBackground': {
    backgroundColor: 'var(--color-accent) !important',
    opacity: '0.2',
  },
  '.cm-placeholder': {
    color: 'var(--color-muted)',
    paddingLeft: '0',
  },
  '.cm-scroller': {
    overflow: 'auto',
    maxHeight: '300px',
  },
  // Autocomplete dropdown
  '.cm-tooltip-autocomplete': {
    backgroundColor: 'var(--color-bg)',
    border: '1px solid var(--color-separator)',
    borderRadius: 'var(--radius-md)',
    boxShadow: 'var(--shadow-lg)',
  },
  '.cm-tooltip-autocomplete ul li': {
    padding: '4px 8px',
    color: 'var(--color-fg)',
    fontSize: 'var(--font-size-sm)',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: 'var(--color-surface)',
    color: 'var(--color-accent)',
  },
});

/**
 * Syntax highlighting for markdown tokens.
 */
export const obsidianHighlightStyle = syntaxHighlighting(
  HighlightStyle.define([
    // Headers
    { tag: tags.heading1, fontSize: '1.5em', fontWeight: '600', lineHeight: '1.3' },
    { tag: tags.heading2, fontSize: '1.3em', fontWeight: '600', lineHeight: '1.3' },
    { tag: tags.heading3, fontSize: '1.15em', fontWeight: '600', lineHeight: '1.3' },
    { tag: tags.heading4, fontSize: '1.05em', fontWeight: '600' },
    { tag: tags.heading5, fontSize: '1em', fontWeight: '600' },
    { tag: tags.heading6, fontSize: '1em', fontWeight: '600' },
    // Emphasis
    { tag: tags.strong, fontWeight: 'bold' },
    { tag: tags.emphasis, fontStyle: 'italic' },
    { tag: tags.strikethrough, textDecoration: 'line-through', color: 'var(--color-muted)' },
    // Code
    {
      tag: tags.monospace,
      fontFamily: 'var(--font-mono)',
      backgroundColor: 'var(--color-surface)',
      borderRadius: '3px',
      padding: '1px 4px',
    },
    // Links
    { tag: tags.link, color: 'var(--color-accent)', textDecoration: 'underline' },
    { tag: tags.url, color: 'var(--color-accent)', opacity: '0.7' },
    // Meta / syntax markers
    { tag: tags.processingInstruction, color: 'var(--color-muted)', opacity: '0.5' },
    { tag: tags.meta, color: 'var(--color-muted)', opacity: '0.5' },
    // Quotes
    {
      tag: tags.quote,
      color: 'var(--color-muted)',
      fontStyle: 'italic',
      borderLeft: '2px solid var(--color-separator)',
      paddingLeft: '8px',
    },
    // Lists
    { tag: tags.list, color: 'var(--color-accent)' },
    // Content separator
    { tag: tags.contentSeparator, color: 'var(--color-muted)' },
  ]),
);
