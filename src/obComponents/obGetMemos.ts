import { moment, normalizePath, Notice, TFile, TFolder } from 'obsidian';
import { getAllDailyNotes, getDateFromFile } from 'obsidian-daily-notes-interface';
import appStore from '../stores/appStore';
import {
  DefaultMemoComposition,
  IndividualMemoFolder,
  MemoStorageMode,
} from '../memos';
// Removed in Phase 3: CommentOnMemos, CommentsInOriginalNotes, FetchMemosFromNote,
// FetchMemosMark, ProcessEntriesBelow, QueryFileName, DeleteFileName (now hardcoded)
// Dataview import removed - global fetch feature removed
import { t } from '../translations/helper';
import { getDailyNotePath } from '../helpers/utils';

export class DailyNotesFolderMissingError extends Error {}

interface allKindsofMemos {
  memos: Model.Memo[];
  commentMemos: Model.Memo[]; // Still returned but empty - comment system removed
}

const getTaskType = (memoTaskType: string): string => {
  let memoType;
  if (memoTaskType === ' ') {
    memoType = 'TASK-TODO';
    return memoType;
  } else if (memoTaskType === 'x' || memoTaskType === 'X') {
    memoType = 'TASK-DONE';
    return memoType;
  } else {
    memoType = 'TASK-' + memoTaskType;
    return memoType;
  }
};

export async function getRemainingMemos(note: TFile): Promise<number> {
  if (!note) {
    return 0;
  }
  const { vault } = appStore.getState().dailyNotesState.app;
  let fileContents = await vault.read(note);
  let regexMatch;
  if (
    DefaultMemoComposition != '' &&
    /{TIME}/g.test(DefaultMemoComposition) &&
    /{CONTENT}/g.test(DefaultMemoComposition)
  ) {
    //eslint-disable-next-line
    regexMatch =
      '(-|\\*) (\\[(.{1})\\]\\s)?' +
      DefaultMemoComposition.replace(/{TIME}/g, '((\\<time\\>)?\\d{1,2}:\\d{2})?').replace(/ {CONTENT}/g, '');
  } else {
    //eslint-disable-next-line
    regexMatch = '(-|\\*) (\\[(.{1})\\]\\s)?((\\<time\\>)?\\d{1,2}\\:\\d{2})?';
  }
  const regexMatchRe = new RegExp(regexMatch, 'g');
  //eslint-disable-next-line
  const matchLength = (fileContents.match(regexMatchRe) || []).length;
  // ProcessEntriesBelow hardcoded to empty (no filtering) - always return match length
  fileContents = null;
  return matchLength;
}

export async function getMemosFromDailyNote(
  dailyNote: TFile | null,
  allMemos: any[],
  commentMemos: any[],
): Promise<any[]> {
  if (!dailyNote) {
    return [];
  }
  const { vault } = appStore.getState().dailyNotesState.app;
  const Memos = await getRemainingMemos(dailyNote);

  if (Memos === 0) return;

  // Comment system removed in Phase 3

  let fileContents = await vault.read(dailyNote);
  let fileLines = getAllLinesFromFile(fileContents);
  const startDate = getDateFromFile(dailyNote, 'day');
  const endDate = getDateFromFile(dailyNote, 'day');
  let memoType: string;

  // ProcessEntriesBelow removed - parse all lines
  for (let i = 0; i < fileLines.length; i++) {
    const line = fileLines[i];

    if (line.length === 0) continue;
    // Skip comment lines
    if (line.contains('comment: ')) continue;

    if (lineContainsTime(line)) {
      const hourText = extractHourFromBulletLine(line);
      const minText = extractMinFromBulletLine(line);
      startDate.hours(parseInt(hourText));
      startDate.minutes(parseInt(minText));
      endDate.hours(parseInt(hourText));
      if (parseInt(hourText) > 22) {
        endDate.minutes(parseInt(minText));
      } else {
        endDate.minutes(parseInt(minText));
      }
      if (/^\s*[-*]\s(\[(.{1})\])\s/g.test(line)) {
        const memoTaskType = extractMemoTaskTypeFromLine(line);
        memoType = getTaskType(memoTaskType);
      } else {
        memoType = 'JOURNAL';
      }
      const rawText = extractTextFromTodoLine(line);
      // Comment system removed - simplified memo creation
      if (rawText !== '') {
        let hasId = Math.random().toString(36).slice(-6);
        if (/\^\S{6}$/g.test(rawText)) {
          hasId = rawText.slice(-6);
        }
        allMemos.push({
          id: startDate.format('YYYYMMDDHHmmSS') + i,
          content: rawText,
          user_id: 1,
          createdAt: startDate.format('YYYY/MM/DD HH:mm:SS'),
          updatedAt: endDate.format('YYYY/MM/DD HH:mm:SS'),
          memoType: memoType,
          hasId: hasId,
          linkId: '',
          path: dailyNote.path,
        });
      }
    }
  }
  fileLines = null;
  fileContents = null;
}

