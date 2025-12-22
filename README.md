# Lethe

A quick capture plugin for Obsidian. Capture ideas quickly and view them in a unified timeline.

Based on the [memos](https://github.com/justmemos/memos) open source project.

## Introduction

1. All memos come from your daily notes - requires the 'Daily Notes Plugin' to be enabled.
2. Memos are taken from below the header you set in configuration under 'Process Memos below' (`# Journal` by default).
3. Memos are created under the heading set as 'Insert After' (`# Journal` by default).
4. Alternatively, memos can be stored as individual files in a configurable folder.
5. Query files are generated in your daily note folder.
6. Deleted memos are sent to a delete.md file in your daily note folder.

## How to Use

1. Enable the 'Daily notes' core plugin in Obsidian.
2. Configure your header settings for processing and inserting memos.
3. Open Lethe and click 'NOTEIT' to capture a memo.
4. For comments on memos, enable the 'dataview' plugin.

### Memo Format

```markdown
- 22:15 {Your memo content}
```

Supported formats:
- `- 19:00` - Regular memo
- `- [ ] 19:00` - Task memo

## Features

- **Memos List** - View all memos from daily notes in one place
- **Share** - Share memos and timelines as images
- **Tag List** - Built-in tag list for memos
- **Query List** - Create queries with multiple variables
- **Heatmap** - GitHub-style heatmap showing memo activity
- **Search & Filter** - Search and filter memos with built-in filters

### Tips

- Double-click a memo to edit it
- Ctrl+click to jump to the memo source

## Installation

### From Obsidian Community Plugins

Search for "Lethe" in Settings > Community Plugins.

### Manual Installation

Download the latest release and extract `main.js`, `manifest.json`, and `styles.css` to:
```
{{your_vault}}/.obsidian/plugins/lethe/
```

## License

MIT License - see [LICENSE](./LICENSE)
