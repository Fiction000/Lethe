import { moment, normalizePath } from 'obsidian';
import { getAllDailyNotes, getDailyNote } from 'obsidian-daily-notes-interface';
import appStore from '../stores/appStore';
import {
  DefaultMemoComposition,
  IndividualMemoFolder,
  IndividualMemoFileNameLength,
  IndividualMemoTags,
  InsertAfter,
  MemoStorageMode,
} from '../memos';
import { dailyNotesService } from '../services';
import utils from '../helpers/utils';

interface MContent {
  content: string;
  posNum?: number;
}

// https://stackoverflow.com/questions/3115150/how-to-escape-regular-expression-special-characters-using-javascript
export async function escapeRegExp(text: any) {
  return await text.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
}

//credit to chhoumann, original code from: https://github.com/chhoumann/quickadd/blob/7536a120701a626ef010db567cea7cf3018e6c82/src/utility.ts#L130
export function getLinesInString(input: string) {
  const lines: string[] = [];
  let tempString = input;

  while (tempString.contains('\n')) {
    const lineEndIndex = tempString.indexOf('\n');
    lines.push(tempString.slice(0, lineEndIndex));
    tempString = tempString.slice(lineEndIndex + 1);
  }

  lines.push(tempString);

  return lines;
}

export async function waitForInsert(MemoContent: string, isTASK: boolean, insertDate?: any): Promise<Model.Memo> {
  let date;
  if (insertDate !== undefined) {
    date = insertDate;
  } else {
    date = moment();
  }

  // Check storage mode - if individual files, use that instead
  if (MemoStorageMode === 'individual-files') {
    return await createIndividualMemoFile(MemoContent, isTASK, date);
  }

  // Otherwise, use daily notes (existing logic)
  const { vault } =
    appStore.getState().dailyNotesState.app === undefined ? app : appStore.getState().dailyNotesState.app;
  const removeEnter = MemoContent.replace(/\n/g, '<br>');

  const timeHour = date.format('HH');
  const timeMinute = date.format('mm');

  let newEvent;
  let lineNum;
  const timeText = String(timeHour) + `:` + String(timeMinute);

  if (isTASK && DefaultMemoComposition === '') {
    newEvent = `- [ ] ` + String(timeHour) + `:` + String(timeMinute) + ` ` + removeEnter;
  } else if (!isTASK && DefaultMemoComposition === '') {
    newEvent = `- ` + String(timeHour) + `:` + String(timeMinute) + ` ` + removeEnter;
  }

  if (isTASK && DefaultMemoComposition != '') {
    newEvent = `- [ ] ` + DefaultMemoComposition.replace(/{TIME}/g, timeText).replace(/{CONTENT}/g, removeEnter);
  } else if (!isTASK && DefaultMemoComposition != '') {
    newEvent = `- ` + DefaultMemoComposition.replace(/{TIME}/g, timeText).replace(/{CONTENT}/g, removeEnter);
  }

  const dailyNotes = await getAllDailyNotes();
  const existingFile = getDailyNote(date, dailyNotes);
  if (!existingFile) {
    const file = await utils.createDailyNoteCheck(date);
    await dailyNotesService.getMyAllDailyNotes();
    const fileContents = await vault.read(file);
    const newFileContent = await insertAfterHandler(InsertAfter, newEvent, fileContents);
    await vault.modify(file, newFileContent.content);
    if (newFileContent.posNum === -1) {
      const allLines = getAllLinesFromFile(newFileContent.content);
      lineNum = allLines.length + 1;
    } else {
      lineNum = newFileContent.posNum + 1;
    }
    if (isTASK) {
      return {
        id: date.format('YYYYMMDDHHmm') + '00' + lineNum,
        content: MemoContent,
        deletedAt: '',
        createdAt: date.format('YYYY/MM/DD HH:mm:ss'),
        updatedAt: date.format('YYYY/MM/DD HH:mm:ss'),
        memoType: 'TASK-TODO',
        path: file.path,
        hasId: '',
        linkId: '',
      };
    } else {
      return {
        id: date.format('YYYYMMDDHHmm') + '00' + lineNum,
        content: MemoContent,
        deletedAt: '',
        createdAt: date.format('YYYY/MM/DD HH:mm:ss'),
        updatedAt: date.format('YYYY/MM/DD HH:mm:ss'),
        memoType: 'JOURNAL',
        path: file.path,
        hasId: '',
        linkId: '',
      };
    }
  } else {
    const fileContents = await vault.read(existingFile);
    const newFileContent = await insertAfterHandler(InsertAfter, newEvent, fileContents);
    await vault.modify(existingFile, newFileContent.content);
    if (newFileContent.posNum === -1) {
      const allLines = getAllLinesFromFile(newFileContent.content);
      lineNum = allLines.length + 1;
    } else {
      lineNum = newFileContent.posNum + 1;
    }
    if (isTASK) {
      return {
        id: date.format('YYYYMMDDHHmm') + '00' + lineNum,
        content: MemoContent,
        deletedAt: '',
        createdAt: date.format('YYYY/MM/DD HH:mm:ss'),
        updatedAt: date.format('YYYY/MM/DD HH:mm:ss'),
        memoType: 'TASK-TODO',
        path: existingFile.path,
        hasId: '',
        linkId: '',
      };
    } else {
      return {
        id: date.format('YYYYMMDDHHmm') + '00' + lineNum,
        content: MemoContent,
        deletedAt: '',
        createdAt: date.format('YYYY/MM/DD HH:mm:ss'),
        updatedAt: date.format('YYYY/MM/DD HH:mm:ss'),
        memoType: 'JOURNAL',
        path: existingFile.path,
        hasId: '',
        linkId: '',
      };
    }
  }
}

