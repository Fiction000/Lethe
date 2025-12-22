import { App, Modal, Notice } from 'obsidian';
import { memoService } from '../services';

/**
 * Quick Capture Modal - Minimal popup for instant memo capture
 * Opens with hotkey, saves with Enter, closes automatically
 */
export class QuickCaptureModal extends Modal {
  private inputEl: HTMLTextAreaElement;
  private isTask: boolean = false;

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
      // Ctrl/Cmd + Enter to save
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.save();
      }
      // Escape to close (handled by Modal automatically)
    });

    // Add styles
    this.addStyles();
  }

  private async save() {
    const content = this.inputEl.value.trim();
    if (!content) {
      new Notice('Cannot save empty memo');
      return;
    }

    try {
      const newMemo = await memoService.createMemo(content, this.isTask);
      memoService.pushMemo(newMemo);
      new Notice('Captured!');
      this.close();
    } catch (error) {
      console.error('Failed to save memo:', error);
      new Notice('Failed to save memo');
    }
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
        }
        .quick-capture-toggle.is-active {
          background: var(--interactive-accent);
          color: var(--text-on-accent);
          border-color: var(--interactive-accent);
        }
        .quick-capture-save {
          padding: 8px 20px;
        }
      `;
      document.head.appendChild(styleEl);
    }
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
