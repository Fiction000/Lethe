# Lethe - Instant Thought Capture for Obsidian

Capture ideas instantly with one hotkey. No friction, just capture.

## Quick Start

1. Install Lethe from Community Plugins
2. Choose your storage mode in settings:
   - **Individual Files** (default): Each memo becomes its own file in `Thino/Memos/`
   - **Daily Notes**: Memos are added to daily notes (requires Daily Notes plugin)
3. Press the Quick Capture hotkey → type → save

Your memo is instantly saved with tags and Markdown formatting.

## Features

- **One-hotkey capture** - Global Quick Capture command works anywhere in Obsidian
- **Tag autocomplete** - Add tags with vault-wide autocomplete (individual files mode)
- **Markdown hotkeys** - Standard formatting shortcuts (Cmd+B for bold, etc.)
- **Dual storage modes** - Individual files or daily notes integration
- **Task support** - Create todos or list items
- **Timeline view** - See all memos in unified timeline

## Keyboard Shortcuts

### Capture
- Quick Capture hotkey - Open capture modal
- `Cmd/Ctrl+Enter` - Save memo
- `Escape` - Cancel

### Markdown Formatting
- `Cmd/Ctrl+B` - **Bold**
- `Cmd/Ctrl+I` - *Italic*
- `Cmd/Ctrl+K` - [Link]()
- `Cmd/Ctrl+E` - `Inline code`
- `Cmd/Ctrl+Shift+X` - ~~Strikethrough~~

### Tag Input (Individual Files Mode)
- Type to autocomplete from vault tags
- `↑/↓` - Navigate suggestions
- `Enter` - Select tag
- `Backspace` on empty field - Remove last tag

## Settings

Only 10 essential settings:
1. **Storage mode** - Individual files or daily notes
2. **Insert after heading** - Where to add memos in daily notes
3. **Individual memo folder** - Folder for individual files
4. **Default prefix** - List or Task
5. **Memo format template** - Template with {TIME} and {CONTENT}
6. **User name** - Your display name
7. **Show in sidebar** - Open in sidebar vs tab
8. **Sidebar location** - Left or right
9. **Focus on editor** - Auto-focus on open
10. **Pre-create daily notes** - Performance optimization

## Installation

### From Community Plugins (Recommended)

Search for "Lethe" in Settings > Community Plugins > Browse.

### Manual Installation

Download the latest release and extract `main.js`, `manifest.json`, and `styles.css` to:
```
{{your_vault}}/.obsidian/plugins/lethe/
```

## Philosophy

Lethe deliberately does NOT have:
- Query builders
- Heatmaps
- Image sharing
- Multi-language support
- Complex workflows

**One purpose: Capture thoughts instantly.**

## License

MIT License - see [LICENSE](./LICENSE)
