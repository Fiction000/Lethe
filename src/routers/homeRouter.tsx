import React from 'react';
import Memos from '../pages/Memos';
import MemoTrash from '../pages/MemoTrash';
import Setting from '../pages/Setting';
import Timeline from '../pages/Timeline';

const homeRouter = {
  '/recycle': <MemoTrash />,
  '/setting': <Setting />,
  '/timeline': <Timeline />,
  '*': <Memos />,
};

export default homeRouter;
