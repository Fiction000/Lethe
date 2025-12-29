import { moment } from 'obsidian';
import { DefaultMemoComposition } from '../memos';
// ShowDate, ShowTime, AddBlankLineWhenDate, CommentOnMemos removed - always show date/time
import { memoService } from '../services';
import utils, { getDailyNoteFormat } from '../helpers/utils';

export const getMemosByDate = (memos: Model.Memo[]) => {
  const dataArr = [] as any[];
  memos.map((mapItem) => {
    if (dataArr.length == 0) {
      dataArr.push({ date: moment(mapItem.createdAt, 'YYYY/MM/DD HH:mm:ss').format('YYYY-MM-DD'), have: [mapItem] });
    } else {
      const res = dataArr.some((item) => {
        //判断相同日期，有就添加到当前项
        if (item.date == moment(mapItem.createdAt, 'YYYY/MM/DD HH:mm:ss').format('YYYY-MM-DD')) {
          item.have.push(mapItem);
          return true;
        }
      });
      if (!res) {
        //如果没找相同日期添加一个新对象
        dataArr.push({ date: moment(mapItem.createdAt, 'YYYY/MM/DD HH:mm:ss').format('YYYY-MM-DD'), have: [mapItem] });
      }
    }
  });

  return dataArr;
};

// getCommentMemos removed - comment system removed in Phase 3

export const transferMemosIntoText = (memosArray: Array<any>): string => {
  let outputText = '' as string;
  const dailyNotesformat = getDailyNoteFormat();

  memosArray.map((mapItem) => {
    const dataArr = mapItem.have;

    // Always show date
    outputText = outputText + '- [[' + moment(mapItem.date, 'YYYY-MM-DD').format(dailyNotesformat) + ']]\n';
    const indent = '    ';

    // Always show time
    for (let i = 0; i < dataArr.length; i++) {
      const time = moment(dataArr[i].createdAt, 'YYYY/MM/DD HH:mm:ss').format('HH:mm');
      let formatContent;

      if (
        DefaultMemoComposition != '' &&
        /{TIME}/g.test(DefaultMemoComposition) &&
        /{CONTENT}/g.test(DefaultMemoComposition)
      ) {
        formatContent = DefaultMemoComposition.replace(/{TIME}/g, time).replace(/{CONTENT}/g, dataArr[i].content);
      } else {
        formatContent = time + ' ' + dataArr[i].content;
      }

      if (dataArr[i].memoType === 'JOURNAL') {
        outputText = outputText + indent + '- ' + formatContent + '\n';
      } else if (dataArr[i].memoType === 'TASK-TODO') {
        outputText = outputText + indent + '- [ ] ' + formatContent + '\n';
      } else if (dataArr[i].memoType === 'TASK-DONE') {
        outputText = outputText + indent + '- [x] ' + formatContent + '\n';
      } else {
        const taskMark = dataArr[i].memoType.match(/TASK-(.*)?/g)[1];
        outputText = outputText + indent + '- [' + taskMark + '] ' + formatContent + '\n';
      }

      // Remove block IDs from output
      outputText = outputText.replace(/ \^\S{6}/g, '');
      // Comment system removed - no longer include comment memos
    }
  });

  return outputText.replace(/<br>/g, '\n    ');
};
