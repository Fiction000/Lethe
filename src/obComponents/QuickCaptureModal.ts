import { App, Modal, Notice } from 'obsidian';
import { memoService } from '../services';
import { MemoStorageMode } from '../memos';

/**
 * Quick Capture Modal - Minimal popup for instant memo capture
 * Opens with hotkey, saves with Enter, closes automatically
 */
export class QuickCaptureModal extends Modal {
  private inputEl: HTMLTextAreaElement;
  private tagInputEl: HTMLInputElement;
  private isTask: boolean = false;
  private selectedTags: string[] = [];
  private tagContainer: HTMLDivElement;
  private suggestionsEl: HTMLDivElement;
  private suggestions: string[] = [];
  private activeSuggestionIndex: number = 0;

  constructor(app: App) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('lethe-quick-capture');

    // Create minimal UI
    const container = contentEl.createDiv({ cls: 'quick-capture-container' });

    // Input area
    this.inputEl = container.createEl('textarea', {
      cls: 'quick-capture-input',
      attr: {
        placeholder: 'Capture your thought...',
        rows: '3',
      },
    });

    // Tag input (only for individual files mode)
    if (MemoStorageMode === 'individual-files') {
      const tagSection = container.createDiv({ cls: 'quick-capture-tags' });

      // Container for selected tag chips
      this.tagContainer = tagSection.createDiv({ cls: 'tag-chips' });

      // Tag input field
      this.tagInputEl = tagSection.createEl('input', {
        cls: 'tag-input',
        attr: {
          type: 'text',
          placeholder: 'Add tags...',
        },
      });

      // Suggestions dropdown - append to body to avoid modal resize
      this.suggestionsEl = document.body.createDiv({ cls: 'tag-suggestions hidden' });

      // Handle tag input
      this.tagInputEl.addEventListener('input', () => {
        this.updateSuggestions();
      });
      this.tagInputEl.addEventListener('keydown', (e) => this.handleTagInput(e));
      this.tagInputEl.addEventListener('blur', () => {
        // Delay to allow click on suggestion
        setTimeout(() => this.hideSuggestions(), 200);
      });
    }

    // Button row
    const buttonRow = container.createDiv({ cls: 'quick-capture-buttons' });

    // Task toggle
    const taskToggle = buttonRow.createEl('button', {
      cls: 'quick-capture-toggle',
      text: '☐ Task',
    });
    taskToggle.addEventListener('click', () => {
      this.isTask = !this.isTask;
      taskToggle.setText(this.isTask ? '☑ Task' : '☐ Task');
      taskToggle.toggleClass('is-active', this.isTask);
    });

    // Save button
    const saveBtn = buttonRow.createEl('button', {
      cls: 'quick-capture-save mod-cta',
      text: 'Save',
    });
    saveBtn.addEventListener('click', () => this.save());

    // Focus input
    this.inputEl.focus();

    // Handle keyboard shortcuts
    this.inputEl.addEventListener('keydown', (e) => {
      this.handleMainInputKeydown(e);
    });

