import React, { useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import appContext from '../stores/appContext';
import { dailyNotesService, globalStateService, locationService, memoService, resourceService } from '../services';
import utils from '../helpers/utils';
import { storage } from '../helpers/storage';
import Editor, { EditorRefActions } from './Editor/Editor';
import '../less/memo-editor.less';
import '../less/select-date-picker.less';
import { usePopper } from 'react-popper';
import useState from 'react-usestateref';
import DatePicker from './common/DatePicker';
import { TagInput } from './common/TagInput';
import { moment, Notice, Platform } from 'obsidian';
import { DefaultPrefix, FocusOnEditor, MemoStorageMode } from '../memos';
import useToggle from '../hooks/useToggle';
import { MEMOS_VIEW_TYPE } from '../constants';

const getCursorPostion = (input: HTMLTextAreaElement) => {
  const {
    offsetLeft: inputX,
    offsetTop: inputY,
    offsetHeight: inputH,
    offsetWidth: inputW,
    selectionEnd: selectionPoint,
  } = input;
  const div = document.createElement('div');

  const copyStyle = window.getComputedStyle(input);
  for (const item of copyStyle) {
    div.style.setProperty(item, copyStyle.getPropertyValue(item));
  }
  div.style.position = 'fixed';
  div.style.visibility = 'hidden';
  div.style.whiteSpace = 'pre-wrap';

  // we need a character that will replace whitespace when filling our dummy element if it's a single line <input/>
  const swap = '.';
  const inputValue = input.tagName === 'INPUT' ? input.value.replace(/ /g, swap) : input.value;
  div.textContent = inputValue.substring(0, selectionPoint || 0);
  if (input.tagName === 'TEXTAREA') {
    div.style.height = 'auto';
  }

  const span = document.createElement('span');
  span.textContent = inputValue.substring(selectionPoint || 0) || '.';
  div.appendChild(span);
  document.body.appendChild(div);
  const { offsetLeft: spanX, offsetTop: spanY, offsetHeight: spanH, offsetWidth: spanW } = span;
  document.body.removeChild(div);
  return {
    x: inputX + spanX,
    y: inputY + spanY,
    h: inputH + spanH,
    w: inputW + spanW,
  };
};

interface Props {}

let isList: boolean;
let isEditor = false as boolean;
let isEditorGo = false as boolean;
let positionX: number;

const MemoEditor: React.FC<Props> = () => {
  const { globalState } = useContext(appContext);
  const app = dailyNotesService.getState()?.app;

  const [isListShown, toggleList] = useToggle(false);
  const [isEditorShown, toggleEditor] = useState(false);

  const editorRef = useRef<EditorRefActions>(null);
  const prevGlobalStateRef = useRef(globalState);

  // const [selected, setSelected] = useState<Date>();
  const [isDatePickerOpen, setIsDatePickerOpen] = useState(false);

  const popperRef = useRef<HTMLDivElement>(null);
  const [popperElement, setPopperElement] = useState(null);
  const [currentDateStamp] = useState(parseInt(moment().format('x')));
  const [selectedTags, setSelectedTags] = useState<string[]>([]);

  // const [showDatePicker, toggleShowDatePicker] = useToggle(false);

  useEffect(() => {
    if (!editorRef.current) {
      return;
    }

    if (DefaultPrefix === 'List') {
      isList = false;
      toggleList(false);
    } else {
      isList = true;
      toggleList(true);
    }

    isEditor = false;

    // editorRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!editorRef.current) {
      return;
    }

    if (FocusOnEditor) {
      editorRef.current?.focus();
    }
  }, []);

  // Change Date Picker Popper Position
  const setPopper = () => {
    let popperTemp;

    if (!Platform.isMobile) {
      popperTemp = usePopper(popperRef.current, popperElement, {
        placement: 'right-end',
        modifiers: [
          {
            name: 'flip',
            options: {
              allowedAutoPlacements: ['bottom'],
              rootBoundary: 'document', // by default, all the placements are allowed
            },
          },
        ],
      });
    } else if (Platform.isMobile) {
      const seletorPopupWidth = 280;
      if (window.innerWidth - positionX > seletorPopupWidth * 1.2) {
        popperTemp = usePopper(popperRef.current, popperElement, {
          placement: 'right-end',
          modifiers: [
            {
              name: 'flip',
              options: {
                allowedAutoPlacements: ['left-end'],
                rootBoundary: 'document', // by default, all the placements are allowed
              },
            },
            {
              name: 'preventOverflow',
              options: {
                rootBoundary: 'document',
              },
            },
          ],
        });
      } else if (window.innerWidth - positionX < seletorPopupWidth && window.innerWidth > seletorPopupWidth * 1.5) {
        popperTemp = usePopper(popperRef.current, popperElement, {
          placement: 'left-end',
          modifiers: [
            {
              name: 'flip',
              options: {
                allowedAutoPlacements: ['right-end'],
                rootBoundary: 'document', // by default, all the placements are allowed
              },
            },
            {
              name: 'preventOverflow',
              options: {
                rootBoundary: 'document',
              },
            },
          ],
        });
      } else {
        popperTemp = usePopper(popperRef.current, popperElement, {
          placement: 'bottom',
          modifiers: [
            {
              name: 'flip',
              options: {
                allowedAutoPlacements: ['bottom'],
                rootBoundary: 'document', // by default, all the placements are allowed
              },
            },
            {
              name: 'preventOverflow',
              options: {
                rootBoundary: 'document',
              },
            },
          ],
        });
      }
    }

    return popperTemp;
  };
  const popper = setPopper();

  const closePopper = () => {
    setIsDatePickerOpen(false);
    // buttonRef?.current?.focus();
  };

  useEffect(() => {
    if (globalState.markMemoId) {
      const editorCurrentValue = editorRef.current?.getContent();
      const memoLinkText = `${editorCurrentValue ? '\n' : ''}MARK: [@MEMO](${globalState.markMemoId})`;
      editorRef.current?.insertText(memoLinkText);
      globalStateService.setMarkMemoId('');
    }

    if (globalState.editMemoId && globalState.editMemoId !== prevGlobalStateRef.current.editMemoId) {
      const editMemo = memoService.getMemoById(globalState.editMemoId);
      if (editMemo) {
        editorRef.current?.setContent(editMemo.content.replace(/<br>/g, '\n').replace(/ \^\S{6}$/, '') ?? '');
        editorRef.current?.focus();
      }
    }

    prevGlobalStateRef.current = globalState;
  }, [globalState.markMemoId, globalState.editMemoId]);

  useEffect(() => {
    if (!editorRef.current) {
      return;
    }

    // new TagsSuggest(app, editorRef.current.element);

    const handlePasteEvent = async (event: ClipboardEvent) => {
      if (event.clipboardData && event.clipboardData.files.length > 0) {
        event.preventDefault();
        const file = event.clipboardData.files[0];
        const url = await handleUploadFile(file);
        if (url) {
          editorRef.current?.insertText(url);
        }
      }
    };

    const handleDropEvent = async (event: DragEvent) => {
      if (event.dataTransfer && event.dataTransfer.files.length > 0) {
        event.preventDefault();
        const file = event.dataTransfer.files[0];
        const url = await handleUploadFile(file);
        if (url) {
          editorRef.current?.insertText(url);
        }
      }
    };

    const handleClickEvent = () => {
      handleContentChange(editorRef.current?.element.value ?? '');
    };

    const handleKeyDownEvent = () => {
      setTimeout(() => {
        handleContentChange(editorRef.current?.element.value ?? '');
      });
    };

    editorRef.current.element.addEventListener('paste', handlePasteEvent);
    editorRef.current.element.addEventListener('drop', handleDropEvent);
    editorRef.current.element.addEventListener('click', handleClickEvent);
    editorRef.current.element.addEventListener('keydown', handleKeyDownEvent);

    return () => {
      editorRef.current?.element.removeEventListener('paste', handlePasteEvent);
      editorRef.current?.element.removeEventListener('drop', handleDropEvent);
    };
  }, [editorRef.current]);

  const handleUploadFile = useCallback(async (file: File) => {
    const { type } = file;

    if (!type.startsWith('image')) {
      return;
    }

    try {
      const image = await resourceService.upload(file);
      return `${image}`;
    } catch (error: any) {
      new Notice(error);
    }
  }, []);

  const handleSaveBtnClick = useCallback(async (content: string) => {
    if (content === '') {
      new Notice('Content cannot be empty');
      return;
    }

    const { editMemoId } = globalStateService.getState();
    content = content.replaceAll('&nbsp;', ' ');

    // Clear editor immediately for speed perception
    setEditorContentCache('');
    editorRef.current?.setContent('');

    try {
      if (editMemoId) {
        const prevMemo = memoService.getMemoById(editMemoId);
        content = content + (prevMemo.hasId === '' ? '' : ' ^' + prevMemo.hasId);
        if (prevMemo && prevMemo.content !== content) {
          const editedMemo = await memoService.updateMemo(
            prevMemo.id,
            prevMemo.content,
            content,
            prevMemo.memoType,
            prevMemo.path,
          );
          editedMemo.updatedAt = utils.getDateTimeString(Date.now());
          memoService.editMemo(editedMemo);
        }
        globalStateService.setEditMemoId('');
      } else {
        const newMemo = await memoService.createMemo(content, isList, selectedTags);
        memoService.pushMemo(newMemo);
        locationService.clearQuery();
        setSelectedTags([]); // Clear tags after successful save
      }
    } catch (error: any) {
      new Notice(error.message);
    }
  }, [selectedTags]);

  const handleCancelBtnClick = useCallback(() => {
    globalStateService.setEditMemoId('');
    editorRef.current?.setContent('');
    setEditorContentCache('');
  }, []);

  const handleContentChange = useCallback((content: string) => {
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = content;
    if (tempDiv.innerText.trim() === '') {
      content = '';
    }
    setEditorContentCache(content);

    if (!editorRef.current) {
      return;
    }

    const currentValue = editorRef.current.getContent();
    const selectionStart = editorRef.current.element.selectionStart;
    const prevString = currentValue.slice(0, selectionStart);
    const nextString = currentValue.slice(selectionStart);

    if ((prevString.endsWith('@') || prevString.endsWith('📆')) && nextString.startsWith(' ')) {
      updateDateSelectorPopupPosition();
      setIsDatePickerOpen(true);
    } else if ((prevString.endsWith('@') || prevString.endsWith('📆')) && nextString === '') {
      updateDateSelectorPopupPosition();
      setIsDatePickerOpen(true);
    } else {
      setIsDatePickerOpen(false);
    }

    setTimeout(() => {
      editorRef.current?.focus();
    });
  }, []);

  // const handleKeyPress = () => {
  //   console.log(handleKeyPress);
  // };

  const handleDateInsertTrigger = (date: number) => {
    if (!editorRef.current) {
      return;
    }

    if (date) {
      closePopper();
      isList = true;
      toggleList(true);
    }

    const currentValue = editorRef.current.getContent();
    const selectionStart = editorRef.current.element.selectionStart;
    const prevString = currentValue.slice(0, selectionStart);
    const nextString = currentValue.slice(selectionStart);
    const todayMoment = moment(date);

    if (!prevString.endsWith('@')) {
      editorRef.current.element.value =
        //eslint-disable-next-line
        prevString + todayMoment.format('YYYY-MM-DD') + nextString;
      editorRef.current.element.setSelectionRange(selectionStart + 10, selectionStart + 10);
      editorRef.current.focus();
      handleContentChange(editorRef.current.element.value);
      return;
    } else {
      // Hardcoded to 'Tasks' format (📆 emoji)
      editorRef.current.element.value =
        //eslint-disable-next-line
        currentValue.slice(0, editorRef.current.element.selectionStart - 1) +
        '📆' +
        todayMoment.format('YYYY-MM-DD') +
        nextString;
      editorRef.current.element.setSelectionRange(selectionStart + 11, selectionStart + 11);
      editorRef.current.focus();
      handleContentChange(editorRef.current.element.value);
    }
  };

  // Toggle List OR TASK
  const handleChangeStatus = () => {
    if (!editorRef.current) {
      return;
    }

    if (isList) {
      isList = false;
      toggleList(false);
    } else {
      isList = true;
      toggleList(true);
    }
  };

  const handleShowEditor = (flag?: boolean) => {
    if (!editorRef.current) {
      return;
    }

    // Use flag to toggle editor show/hide
    if (isEditor || flag === true) {
      isEditor = false;
      toggleEditor(true);
    } else {
      isEditor = true;
      isEditorGo = false;
      toggleEditor(false);
    }
  };

  const updateDateSelectorPopupPosition = useCallback(() => {
    if (!editorRef.current || !popperRef.current || !app) {
      return;
    }

    const leaves = app.workspace.getLeavesOfType(MEMOS_VIEW_TYPE);
    const leaf = leaves[0];
    const leafView = leaf.view.containerEl;

    const seletorPopupWidth = 280;
    const editorWidth = leafView.clientWidth;

    // positionX = editorWidth;

    const { x, y } = getCursorPostion(editorRef.current.element);
    // const left = x + seletorPopupWidth + 16 > editorWidth ? editorWidth + 20 - seletorPopupWidth : x + 2;
    let left: number;
    let top: number;
    if (!Platform.isMobile) {
      left = x + seletorPopupWidth + 16 > editorWidth ? x + 18 : x + 18;
      top = y + 34;
    } else {
      if (window.innerWidth - x > seletorPopupWidth) {
        left = x + seletorPopupWidth + 16 > editorWidth ? x + 18 : x + 18;
      } else if (window.innerWidth - x < seletorPopupWidth) {
        left = x + seletorPopupWidth + 16 > editorWidth ? x + 34 : x + 34;
      } else {
        left = editorRef.current.element.clientWidth / 2;
      }
      // Editor location is hardcoded to 'Top'
      if (window.innerWidth <= 875) {
        top = y + 36;
      } else {
        top = y + 34;
      }
    }

    positionX = x;

    popperRef.current.style.left = `${left}px`;
    popperRef.current.style.top = `${top}px`;
  }, []);

  const showEditStatus = Boolean(globalState.editMemoId);

  const editorConfig = useMemo(
    () => ({
      className: 'memo-editor',
      inputerType: 'memo',
      initialContent: getEditorContentCache(),
      placeholder: 'What do you think now...',
      showConfirmBtn: true,
      showCancelBtn: showEditStatus,
      showTools: true,
      onConfirmBtnClick: handleSaveBtnClick,
      onCancelBtnClick: handleCancelBtnClick,
      onContentChange: handleContentChange,
    }),
    [showEditStatus],
  );

  return (
    <div className={`memo-editor-wrapper ${showEditStatus ? 'edit-ing' : ''} ${isEditorShown ? 'hidden' : ''}`}>
      <p className={`tip-text ${showEditStatus ? '' : 'hidden'}`}>Modifying...</p>
      {MemoStorageMode === 'individual-files' && app && (
        <TagInput
          app={app}
          selectedTags={selectedTags}
          onTagsChange={setSelectedTags}
          placeholder="Add tags (for individual files mode)..."
        />
      )}
      <Editor
        ref={editorRef}
        {...editorConfig}
        tools={
          <>
            {/* Task/Note text toggle */}
            <button
              className={`task-toggle-btn ${isListShown ? 'is-active' : ''}`}
              onClick={handleChangeStatus}
            >
              {isListShown ? '☑ Task' : '☐ Task'}
            </button>
          </>
        }
      />
      <div ref={popperRef} className="date-picker">
        {isDatePickerOpen && (
          <div
            tabIndex={-1}
            style={popper.styles.popper}
            {...popper.attributes.popper}
            ref={setPopperElement}
            role="dialog"
          >
            <DatePicker
              className={`editor-date-picker ${isDatePickerOpen ? '' : 'hidden'}`}
              datestamp={currentDateStamp}
              handleDateStampChange={handleDateInsertTrigger}
            />
            {/* <DayPicker
                initialFocus={isPopperOpen}
                mode="single"
                defaultMonth={selected}
                selected={selected}
                onSelect={handleDateInsertTrigger}
                onKeyPress={handleKeyPress}
              /> */}
          </div>
        )}
      </div>
    </div>
  );
};

function getEditorContentCache(): string {
  return storage.get(['editorContentCache']).editorContentCache ?? '';
}

function setEditorContentCache(content: string) {
  storage.set({
    editorContentCache: content,
  });
}

export default MemoEditor;
