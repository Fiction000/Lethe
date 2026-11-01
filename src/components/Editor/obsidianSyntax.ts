import { $markSchema, $prose, $remark } from '@milkdown/kit/utils';
import { Plugin } from '@milkdown/kit/prose/state';
import type { RemarkPluginRaw } from '@milkdown/kit/transformer';

import { syntaxSpans } from './obsidianTokens';
import type { SyntaxKind } from './obsidianTokens';

type SyntaxNode = {
  type: string;
  kind?: SyntaxKind;
  value?: string;
  children?: SyntaxNode[];
  position?: { start?: { offset?: number } };
};

const tagCharacter = /^[\p{L}\p{N}_/-]$/u;

type Code = number | null;
type Step = (code: Code) => Step | void;
type Effects = { enter(name: string): void; exit(name: string): void; consume(code: Code): void };
type CompileContext = {
  enter(node: SyntaxNode, token: object): void;
  exit(token: object): SyntaxNode;
  sliceSerialize(token: object): string;
};

// Explicit tokens retain escape intent before CommonMark decodes backslashes.
function tokenize(this: { previous: Code }, effects: Effects, ok: Step, nok: Step): Step {
  const previous = this.previous;
  let raw = '';
  const prefixes = ['[[', '![[', '[!', '\\[[', '\\[\\[', '\\![[', '\\#', '#'];
  function finish(code: Code) {
    const decoded = raw.replace(/\\(.)/g, (match, character: string) =>
      '[]#!'.includes(character) ? character : match,
    );
    const spans = syntaxSpans(decoded, { blockquoteStart: true });
    if (spans.length !== 1 || spans[0].from !== 0 || spans[0].to !== decoded.length) return nok(code);
    if (spans[0].kind === 'callout' && !raw.startsWith('\\\\')) return nok(code);
    effects.exit('letheObsidian');
    return ok(code);
  }
  function consume(code: Code): Step | void {
    if (code === null || code < 0) return finish(code);
    const character = String.fromCodePoint(code);
    const isTag = raw.startsWith('#') || raw.startsWith('\\#');
    if (isTag && !tagCharacter.test(character)) return finish(code);
    const next = raw + character;
    if (!isTag && !prefixes.some((prefix) => prefix.startsWith(next) || next.startsWith(prefix))) return nok(code);
    effects.consume(code);
    raw = next;
    const decoded = raw.replace(/\\(.)/g, (match, character: string) =>
      '[]#!'.includes(character) ? character : match,
    );
    if (!isTag && (decoded.startsWith('[!') ? decoded.endsWith(']') : decoded.endsWith(']]'))) return finish;
    return consume;
  }
  return function start(code) {
    if (code === 35 && previous !== null && previous >= 0 && /[\p{L}\p{N}_/\\#]/u.test(String.fromCodePoint(previous)))
      return nok(code);
    effects.enter('letheObsidian');
    return consume(code);
  };
}

export const obsidianRemark = $remark('letheObsidian', () => {
  const plugin: RemarkPluginRaw<unknown> = function () {
    const data = this.data() as Record<string, unknown[]>;
    const construct = { name: 'letheObsidian', tokenize };
    (data.micromarkExtensions ??= []).push({ text: { 33: construct, 35: construct, 91: construct, 92: construct } });
    (data.fromMarkdownExtensions ??= []).push({
      enter: {
        letheObsidian(this: CompileContext, token: object) {
          const raw = this.sliceSerialize(token);
          const value = raw.replace(/\\(.)/g, (match, character: string) =>
            '[]#!'.includes(character) ? character : match,
          );
          const kind = raw.startsWith('\\') ? 'literal' : syntaxSpans(value)[0].kind;
          this.enter({ type: 'letheObsidian', kind, children: [{ type: 'text', value }] }, token);
        },
      },
      exit: {
        letheObsidian(this: CompileContext, token: object) {
          this.exit(token);
        },
      },
    });
    (data.toMarkdownExtensions ??= []).push({
      handlers: {
        letheObsidian(
          node: SyntaxNode,
          _parent: unknown,
          state: { containerPhrasing(node: SyntaxNode, info: unknown): string },
          info: unknown,
        ) {
          if (!node.children?.every((child) => child.type === 'text')) return state.containerPhrasing(node, info);
          const value = node.children.map((child) => child.value ?? '').join('');
          if (node.kind === 'literal') return value.startsWith('\\') ? value : `\\${value}`;
          const spans = syntaxSpans(value, { blockquoteStart: node.kind === 'callout' });
          if (spans.length === 1 && spans[0].from === 0 && spans[0].to === value.length && spans[0].kind === node.kind)
            return value;
          return state.containerPhrasing(node, info);
        },
      },
    });
    return (tree, file) => {
      const source = String((file as { value?: unknown }).value ?? '');
      function protectDecodedLiterals(node: SyntaxNode, blockquoteStart = false) {
        if (!node.children || node.type === 'letheObsidian') return;
        node.children = node.children.flatMap((child, index) => {
          const childIsCalloutStart = node.type === 'blockquote' && index === 0 && child.type === 'paragraph';
          if (child.type !== 'text' || !child.value) {
            protectDecodedLiterals(child, childIsCalloutStart);
            return [child];
          }
          const sourceOffset = child.position?.start?.offset;
          const literalCalloutStart = sourceOffset !== undefined && source.startsWith('[!', sourceOffset);
          const spans = syntaxSpans(child.value, { blockquoteStart: blockquoteStart && index === 0 });
          const children: SyntaxNode[] = [];
          let offset = 0;
          for (const span of spans) {
            if (span.from > offset) children.push({ type: 'text', value: child.value.slice(offset, span.from) });
            children.push({
              type: 'letheObsidian',
              kind: span.kind === 'callout' && literalCalloutStart ? 'callout' : 'literal',
              children: [{ type: 'text', value: child.value.slice(span.from, span.to) }],
            });
            offset = span.to;
          }
          if (offset < child.value.length) children.push({ type: 'text', value: child.value.slice(offset) });
          return children;
        });
      }
      protectDecodedLiterals(tree as SyntaxNode);
    };
  };
  return plugin;
});

export const obsidianMark = $markSchema('letheObsidian', () => ({
  attrs: { kind: { default: 'wiki' } },
  inclusive: false,
  priority: 100,
  parseDOM: [
    {
      tag: 'span[data-lethe-syntax]',
      getAttrs: (dom: HTMLElement) => ({ kind: dom.getAttribute('data-lethe-syntax') }),
    },
  ],
  toDOM: (mark) => [
    'span',
    { 'data-lethe-syntax': mark.attrs.kind, class: `lethe-syntax lethe-syntax-${mark.attrs.kind}` },
    0,
  ],
  parseMarkdown: {
    match: (node) => node.type === 'letheObsidian',
    runner: (state, node, type) => {
      state.openMark(type, { kind: node.kind });
      state.next(node.children);
      state.closeMark(type);
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === 'letheObsidian',
    runner: (state, mark) => {
      state.withMark(mark, 'letheObsidian', undefined, { kind: mark.attrs.kind });
    },
  },
}));

export const obsidianTyping = $prose(
  () =>
    new Plugin({
      appendTransaction(transactions, _old, state) {
        if (!transactions.some((transaction) => transaction.docChanged)) return null;
        const type = state.schema.marks.letheObsidian;
        const tr = state.tr;
        state.doc.descendants((block, blockPosition, parent, index) => {
          if (!block.isTextblock || block.type.spec.code) return;
          const text = block.textBetween(0, block.content.size, '', '\ufffc');
          const blockquoteStart = parent.type.name === 'blockquote' && index === 0;
          for (const span of syntaxSpans(text, { blockquoteStart })) {
            const from = blockPosition + 1 + span.from;
            const to = blockPosition + 1 + span.to;
            let protectedRange = false;
            let alreadyMarked = true;
            state.doc.nodesBetween(from, to, (node) => {
              if (!node.isText) return;
              if (
                node.marks.some((mark) => mark.type.spec.code || (mark.type === type && mark.attrs.kind === 'literal'))
              )
                protectedRange = true;
              if (!node.marks.some((mark) => mark.type === type && mark.attrs.kind === span.kind))
                alreadyMarked = false;
            });
            if (!protectedRange && !alreadyMarked) tr.addMark(from, to, type.create({ kind: span.kind }));
          }
          return false;
        });
        return tr.steps.length ? tr.setMeta('addToHistory', false) : null;
      },
    }),
);

export const obsidianSyntax = [obsidianRemark, obsidianMark, obsidianTyping].flat();
