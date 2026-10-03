import { moment, TFile } from 'obsidian';
import { getDailyNote } from 'obsidian-daily-notes-interface';
import dailyNotesService from '../services/dailyNotesService';
import appStore from '../stores/appStore';
import { globalStateService, memoIndexService } from '../services';
import { DefaultTag } from '../memos';

export async function changeMemo(
  memoid: string,
  originalContent: string,
  content: string,
  memoType?: string,
  path?: string,
  tags?: string[],
): Promise<Model.Memo> {
  const { dailyNotes } = dailyNotesService.getState();
  const app = appStore.getState().dailyNotesState?.app;
  if (!app) throw new Error('Obsidian app not available');
  const { vault, metadataCache } = app;
  const timeString = memoid.slice(0, 14);
  const idString = parseInt(memoid.slice(14));
  let changeDate: moment.Moment;
  if (/^\d{14}/g.test(content)) {
    changeDate = moment(content.slice(0, 14), 'YYYYMMDDHHmmss');
  } else {
    changeDate = moment(timeString, 'YYYYMMDDHHmmss');
  }

  let file;
  if (path !== undefined) {
    file = metadataCache.getFirstLinkpathDest('', path);
  } else {
    file = getDailyNote(changeDate, dailyNotes);
  }

  if (path !== undefined) {
    // Individual file mode: rebuild entire file with updated frontmatter + content
    const existingFrontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
    const createdAt = existingFrontmatter?.created || changeDate.format('YYYY-MM-DD HH:mm:ss');
    const type = existingFrontmatter?.type || (memoType?.startsWith('TASK') ? 'task' : 'memo');
    const memoTags: string[] = tags || [];
    if (DefaultTag && !memoTags.includes(DefaultTag)) {
      memoTags.unshift(DefaultTag);
    }

    // Build new frontmatter
    let frontmatter = `---\ncreated: ${createdAt}\ntype: ${type}`;
    if (memoTags.length > 0) {
      frontmatter += `\ntags:\n${memoTags.map((t) => `  - ${t}`).join('\n')}`;
    }
    frontmatter += `\n---\n\n`;

    // Content body (strip frontmatter from the raw content param which has <br> tags)
    const contentBody = content.replace(/<br>/g, '\n').replace(/ \^\S{6}$/, '');
    const isTASK = type === 'task';
    let newFileContent: string;
    if (isTASK) {
      newFileContent = frontmatter + `- [ ] ${contentBody.replace(/\n/g, '\n  ')}`;
    } else {
      newFileContent = frontmatter + contentBody;
    }

    globalStateService.setChangedByMemos(true);
    await vault.modify(file, newFileContent);

    memoIndexService.updateEntry(memoid, {
      updatedAt: changeDate.format('YYYY/MM/DD HH:mm:ss'),
      memoType: memoType ?? 'JOURNAL',
      tags: memoTags,
      contentPreview: content.slice(0, 100),
    });

    const removeEnter = content.replace(/\n/g, '<br>');
    return {
      id: memoid,
      content: removeEnter,
      deletedAt: '',
      createdAt: changeDate.format('YYYY/MM/DD HH:mm:ss'),
      updatedAt: changeDate.format('YYYY/MM/DD HH:mm:ss'),
      memoType: memoType,
      path: file.path,
      tags: memoTags,
    };
  }

  // Daily notes mode: line-replace logic (unchanged)
  const fileContent = await vault.read(file);
  const fileLines = getAllLinesFromFile(fileContent);
  const removeEnter = content.replace(/\n/g, '<br>');
  const originalLine = fileLines[idString];
  const newLine = fileLines[idString].replace(originalContent, removeEnter);
  const newFileContent = fileContent.replace(originalLine, newLine);
  globalStateService.setChangedByMemos(true);
  await vault.modify(file, newFileContent);
  return {
    id: memoid,
    content: removeEnter,
    deletedAt: '',
    createdAt: changeDate.format('YYYY/MM/DD HH:mm:ss'),
    updatedAt: changeDate.format('YYYY/MM/DD HH:mm:ss'),
    memoType: memoType,
    path: file.path,
  };
}

export function getFile(memoid: string): TFile {
  const { dailyNotes } = dailyNotesService.getState();
  const timeString = memoid.slice(0, 14);
  const changeDate = moment(timeString, 'YYYYMMDDHHmmSS');
  const dailyNote = getDailyNote(changeDate, dailyNotes);
  return dailyNote;
}

const getAllLinesFromFile = (cache: string) => cache.split(/\r?\n/);
