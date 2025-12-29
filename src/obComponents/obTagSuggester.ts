// Credits go to Liam's Periodic Notes Plugin: https://github.com/liamcain/obsidian-periodic-notes
// import { TextInputSuggest } from "./obSuggest";
import memoService from '../services/memoService';
// UseVaultTags removed - hardcoded to false (use memo tags, Phase 3)

export const usedTags = (seletecText: string) => {
  // UseVaultTags hardcoded to false - always use memo tags
  const { tags } = memoService.getState();
  const allTags = tags;
  const lowerCaseInputStr = seletecText.toLowerCase();
  const usedTags = [] as any;

  allTags.forEach((tag: string) => {
    if (tag && tag.toLowerCase().contains(lowerCaseInputStr)) {
      usedTags.push({
        name: tag as string,
        char: tag as string,
      });
    }
  });

  return usedTags;
};
