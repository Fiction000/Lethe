# Quick Start Guide

Get up and running with Lethe in 5 minutes.

## Prerequisites

**For Daily Notes Mode Only:**
- Obsidian Daily Notes plugin (core plugin, enable in Settings > Core Plugins)

**For Individual Files Mode (Default):**
- No prerequisites needed!

## Installation

### Option 1: Community Plugins (Recommended)

1. Open Obsidian Settings
2. Go to Community Plugins > Browse
3. Search for "Lethe"
4. Click Install, then Enable

### Option 2: Manual Installation

1. Download the latest release from GitHub
2. Extract `main.js`, `manifest.json`, and `styles.css`
3. Copy to `{{your_vault}}/.obsidian/plugins/lethe/`
4. Enable plugin in Settings > Community Plugins

## Configuration

### Choose Your Storage Mode

Lethe supports two storage modes:

#### Individual Files Mode (Default) ✅

**Best for:** Standalone memos, linking, tagging, flexible organization

1. Go to Settings > Lethe > Storage & Content
2. Ensure "Memo storage mode" is set to "Individual Files"
3. Set "Individual memo folder" (default: `Thino/Memos`)
4. Each memo becomes its own file: `Thino/Memos/2025-01-15-14-32-45.md`

**Features available:**
- ✅ Tag autocomplete (frontmatter tags)
- ✅ Individual file per memo
- ✅ Easy linking between memos
- ✅ Standard file organization

#### Daily Notes Mode

**Best for:** Journal-style capture, chronological log

1. **Enable Daily Notes plugin first** (Settings > Core Plugins)
2. Go to Settings > Lethe > Storage & Content
3. Change "Memo storage mode" to "Daily Notes"
4. Set "Insert after heading" (default: `# Journal`)
5. Memos are added below this heading in your daily note

**Note:** Tags are saved as inline `#tags`, not frontmatter

### Set Up Quick Capture Hotkey

1. Go to Settings > Hotkeys
2. Search for "Quick Capture"
3. Click the ➕ icon to set your preferred hotkey
4. Recommended: `Cmd+Shift+M` or `Ctrl+Shift+M`

### Optional Settings

**User Interface:**
- "Show in sidebar" - Open Lethe in sidebar instead of tab
- "Sidebar location" - Left or right sidebar
- "Focus on editor" - Auto-focus editor when opening (recommended: ON)

**Performance:**
- "Pre-create daily notes" - Create tomorrow's note in background (daily notes mode only)

## Your First Memo

### Using Quick Capture (Recommended)

1. Press your Quick Capture hotkey anywhere in Obsidian
2. Type your memo: `Investigate React performance optimization`
3. **(Individual Files Mode)** Add tags: Type to autocomplete, press Enter
4. **(Optional)** Click the checkbox icon to make it a task
5. Press `Cmd/Ctrl+Enter` or click NOTEIT

**Done!** Your memo is saved instantly.

### Using the Main View

1. Open Lethe:
   - Click the Lethe ribbon icon (left sidebar), OR
   - Open command palette (`Cmd/Ctrl+P`) → "Open Lethe"
2. Type your memo in the editor
3. Add tags (individual files mode) or use `#tags` inline
4. Click NOTEIT or press `Cmd/Ctrl+Enter`

## Common Patterns

### Quick Task Capture

```
Press hotkey → Type "Buy groceries" → Click checkbox icon → Save
```

Result: `- [ ] 14:32 Buy groceries`

### Tagged Memo (Individual Files)

```
Press hotkey → Type "Meeting notes" → Add tags: "work", "meetings" → Save
```

Result: New file with frontmatter:
```yaml
---
created: 2025-01-15 14:32:45
type: memo
tags:
  - work
  - meetings
---

14:32 Meeting notes
```

### Formatted Memo

```
Press hotkey → Type memo → Use Markdown hotkeys:
- Cmd+B for **bold**
- Cmd+I for *italic*
- Cmd+K for [links]()
→ Save
```

## Viewing Your Memos

1. Open Lethe (ribbon icon or command palette)
2. All memos appear in chronological timeline
3. **Double-click** any memo to edit it
4. **Ctrl+Click** (Windows) or **Cmd+Click** (Mac) to jump to source file

## Search & Filter

1. Open Lethe
2. Use the search bar at top
3. Filter by:
   - Text content
   - Date range
   - Tags (click tags in sidebar)

## Tips

- **Use Quick Capture everywhere** - It works from any Obsidian view
- **Hotkey muscle memory** - Set a comfortable hotkey and use it reflexively
- **Tag consistently** - Tags autocomplete from your entire vault
- **Format as you type** - Use Markdown hotkeys (Cmd+B, Cmd+I, etc.)
- **Tasks vs Lists** - Toggle the checkbox icon or use the default in settings

## Troubleshooting

**"Obsidian app not available" error**
- Restart Obsidian
- Ensure plugin is enabled in Settings > Community Plugins

**Tags not showing in Quick Capture**
- Ensure you're in Individual Files mode
- Restart Obsidian if settings were just changed

**Daily Notes mode: Memos not appearing**
- Ensure Daily Notes plugin is enabled
- Check "Insert after heading" matches a heading in your daily note template
- Create today's daily note first

**Quick Capture hotkey not working**
- Check Settings > Hotkeys to ensure it's set
- Try a different key combination (avoid conflicts)

## Next Steps

- Explore the 10 essential settings in Settings > Lethe
- Set up your preferred storage mode and folder structure
- Create your first 10 memos to build the habit
- Experiment with tags to organize your thoughts
- Check out FAQ.md for advanced usage

**Welcome to frictionless thought capture!** 🎉