// Global memo fetch feature removed in Phase 3 (FetchMemosFromNote setting removed)

/**
 * Get memos from individual memo files in the configured folder
 */
export async function getMemosFromIndividualFiles(allMemos: any[], _commentMemos: any[]): Promise<void> {
  const appState = appStore.getState().dailyNotesState.app;
  if (!appState?.vault) {
    console.error('Vault not available');
    return;
  }
  const { vault } = appState;
  const folderPath = normalizePath(IndividualMemoFolder);
  const folder = vault.getAbstractFileByPath(folderPath) as TFolder;

  if (!folder) {
    new Notice(t('Individual memo folder not found: ') + folderPath);
    return;
  }

  const files = folder.children.filter(
    (file): file is TFile => file instanceof TFile && file.extension === 'md',
  );

  for (const file of files) {
    try {
      const content = await vault.read(file);
      const metadata = app.metadataCache.getFileCache(file);

      // Parse frontmatter for created date and type
      const frontmatter = metadata?.frontmatter;
      const createdAtStr = frontmatter?.created;
      const memoTypeFromFrontmatter = frontmatter?.type;

      // Determine created date
      let createDate: moment.Moment;
      if (createdAtStr) {
        createDate = moment(createdAtStr, 'YYYY-MM-DD HH:mm:ss');
        // Validate parsed date
        if (!createDate.isValid()) {
          createDate = moment(file.stat.ctime);
        }
      } else {
        createDate = moment(file.stat.ctime);
      }

      // Determine memo type
      let memoType = 'JOURNAL';
      if (memoTypeFromFrontmatter === 'task') {
        // Check if task is done by looking for [x] or [X] in content
        if (/- \[[xX]\]/.test(content)) {
          memoType = 'TASK-DONE';
        } else {
          memoType = 'TASK-TODO';
        }
      }

      // Get content without frontmatter
      const contentWithoutFrontmatter = content.replace(/^---[\s\S]*?---\n*/m, '').trim();

      allMemos.push({
        id: createDate.format('YYYYMMDDHHmmss') + '001',
        content: contentWithoutFrontmatter,
        user_id: 1,
        createdAt: createDate.format('YYYY/MM/DD HH:mm:ss'),
        updatedAt: moment(file.stat.mtime).format('YYYY/MM/DD HH:mm:ss'),
        memoType: memoType,
        hasId: '',
        linkId: '',
        path: file.path,
      });
    } catch (error) {
      console.error(`Failed to read memo file ${file.path}:`, error);
      // Continue with other files
    }
  }
}

export async function getMemos(): Promise<allKindsofMemos> {
  const memos: any[] | PromiseLike<any[]> = [];
  const commentMemos: any[] | PromiseLike<any[]> = [];
  const { vault } = appStore.getState().dailyNotesState.app;

  // If using individual files mode, only fetch from individual files folder
  if (MemoStorageMode === 'individual-files') {
    await getMemosFromIndividualFiles(memos, commentMemos);
    return { memos, commentMemos };
  }

  // Otherwise, use daily notes (existing logic)
  const folder = getDailyNotePath();

  if (folder === '' || folder === undefined) {
    console.error('[Lethe] Daily notes folder path is empty or undefined');
    new Notice(t('Please check your daily note plugin OR periodic notes plugin settings'));
    return { memos: [], commentMemos: [] };
  }
  const dailyNotesFolder = vault.getAbstractFileByPath(normalizePath(folder)) as TFolder;

  if (!dailyNotesFolder) {
    throw new DailyNotesFolderMissingError('Failed to find daily notes folder');
  }

  const dailyNotes = getAllDailyNotes();

  for (const string in dailyNotes) {
    if (dailyNotes[string] instanceof TFile && dailyNotes[string].extension === 'md') {
      await getMemosFromDailyNote(dailyNotes[string], memos, commentMemos);
    }
  }

  // Global memo fetch removed in Phase 3

  return { memos, commentMemos };
}

const getAllLinesFromFile = (cache: string) => cache.split(/\r?\n/);
// const lineIsValidTodo = (line: string) => {
// //eslint-disable-next-line
//   return /^\s*[\-\*]\s\[(\s|x|X|\\|\-|\>|D|\?|\/|\+|R|\!|i|B|P|C)\]\s?\s*\S/.test(line)
// }
const lineContainsTime = (line: string) => {
  let regexMatch;
  const indent = '\\s*'; // CommentsInOriginalNotes removed - always use standard indent
  if (
    DefaultMemoComposition != '' &&
    /{TIME}/g.test(DefaultMemoComposition) &&
    /{CONTENT}/g.test(DefaultMemoComposition)
  ) {
    //eslint-disable-next-line
    regexMatch =
      '^' +
      indent +
      '(-|\\*)\\s(\\[(.{1})\\]\\s)?' +
      DefaultMemoComposition.replace(/{TIME}/g, '(\\<time\\>)?\\d{1,2}:\\d{2}(\\<\\/time\\>)?').replace(
        /{CONTENT}/g,
        '(.*)$',
      );
  } else {
    //eslint-disable-next-line
    regexMatch = '^' + indent + '(-|\\*)\\s(\\[(.{1})\\]\\s)?(\\<time\\>)?\\d{1,2}\\:\\d{2}(.*)$';
  }
  const regexMatchRe = new RegExp(regexMatch, '');
  //eslint-disable-next-line
  return regexMatchRe.test(line);
  // The below line excludes entries with a ':' after the time as I was having issues with my calendar
  // being pulled in. Once made configurable will be simpler to manage.
  // return /^\s*[\-\*]\s(\[(\s|x|X|\\|\-|\>|D|\?|\/|\+|R|\!|i|B|P|C)\]\s)?(\<time\>)?\d{1,2}\:\d{2}[^:](.*)$/.test(line);
};

