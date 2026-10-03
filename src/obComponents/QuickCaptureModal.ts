import React from 'react';
import ReactDOM from 'react-dom';
import { App, Modal } from 'obsidian';
import { MemoStorageMode } from '../memos';
import CaptureComposer from '../components/CaptureComposer';
import LegacyMemoEditor from '../components/LegacyMemoEditor';
import Provider from '../labs/Provider';
import appContext from '../stores/appContext';
import appStore from '../stores/appStore';

/** Quick Capture uses the same writing surface as Lethe's main view. */
export class QuickCaptureModal extends Modal {
  private rootEl?: HTMLDivElement;

  public constructor(app: App) {
    super(app);
  }

  public onOpen(): void {
    this.contentEl.addClass('lethe-quick-capture');
    this.rootEl = this.contentEl.createDiv({ cls: 'lethe-quick-capture-root' });

    // Daily Notes mode remains on the established writer. The structured
    // composer is used for individual-file captures and shares its session
    // runtime with the main Lethe view.
    const child =
      MemoStorageMode === 'daily-notes'
        ? React.createElement(LegacyMemoEditor, { forceNew: true })
        : React.createElement(CaptureComposer, { surface: 'quick' });
    const tree = React.createElement(Provider, { store: appStore, context: appContext, children: child });

    ReactDOM.render(tree, this.rootEl);
  }

  public onClose(): void {
    if (this.rootEl) {
      ReactDOM.unmountComponentAtNode(this.rootEl);
      this.rootEl.remove();
      this.rootEl = undefined;
    }
    this.contentEl.empty();
  }
}
