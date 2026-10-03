import React, { useContext } from 'react';
import appContext from '../stores/appContext';
import { MemoStorageMode } from '../memos';
import CaptureComposer from './CaptureComposer';
import LegacyMemoEditor from './LegacyMemoEditor';

/**
 * Keep the established daily-note and edit flows intact. Structured capture
 * is used only for a fresh individual-file session.
 */
const MemoEditor: React.FC = () => {
  const { globalState } = useContext(appContext);
  const useLegacyEditor = Boolean(globalState.editMemoId) || MemoStorageMode === 'daily-notes';

  return useLegacyEditor ? <LegacyMemoEditor /> : <CaptureComposer surface="main" />;
};

export default MemoEditor;