// lineContainsParseBelowToken removed - ProcessEntriesBelow feature removed

const extractTextFromTodoLine = (line: string) => {
  let regexMatch;
  if (
    DefaultMemoComposition != '' &&
    /{TIME}/g.test(DefaultMemoComposition) &&
    /{CONTENT}/g.test(DefaultMemoComposition)
  ) {
    //eslint-disable-next-line
    regexMatch =
      '^\\s*[\\-\\*]\\s(\\[(.{1})\\]\\s?)?' +
      DefaultMemoComposition.replace(/{TIME}/g, '(\\<time\\>)?((\\d{1,2})\\:(\\d{2}))?(\\<\\/time\\>)?').replace(
        /{CONTENT}/g,
        '(.*)$',
      );
  } else {
    //eslint-disable-next-line
    regexMatch = '^\\s*[\\-\\*]\\s(\\[(.{1})\\]\\s?)?(\\<time\\>)?((\\d{1,2})\\:(\\d{2}))?(\\<\\/time\\>)?\\s?(.*)$';
  }
  const regexMatchRe = new RegExp(regexMatch, '');
  //eslint-disable-next-line
  return regexMatchRe.exec(line)?.[8];
  // return /^\s*[\-\*]\s(\[(.{1})\]\s?)?(\<time\>)?((\d{1,2})\:(\d{2}))?(\<\/time\>)?\s?(.*)$/.exec(line)?.[8];
};

const extractHourFromBulletLine = (line: string) => {
  let regexHourMatch;
  if (
    DefaultMemoComposition != '' &&
    /{TIME}/g.test(DefaultMemoComposition) &&
    /{CONTENT}/g.test(DefaultMemoComposition)
  ) {
    //eslint-disable-next-line
    regexHourMatch =
      '^\\s*[\\-\\*]\\s(\\[(.{1})\\]\\s?)?' +
      DefaultMemoComposition.replace(/{TIME}/g, '(\\<time\\>)?(\\d{1,2})\\:(\\d{2})(\\<\\/time\\>)?').replace(
        /{CONTENT}/g,
        '(.*)$',
      );
  } else {
    //eslint-disable-next-line
    regexHourMatch = '^\\s*[\\-\\*]\\s(\\[(.{1})\\]\\s?)?(\\<time\\>)?(\\d{1,2})\\:(\\d{2})(.*)$';
  }
  const regexMatchRe = new RegExp(regexHourMatch, '');
  //eslint-disable-next-line
  return regexMatchRe.exec(line)?.[4];
};

const extractMinFromBulletLine = (line: string) => {
  let regexHourMatch;
  if (
    DefaultMemoComposition != '' &&
    /{TIME}/g.test(DefaultMemoComposition) &&
    /{CONTENT}/g.test(DefaultMemoComposition)
  ) {
    //eslint-disable-next-line
    regexHourMatch =
      '^\\s*[\\-\\*]\\s(\\[(.{1})\\]\\s?)?' +
      DefaultMemoComposition.replace(/{TIME}/g, '(\\<time\\>)?(\\d{1,2})\\:(\\d{2})(\\<\\/time\\>)?').replace(
        /{CONTENT}/g,
        '(.*)$',
      );
  } else {
    //eslint-disable-next-line
    regexHourMatch = '^\\s*[\\-\\*]\\s(\\[(.{1})\\]\\s?)?(\\<time\\>)?(\\d{1,2})\\:(\\d{2})(.*)$';
  }
  const regexMatchRe = new RegExp(regexHourMatch, '');
  //eslint-disable-next-line
  return regexMatchRe.exec(line)?.[5];
  // /^\s*[\-\*]\s(\[(.{1})\]\s?)?(\<time\>)?(\d{1,2})\:(\d{2})(.*)$/.exec(line)?.[5];
};

const extractMemoTaskTypeFromLine = (line: string) =>
  //eslint-disable-next-line
  /^\s*[\-\*]\s(\[(.{1})\])\s(.*)$/.exec(line)?.[2];

// extractCommentFromLine removed - comment system removed in Phase 3
