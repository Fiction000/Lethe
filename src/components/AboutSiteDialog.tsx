import { showDialog } from './Dialog';
import '../less/about-site-dialog.less';
import React from 'react';
import Close from '../icons/close.svg?component';

interface Props extends DialogProps {}

const AboutSiteDialog: React.FC<Props> = ({ destroy }: Props) => {
  const handleCloseBtnClick = () => {
    destroy();
  };

  return (
    <>
      <div className="dialog-header-container">
        <p className="title-text">
          <span className="icon-text">🌊</span>About <b>Lethe</b>
        </p>
        <button className="btn close-btn" onClick={handleCloseBtnClick}>
          <Close className="icon-img" />
        </button>
      </div>
      <div className="dialog-content-container">
        <p>
          Lethe is a quick capture plugin for Obsidian.
        </p>
        <br />
        <p>
          Based on the <a href="https://github.com/justmemos/memos">memos</a> project.
        </p>
        <br />
        <p>
          Found an issue or have a suggestion?{' '}
          <a href="https://github.com/Fiction000/lethe/issues">Open an issue</a> or{' '}
          <a href="https://github.com/Fiction000/lethe/pulls">submit a PR</a>.
        </p>
      </div>
    </>
  );
};

export default function showAboutSiteDialog(): void {
  showDialog(
    {
      className: 'about-site-dialog',
    },
    AboutSiteDialog,
  );
}