//credit to chhoumann, original code from: https://github.com/chhoumann/quickadd
export async function insertAfterHandler(targetString: string, formatted: string, fileContent: string) {
  // const targetString: string = plugin.settings.InsertAfter;
  //eslint-disable-next-line
  const targetRegex = new RegExp(`\s*${await escapeRegExp(targetString)}\s*`);
  const fileContentLines: string[] = getLinesInString(fileContent);

  const targetPosition = fileContentLines.findIndex((line) => targetRegex.test(line));
  const targetNotFound = targetPosition === -1;
  if (targetNotFound) {
    // if (this.choice.insertAfter?.createIfNotFound) {
    //     return await createInsertAfterIfNotFound(formatted);
    // }

    console.log('unable to find insert after line in file.');
  }

  const nextHeaderPositionAfterTargetPosition = fileContentLines
    .slice(targetPosition + 1)
    .findIndex((line) => /^#+ |---/.test(line));
  const foundNextHeader = nextHeaderPositionAfterTargetPosition !== -1;

  if (foundNextHeader) {
    let endOfSectionIndex: number;

    for (let i = nextHeaderPositionAfterTargetPosition + targetPosition; i > targetPosition; i--) {
      const lineIsNewline: boolean = /^[\s\n ]*$/.test(fileContentLines[i]);
      if (!lineIsNewline) {
        endOfSectionIndex = i;
        break;
      }
    }

    if (!endOfSectionIndex) endOfSectionIndex = targetPosition;

    return await insertTextAfterPositionInBody(formatted, fileContent, endOfSectionIndex, foundNextHeader);
  } else {
    return await insertTextAfterPositionInBody(formatted, fileContent, fileContentLines.length - 1, foundNextHeader);
  }
  // return insertTextAfterPositionInBody(formatted, fileContent, targetPosition);
}

export async function insertTextAfterPositionInBody(
  text: string,
  body: string,
  pos: number,
  found?: boolean,
): Promise<MContent> {
  if (pos === -1) {
    return {
      content: `${body}\n${text}`,
      posNum: -1,
    };
  }

  const splitContent = body.split('\n');

  if (found) {
    const pre = splitContent.slice(0, pos + 1).join('\n');
    const post = splitContent.slice(pos + 1).join('\n');
    // return `${pre}\n${text}\n${post}`;
    return {
      content: `${pre}\n${text}\n${post}`,
      posNum: pos,
    };
  } else {
    const pre = splitContent.slice(0, pos + 1).join('\n');
    const post = splitContent.slice(pos + 1).join('\n');
    if (/[\s\S]*?/g.test(post)) {
      return {
        content: `${pre}\n${text}`,
        posNum: pos,
      };
    } else {
      return {
        content: `${pre}${text}\n${post}`,
        posNum: pos,
      };
    }
    // return `${pre}${text}\n${post}`;
  }
}

const getAllLinesFromFile = (cache: string) => cache.split(/\r?\n/);

/**
 * Creates an individual memo file with frontmatter
 * Returns the memo object
 */
export async function createIndividualMemoFile(
  MemoContent: string,
  isTASK: boolean,
  date: moment.Moment,
): Promise<Model.Memo> {
  const appState = appStore.getState().dailyNotesState.app;
  const vault = appState?.vault ?? app.vault;

  // Validate date
  if (!date || !date.isValid()) {
    date = moment();
  }

  // Ensure folder exists
  const folderPath = normalizePath(IndividualMemoFolder);
  try {
    const existingFolder = vault.getAbstractFileByPath(folderPath);
    if (!existingFolder) {
      await vault.createFolder(folderPath);
    }
  } catch (error) {
    console.error('Failed to create memo folder:', error);
    throw new Error(`Failed to create folder: ${folderPath}`);
  }

  // Generate filename from content
  const sanitizedName = utils.sanitizeFilename(MemoContent, IndividualMemoFileNameLength);
  const timestamp = date.format('YYYYMMDDHHmmss');
  const filename = await utils.generateUniqueFilename(vault, folderPath, sanitizedName, timestamp);

  // Parse tags from settings (comma-separated)
  const tags = IndividualMemoTags.split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  // Build frontmatter
  let frontmatter = `---\ncreated: ${date.format('YYYY-MM-DD HH:mm:ss')}\ntype: ${isTASK ? 'task' : 'memo'}`;
  if (tags.length > 0) {
    frontmatter += `\ntags:\n${tags.map((t) => `  - ${t}`).join('\n')}`;
  }
  frontmatter += `\n---\n\n`;

  // Format content (convert <br> back to newlines for individual files)
  const contentWithNewlines = MemoContent.replace(/<br>/g, '\n');
  let fileContent: string;
  if (isTASK) {
    fileContent = frontmatter + `- [ ] ${contentWithNewlines.replace(/\n/g, '\n  ')}`;
  } else {
    fileContent = frontmatter + contentWithNewlines;
  }

  // Create the file
  let file;
  try {
    file = await vault.create(filename, fileContent);
  } catch (error) {
    console.error('Failed to create memo file:', error);
    throw new Error(`Failed to create memo file: ${filename}`);
  }

  const id = timestamp + '001';

  return {
    id: id,
    content: MemoContent,
    deletedAt: '',
    createdAt: date.format('YYYY/MM/DD HH:mm:ss'),
    updatedAt: date.format('YYYY/MM/DD HH:mm:ss'),
    memoType: isTASK ? 'TASK-TODO' : 'JOURNAL',
    path: file.path,
    hasId: '',
    linkId: '',
  };
}
