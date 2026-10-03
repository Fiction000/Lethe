import React, { memo, useCallback, useContext } from 'react';
import {
  FIRST_TAG_REG,
  IMAGE_URL_REG,
  LINK_REG,
  MARKDOWN_URL_REG,
  MD_LINK_REG,
  MEMO_LINK_REG,
  TAG_REG,
  WIKI_IMAGE_URL_REG,
} from '../helpers/consts';
import { encodeHtml, parseMarkedToHtml, parseRawTextToHtml } from '../helpers/marked';
import utils from '../helpers/utils';
import useToggle from '../hooks/useToggle';
import { globalStateService, memoService, resourceService } from '../services';
import showMemoCardDialog from './MemoCardDialog';
import { sanitizeUnsafeAnchorHrefs } from '../helpers/timelineHtml';
import '../less/memo.less';
import { Notice } from 'obsidian';
import { showMemoInDailyNotes } from '../obComponents/obShowMemo';
import More from '../icons/more.svg?react';
import MemoImage from './MemoImage';
import appContext from '../stores/appContext';

interface Props {
  memo: Model.Memo;
}

const Memo: React.FC<Props> = (props: Props) => {
  const { globalState } = useContext(appContext);
  const { memo: propsMemo } = props;
  const [showConfirmDeleteBtn, toggleConfirmDeleteBtn] = useToggle(false);

  const handleShowMemoStoryDialog = () => {
    showMemoCardDialog(propsMemo);
  };

  const handleMarkMemoClick = () => {
    globalStateService.setMarkMemoId(propsMemo.id);
  };

  const handleEditMemoClick = () => {
    globalStateService.setEditMemoId(propsMemo.id);
  };

  const handleSourceMemoClick = (m: Model.Memo) => {
    showMemoInDailyNotes(m.id, m.path);
  };

  const handleDeleteMemoClick = async () => {
    if (showConfirmDeleteBtn) {
      try {
        await memoService.hideMemoById(propsMemo.id);
      } catch (error: any) {
        new Notice(error.message);
      }

      if (globalStateService.getState().editMemoId === propsMemo.id) {
        globalStateService.setEditMemoId('');
      }
    } else {
      toggleConfirmDeleteBtn();
    }
  };

  const handleMouseLeaveMemoWrapper = () => {
    if (showConfirmDeleteBtn) {
      toggleConfirmDeleteBtn(false);
    }
  };

  const handleMemoDoubleClick = useCallback((event: React.MouseEvent) => {
    if (event) {
      handleEditMemoClick();
    }
  }, []);

  const handleMemoContentClick = async (e: React.MouseEvent, m: Model.Memo) => {
    const targetEl = e.target as HTMLElement;

    if (e.ctrlKey || e.metaKey) {
      handleSourceMemoClick(m);
    }

    if (targetEl.className === 'memo-link-text') {
      const memoId = targetEl.dataset?.value;
      const memoTemp = memoService.getMemoById(memoId ?? '');

      if (memoTemp) {
        showMemoCardDialog(memoTemp);
      } else {
        new Notice('MEMO Not Found');
        targetEl.classList.remove('memo-link-text');
      }
    } else if (targetEl.className === 'todo-block') {
      // do nth
    }
  };

  const imageProps = {
    memo: propsMemo.content,
  };

  return (
    <div
      className={`memo-wrapper ${'memos-' + propsMemo.id} ${propsMemo.memoType}`}
      onMouseLeave={handleMouseLeaveMemoWrapper}
      draggable="true"
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', propsMemo.content.replace(/<br>/g, '\n'));
      }}
    >
      <div className="memo-top-wrapper">
        <div className="memo-top-left-wrapper">
          <span className="time-text" onClick={handleShowMemoStoryDialog}>
            {propsMemo.createdAt}
          </span>
        </div>
        <div className="memo-top-right-wrapper">
          <div className="btns-container">
            <span className="btn more-action-btn">
              <More className="icon-img" />
            </span>
            <div className="more-action-btns-wrapper">
              <div className="more-action-btns-container">
                <span className="btn" onClick={handleShowMemoStoryDialog}>
                  READ
                </span>
                <span className="btn" onClick={handleMarkMemoClick}>
                  MARK
                </span>
                <span className="btn" onClick={handleEditMemoClick}>
                  EDIT
                </span>
                <span className="btn" onClick={() => handleSourceMemoClick(propsMemo)}>
                  SOURCE
                </span>
                <span
                  className={`btn delete-btn ${showConfirmDeleteBtn ? 'final-confirm' : ''}`}
                  onClick={handleDeleteMemoClick}
                >
                  {showConfirmDeleteBtn ? 'CONFIRM!' : 'DELETE'}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div
        className="memo-content-text"
        onClick={(e) => handleMemoContentClick(e, propsMemo)}
        onDoubleClick={handleMemoDoubleClick}
        dangerouslySetInnerHTML={{ __html: formatMemoContent(propsMemo.content, propsMemo.id) }}
      ></div>
      <MemoImage {...imageProps} />
      {propsMemo.tags && propsMemo.tags.length > 0 && (
        <div className="memo-bottom-tags">
          {propsMemo.tags.map((tag) => (
            <span key={tag} className="memo-tag">#{tag}</span>
          ))}
        </div>
      )}
    </div>
  );
};

export function formatMemoContent(content: string, memoid?: string) {
  content = encodeHtml(content);
  content = parseRawTextToHtml(content)
    .split('<br>')
    .map((t) => {
      return `<p>${t !== '' ? t : '<br>'}</p>`;
    })
    .join('');

  const { shouldUseMarkdownParser, shouldHideImageUrl } = globalStateService.getState();

  if (shouldUseMarkdownParser) {
    content = parseMarkedToHtml(content, memoid);
  }

  if (shouldHideImageUrl) {
    content = content.replace(WIKI_IMAGE_URL_REG, '').replace(MARKDOWN_URL_REG, '').replace(IMAGE_URL_REG, '');
  }

  content = content
    .replace(TAG_REG, "<span class='tag-span'>#$1</span>")
    .replace(FIRST_TAG_REG, "<p><span class='tag-span'>#$2</span>")
    .replace(LINK_REG, "$1<a class='link' target='_blank' rel='noreferrer' href='$2'>$2</a>")
    .replace(MD_LINK_REG, "<a class='link' target='_blank' rel='noreferrer' href='$2'>$1</a>")
    .replace(MEMO_LINK_REG, "<span class='memo-link-text' data-value='$2'>$1</span>")
    .replace(/\^\S{6}/g, '');

  const tempDivContainer = document.createElement('div');
  tempDivContainer.innerHTML = content;
  sanitizeUnsafeAnchorHrefs(tempDivContainer.querySelectorAll('a'));
  for (let i = 0; i < tempDivContainer.children.length; i++) {
    const c = tempDivContainer.children[i];

    if (c.tagName === 'P' && c.textContent === '' && c.firstElementChild?.tagName !== 'BR') {
      c.remove();
      i--;
      continue;
    }
  }

  return tempDivContainer.innerHTML;
}

export default memo(Memo);
