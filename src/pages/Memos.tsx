import React, { useContext } from 'react';
import appContext from '../stores/appContext';
import { MemoStorageMode } from '../memos';
import CaptureComposer from '../components/CaptureComposer';
import LegacyMemoEditor from '../components/LegacyMemoEditor';
import MemosHeader from '../components/MemosHeader';
import MemoFilter from '../components/MemoFilter';
import MemoList from '../components/MemoList';

function Memos() {
  const { globalState } = useContext(appContext);
  const legacyEditor = Boolean(globalState.editMemoId) || MemoStorageMode === 'daily-notes';
  if (!legacyEditor) return <CaptureComposer surface="main" />;

  return (
    <>
      <MemosHeader />
      <LegacyMemoEditor />
      <MemoFilter />
      <MemoList />
    </>
  );
}

export default Memos;