    // Add styles
    this.addStyles();
  }

  private wrapSelection(textarea: HTMLTextAreaElement, wrapper: string, placeholder: string = '') {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selectedText = textarea.value.substring(start, end);
    const textToWrap = selectedText || placeholder;

    let wrappedText: string;
    let cursorOffset: number;

    // Handle different wrapper types
    if (wrapper === 'link') {
      wrappedText = `[${textToWrap}]()`;
      cursorOffset = wrappedText.length - 1; // Position cursor inside ()
    } else {
      wrappedText = `${wrapper}${textToWrap}${wrapper}`;
      cursorOffset = wrapper.length + textToWrap.length;
    }

    // Insert wrapped text
    textarea.value =
      textarea.value.substring(0, start) +
      wrappedText +
      textarea.value.substring(end);

    // Set cursor position
    if (selectedText) {
      // If text was selected, select the wrapped result
      textarea.selectionStart = start;
      textarea.selectionEnd = start + wrappedText.length;
    } else {
      // If no selection, position cursor appropriately
      textarea.selectionStart = textarea.selectionEnd = start + cursorOffset;
    }

    textarea.focus();
  }

  private handleMainInputKeydown(e: KeyboardEvent) {
    const isMod = e.metaKey || e.ctrlKey;
    const isShift = e.shiftKey;

    // Cmd/Ctrl + Enter to save
    if (e.key === 'Enter' && isMod) {
      e.preventDefault();
      this.save();
      return;
    }

    // Markdown formatting hotkeys
    if (isMod && !isShift) {
      switch (e.key.toLowerCase()) {
        case 'b': // Bold
          e.preventDefault();
          this.wrapSelection(this.inputEl, '**', 'bold text');
          return;
        case 'i': // Italic
          e.preventDefault();
          this.wrapSelection(this.inputEl, '*', 'italic text');
          return;
        case 'k': // Link
          e.preventDefault();
          this.wrapSelection(this.inputEl, 'link', 'link text');
          return;
        case 'e': // Inline code
          e.preventDefault();
          this.wrapSelection(this.inputEl, '`', 'code');
          return;
      }
    }

    // Cmd/Ctrl + Shift hotkeys
    if (isMod && isShift) {
      switch (e.key.toLowerCase()) {
        case 'x': // Strikethrough
          e.preventDefault();
          this.wrapSelection(this.inputEl, '~~', 'strikethrough');
          return;
      }
    }
  }

  private async save() {
    const content = this.inputEl.value.trim();
    if (!content) {
      new Notice('Cannot save empty memo');
      return;
    }

    try {
      const tags = MemoStorageMode === 'individual-files' ? this.selectedTags : undefined;
      const newMemo = await memoService.createMemo(content, this.isTask, tags);
      memoService.pushMemo(newMemo);
      new Notice('Captured!');
      this.close();
    } catch (error) {
      console.error('Failed to save memo:', error);
      new Notice('Failed to save memo');
    }
  }

  private handleTagInput(e: KeyboardEvent) {
    const suggestionsVisible = !this.suggestionsEl.hasClass('hidden');

    // Cmd/Ctrl + Enter to save memo (same as main input)
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      this.save();
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      if (suggestionsVisible && this.suggestions.length > 0) {
        // Select the active suggestion
        this.addTag(this.suggestions[this.activeSuggestionIndex]);
      } else {
        // Add typed value as new tag
        const tagValue = this.tagInputEl.value.trim().replace(/^#/, '');
        if (tagValue) {
          this.addTag(tagValue);
        }
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (suggestionsVisible && this.suggestions.length > 0) {
        this.activeSuggestionIndex = Math.min(
          this.activeSuggestionIndex + 1,
          this.suggestions.length - 1
        );
        this.renderSuggestions();
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (suggestionsVisible && this.suggestions.length > 0) {
        this.activeSuggestionIndex = Math.max(this.activeSuggestionIndex - 1, 0);
        this.renderSuggestions();
      }
    } else if (e.key === 'Escape') {
      if (suggestionsVisible) {
        e.stopPropagation(); // Don't close modal
        this.hideSuggestions();
      }
    } else if (e.key === 'Backspace' && this.tagInputEl.value === '' && this.selectedTags.length > 0) {
      // Remove last tag on backspace when input is empty
      this.selectedTags.pop();
      this.renderTagChips();
    }
  }

  private addTag(tag: string) {
    const cleanTag = tag.trim().replace(/^#/, '');
    if (cleanTag && !this.selectedTags.includes(cleanTag)) {
      this.selectedTags.push(cleanTag);
      this.renderTagChips();
      this.tagInputEl.value = '';
      this.hideSuggestions();
      this.tagInputEl.focus();
    }
  }

  private removeTag(tag: string) {
    this.selectedTags = this.selectedTags.filter((t) => t !== tag);
    this.renderTagChips();
  }

  private renderTagChips() {
    this.tagContainer.empty();
    this.selectedTags.forEach((tag) => {
      const chip = this.tagContainer.createDiv({ cls: 'tag-chip' });
      chip.createSpan({ text: `#${tag}` });
      const removeBtn = chip.createEl('button', {
        cls: 'tag-remove',
        text: '×',
      });
      removeBtn.addEventListener('click', () => this.removeTag(tag));
    });
  }

  private getAllVaultTags(): string[] {
    const allTags = new Set<string>();
    const metadataCache = this.app.metadataCache;
    const files = this.app.vault.getMarkdownFiles();

    files.forEach((file) => {
      const cache = metadataCache.getFileCache(file);

      // Get inline tags
      if (cache?.tags) {
        cache.tags.forEach((tag) => {
          const tagName = tag.tag.startsWith('#') ? tag.tag.slice(1) : tag.tag;
          allTags.add(tagName);
        });
      }

      // Get frontmatter tags
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

  private updateSuggestions() {
    // Safety check - only works in individual files mode
    if (!this.suggestionsEl) {
      return;
    }

    const inputValue = this.tagInputEl.value.trim().replace(/^#/, '');

    if (!inputValue) {
      this.hideSuggestions();
      return;
    }

    const allTags = this.getAllVaultTags();

    this.suggestions = allTags
      .filter((tag) =>
        tag.toLowerCase().includes(inputValue.toLowerCase()) &&
        !this.selectedTags.includes(tag)
      )
      .slice(0, 10); // Limit to 10 suggestions

    if (this.suggestions.length > 0) {
      this.activeSuggestionIndex = 0;
      // Remove hidden class and set display FIRST
      this.suggestionsEl.removeClass('hidden');
      this.suggestionsEl.style.display = 'block';
      // Then render content
      this.renderSuggestions();
    } else {
      this.hideSuggestions();
    }
  }

  private renderSuggestions() {
    if (!this.suggestionsEl) return;

    this.suggestionsEl.empty();

    // Position suggestions relative to input field
    const inputRect = this.tagInputEl.getBoundingClientRect();
    const left = inputRect.left;
    const top = inputRect.bottom + 4;
    const width = inputRect.width;

    // Force all positioning and visibility styles inline
    this.suggestionsEl.style.position = 'fixed';
    this.suggestionsEl.style.left = `${left}px`;
    this.suggestionsEl.style.top = `${top}px`;
    this.suggestionsEl.style.width = `${width}px`;
    this.suggestionsEl.style.minWidth = `${width}px`;
    this.suggestionsEl.style.zIndex = '10000';
    this.suggestionsEl.style.backgroundColor = 'var(--background-primary)';
    this.suggestionsEl.style.border = '1px solid var(--interactive-accent)';
    this.suggestionsEl.style.borderRadius = '6px'; // Modern rounded corners (--radius-md)
    this.suggestionsEl.style.maxHeight = '200px';
    this.suggestionsEl.style.overflowY = 'auto';
    this.suggestionsEl.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.12)'; // Modern subtle shadow (--shadow-md)

    this.suggestions.forEach((tag, index) => {
      const isActive = index === this.activeSuggestionIndex;
      const suggestionEl = this.suggestionsEl.createDiv({
        cls: `tag-suggestion ${isActive ? 'active' : ''}`,
      });

      // Set text (CSS ::before adds arrow for active items)
      suggestionEl.textContent = `#${tag}`;

      // Force active styles inline for visibility
      suggestionEl.style.padding = '10px 12px';
      suggestionEl.style.cursor = 'pointer';
      suggestionEl.style.borderLeft = '4px solid transparent';

      if (isActive) {
        // VERY visible active state
        suggestionEl.style.backgroundColor = 'var(--interactive-accent)';
        suggestionEl.style.color = 'var(--text-on-accent)';
        suggestionEl.style.fontWeight = '700';
        suggestionEl.style.borderLeftColor = 'var(--text-on-accent)';
      } else {
        suggestionEl.style.backgroundColor = 'transparent';
        suggestionEl.style.color = 'var(--text-normal)';
        suggestionEl.style.fontWeight = 'normal';
      }

      suggestionEl.addEventListener('click', () => {
        this.addTag(tag);
      });

      suggestionEl.addEventListener('mouseenter', () => {
        this.activeSuggestionIndex = index;
        this.renderSuggestions();
      });
    });
  }

  private hideSuggestions() {
    if (!this.suggestionsEl) return;

    this.suggestionsEl.addClass('hidden');
    this.suggestionsEl.style.display = 'none';
    this.suggestions = [];
    this.activeSuggestionIndex = 0;
  }

  private addStyles() {
    const styleEl = document.createElement('style');
    styleEl.id = 'lethe-quick-capture-styles';

    // Only add if not already present
    if (!document.getElementById(styleEl.id)) {
      styleEl.textContent = `
        .lethe-quick-capture {
          padding: 0;
        }
        .lethe-quick-capture .modal-content {
          padding: 0;
        }
        .quick-capture-container {
          padding: 16px;
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .quick-capture-input {
          width: 100%;
          min-width: 400px;
          resize: vertical;
          font-size: 14px;
          padding: 12px;
          border: 1px solid var(--background-modifier-border);
          border-radius: 6px;
          background: var(--background-primary);
          color: var(--text-normal);
        }
        .quick-capture-input:focus {
          outline: none;
          border-color: var(--interactive-accent);
          box-shadow: 0 0 0 3px rgba(var(--interactive-accent-rgb), 0.15);
        }
        .quick-capture-buttons {
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        .quick-capture-toggle {
          background: transparent;
          border: 1px solid var(--background-modifier-border);
          padding: 6px 12px;
          border-radius: 4px;
          cursor: pointer;
          color: var(--text-muted);
          transition: background-color 0.2s ease, border-color 0.2s ease, color 0.2s ease;
        }
        .quick-capture-toggle:hover {
          background: rgba(0, 0, 0, 0.05);
        }
        .quick-capture-toggle.is-active {
          background: var(--interactive-accent);
          color: var(--text-on-accent);
          border-color: var(--interactive-accent);
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
        }
        .quick-capture-save {
          padding: 8px 20px;
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
          transition: box-shadow 0.2s ease, transform 0.1s ease;
        }
        .quick-capture-save:hover {
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
          transform: translateY(-1px);
        }
        .quick-capture-save:active {
          transform: translateY(0);
        }
        .quick-capture-tags {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .tag-chips {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
        }
        .tag-chip {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding: 4px 8px;
          background: var(--interactive-accent);
          color: var(--text-on-accent);
          border-radius: 4px;
          font-size: 12px;
        }
        .tag-chip .tag-remove {
          background: none;
          border: none;
          color: var(--text-on-accent);
          font-size: 16px;
          line-height: 1;
          cursor: pointer;
          padding: 0;
          margin: 0;
        }
        .tag-chip .tag-remove:hover {
          opacity: 0.7;
        }
        .tag-input {
          width: 100%;
          padding: 8px;
          border: 1px solid var(--background-modifier-border);
          border-radius: 4px;
          background: var(--background-primary);
          color: var(--text-normal);
          font-size: 13px;
        }
        .tag-input:focus {
          outline: none;
          border-color: var(--interactive-accent);
        }
        .tag-suggestions {
          position: fixed;
          max-height: 200px;
          overflow-y: auto;
          background: var(--background-primary);
          border: 2px solid var(--interactive-accent);
          border-radius: 4px;
          z-index: 10000;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
        }
        .tag-suggestions.hidden {
          display: none;
        }
        .tag-suggestion {
          padding: 10px 12px;
          cursor: pointer;
          color: var(--text-normal);
          transition: none;
          border-left: 4px solid transparent;
        }
        .tag-suggestion:hover {
          background: var(--background-modifier-hover);
          border-left-color: var(--text-muted);
        }
        .tag-suggestion.active {
          background: var(--interactive-accent) !important;
          color: var(--text-on-accent) !important;
          font-weight: 700;
          border-left: 4px solid var(--text-on-accent);
          position: relative;
        }
        .tag-suggestion.active::before {
          content: '→ ';
          font-weight: 700;
          margin-right: 4px;
        }
      `;
      document.head.appendChild(styleEl);
    }
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
    // Clean up suggestions element from body
    if (this.suggestionsEl) {
      this.suggestionsEl.remove();
    }
  }
}
