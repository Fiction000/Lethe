import MemoEditor from '../components/MemoEditor';
import MemosHeader from '../components/MemosHeader';
import MemoFilter from '../components/MemoFilter';
import MemoList from '../components/MemoList';
import React from 'react';
// DefaultEditorLocation removed - hardcoded to 'Top' (Phase 3)

function Memos() {
  // DefaultEditorLocation hardcoded to 'Top' - editor always at top
  return (
    <>
      <MemosHeader />
      <MemoEditor />
      <MemoFilter />
      <MemoList />
    </>
  );
}

export default Memos;
