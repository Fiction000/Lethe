# Frequently Asked Questions

## General

### What is Lethe?

Lethe is a minimal thought capture plugin for Obsidian. It's designed for one purpose: capturing ideas instantly with zero friction. Press a hotkey, type, save. That's it.

### Why "Lethe"?

Lethe is the Greek river of forgetfulness. This plugin ensures you never forget your thoughts by capturing them instantly.

### How is Lethe different from other memo/note plugins?

**What Lethe has:**
- Instant capture from anywhere in Obsidian
- Two simple storage modes (individual files or daily notes)
- Tag autocomplete
- Timeline view
- Markdown formatting hotkeys
- 10 essential settings

**What Lethe deliberately does NOT have:**
- Query builders
- Heatmaps
- Image sharing
- Multi-language support
- Complex workflows
- Social features

If it doesn't help you capture thoughts faster, it's not in Lethe.

## Storage & Files

### Where do my memos go?

Depends on your storage mode:

**Individual Files Mode (Default):**
- Each memo becomes a separate Markdown file
- Stored in `Thino/Memos/` by default (configurable)
- Filename format: `2025-01-15-14-32-45.md` (timestamp)
- Contains frontmatter with created date, type, and tags

**Daily Notes Mode:**
- Memos are appended to your daily note
- Added below the heading specified in "Insert after heading" setting
- Format: `- 14:32 {Your memo content}`
- Requires Daily Notes plugin to be enabled

### Can I change where memos are stored?

**Individual Files Mode:** Yes, change "Individual memo folder" in settings.

**Daily Notes Mode:** Memos go in your daily notes folder (configured in Daily Notes plugin settings).

### What's the file format for individual memos?

```markdown
---
created: 2025-01-15 14:32:45
type: memo
tags:
  - work
  - ideas
---

14:32 Your memo content here
```

### Can I manually edit memo files?

Yes! They're standard Markdown files. Edit them directly or double-click in the Lethe timeline view.

### What happens if I delete a memo?

The file is deleted permanently (moves to Obsidian's `.trash/` folder). There's no separate "delete log" file.

## Features

### How do tags work?

**Individual Files Mode:**
- Click in the tag input field
- Start typing - autocomplete shows all tags from your vault
- Press Enter to select
- Tags are saved in frontmatter YAML
- Tags come from both frontmatter tags and inline `#tags` across all vault files

**Daily Notes Mode:**
- Use inline `#tags` in your memo content
- No autocomplete (tags are just text)

### Can I use Markdown formatting?

Yes! Use standard Markdown syntax or keyboard shortcuts:

- `Cmd/Ctrl+B` - **Bold**
- `Cmd/Ctrl+I` - *Italic*
- `Cmd/Ctrl+K` - [Link]()
- `Cmd/Ctrl+E` - `Inline code`
- `Cmd/Ctrl+Shift+X` - ~~Strikethrough~~

Works in both Quick Capture modal and main editor.

### What's the difference between List and Task memos?

**List:** `- 14:32 Your memo content`
**Task:** `- [ ] 14:32 Your memo content`

Toggle with the checkbox icon or set default in settings.

### How do I search memos?

1. Open Lethe
2. Use the search bar at the top
3. Filter by text content, date range, or tags
4. Click tags in the sidebar to filter by that tag

### Can I link between memos?

Yes! Use standard Obsidian links: `[[filename]]` or `[[filename|alias]]`

Works best in Individual Files mode since each memo is a separate file.

## Quick Capture

### How do I set up Quick Capture?

1. Go to Settings > Hotkeys
2. Search for "Quick Capture"
3. Click ➕ to set your hotkey
4. Recommended: `Cmd/Ctrl+Shift+M`

### Does Quick Capture work without opening Lethe first?

Yes! Quick Capture works from anywhere in Obsidian, even if you've never opened the Lethe view.

### Why don't tags show in Quick Capture?

**Most common reason:** You're in Daily Notes mode. Tag autocomplete only works in Individual Files mode.

**Fix:** Go to Settings > Lethe > Storage & Content → Change to "Individual Files"

**Other reasons:**
- Restart Obsidian if you just changed settings
- Ensure plugin is fully loaded

### Can I make Quick Capture my default behavior?

Yes, set a comfortable hotkey and use it reflexively. Many users never open the main Lethe view - they only use Quick Capture.

## Settings

### How many settings does Lethe have?

Only 10 essential settings organized into 3 sections:

**Storage & Content (5 settings):**
1. Memo storage mode
2. Insert after heading
3. Individual memo folder
4. Default prefix
5. Memo format template

**User Interface (4 settings):**
6. User name
7. Show in sidebar
8. Sidebar location
9. Focus on editor

**Performance (1 setting):**
10. Pre-create daily notes

### What does "Pre-create daily notes" do?

**In Daily Notes mode only:**
- Automatically creates today and tomorrow's daily notes in the background
- Eliminates 200-500ms delay on first memo save of the day
- Checks for midnight rollover every 60 seconds

**In Individual Files mode:** This setting does nothing (no daily notes to create).

### What's the "Memo format template"?

Controls how memo content is formatted. Uses placeholders:
- `{TIME}` - Timestamp (e.g., `14:32`)
- `{CONTENT}` - Your memo text

**Default:** `{TIME} {CONTENT}` → `14:32 Your memo here`

**Custom examples:**
- `{CONTENT}` - No timestamp
- `{TIME} - {CONTENT}` - With dash separator
- `**{TIME}** {CONTENT}` - Bold timestamp

### Can I hide the sidebar?

The Lethe sidebar shows tags. To hide it, minimize the Lethe view or use Quick Capture exclusively.

## Troubleshooting

### "Obsidian app not available" error

**Causes:**
- Plugin not fully loaded
- App state not initialized

**Fixes:**
1. Restart Obsidian
2. Ensure plugin is enabled in Settings > Community Plugins
3. Try disabling and re-enabling the plugin

### Memos not appearing in Daily Notes mode

**Check these:**
1. Is Daily Notes plugin enabled? (Settings > Core Plugins)
2. Does today's daily note exist? Create it manually first
3. Does your daily note have the heading specified in "Insert after heading"?
4. Check the heading format matches exactly (e.g., `# Journal` not `## Journal`)

### Tag autocomplete not working

**Most common cause:** You're in Daily Notes mode (tag autocomplete is Individual Files only)

**Other checks:**
1. Go to Settings > Lethe > Storage & Content
2. Ensure "Memo storage mode" is "Individual Files"
3. Restart Obsidian if you just changed this setting

### Quick Capture hotkey conflicts with another plugin

1. Go to Settings > Hotkeys
2. Search for your desired key combination
3. If it's used elsewhere, either:
   - Remove the conflicting hotkey, OR
   - Choose a different key for Quick Capture

Common conflict: `Cmd+Shift+M` is sometimes used by other plugins.

### Memos have wrong timestamp

Check your system clock. Timestamps come from `moment().format()` which uses system time.

### Can't see active tag selection (dark theme)

This was fixed in v1.1.0+. Update to the latest version.

If still having issues:
- Ensure you have the latest Lethe version
- Check Obsidian appearance settings aren't overriding accent colors

## Performance

### How large can my memo collection grow?

**Individual Files Mode:**
- Tested with 10,000+ memo files
- Performance depends on vault size and device
- Each memo is a small Markdown file (~500 bytes)

**Daily Notes Mode:**
- Performance depends on daily note file size
- Memos in a single daily note can grow large over time

### Does Lethe slow down Obsidian startup?

**Typical impact:**
- Plugin load: <100ms
- With "Pre-create daily notes" enabled: +50-100ms (non-blocking)

Lethe is designed to be fast and minimal.

### How can I improve performance?

1. **Use Individual Files mode** - Better performance with large collections
2. **Archive old memos** - Move old memo files to an archive folder
3. **Disable "Pre-create daily notes"** - If you don't notice save delays (daily notes mode only)

## Migration & Compatibility

### Can I switch between storage modes?

Yes, but existing memos won't automatically convert:

**Daily Notes → Individual Files:**
- Old memos stay in daily notes
- New memos go to individual files
- Manually copy old memos if desired

**Individual Files → Daily Notes:**
- Old individual files remain
- New memos go to daily notes
- Timeline view shows both (if files are in date range)

### Does Lethe work with Periodic Notes plugin?

**Daily Notes mode:** Yes, Lethe is compatible with Periodic Notes as a Daily Notes replacement.

**Individual Files mode:** Periodic Notes doesn't apply (each memo is its own file).

### Does Lethe work on mobile?

Yes! Lethe works on Obsidian Mobile (iOS and Android).

**Note:** Hotkeys work differently on mobile. Use the ribbon icon or command palette to access Quick Capture.

### Can I use Lethe with sync services (iCloud, Dropbox, Obsidian Sync)?

Yes, Lethe creates standard Markdown files. They sync like any other Obsidian file.

### Does Lethe work with Git version control?

Yes! Memo files are plain Markdown and work great with Git.

**Tip:** Add `.obsidian/workspace*` to `.gitignore` to avoid committing UI state.

## Philosophy & Design

### Why doesn't Lethe have [feature X]?

Lethe follows a strict philosophy: **"If it doesn't help you capture thoughts faster, it doesn't belong."**

Removed features (Phases 2-4):
- Query builders (use Dataview instead)
- Heatmaps (visual clutter)
- Image sharing (out of scope)
- Multi-language support (maintenance burden)
- 40+ unnecessary settings (decision fatigue)

### Will Lethe add [feature X] in the future?

Probably not, unless it directly improves capture speed.

**Good candidates:**
- Performance optimizations
- Keyboard shortcuts
- Autocomplete improvements
- Bug fixes

**Bad candidates:**
- Social features
- Complex queries
- Visual customization
- Non-capture workflows

### Can I request a feature?

Yes! Open an issue on GitHub. But be aware: features that don't align with the minimal philosophy will be declined.

### Why was Lethe renamed from Memos?

To avoid confusion with other memo/note-taking apps and establish a unique identity.

### Is Lethe actively maintained?

Yes. Focus is on:
- Bug fixes
- Performance improvements
- Maintaining minimal scope
- Obsidian API compatibility

Large feature additions are intentionally avoided.

## Contributing

### Can I contribute to Lethe?

Yes! Contributions welcome for:
- Bug fixes
- Performance improvements
- Documentation improvements
- Code cleanup

**Not accepted:**
- Feature additions that don't improve capture speed
- UI redesigns that add complexity
- Settings that create decision fatigue

### Where's the source code?

GitHub: [kawana/lethe](https://github.com/kawana/code/Lethe) *(Update with actual URL)*

### How do I report bugs?

Open an issue on GitHub with:
1. Obsidian version
2. Lethe version
3. Steps to reproduce
4. Expected vs actual behavior
5. Console errors (if any)

## Advanced

### Can I customize the memo file template?

**Individual Files Mode:** Frontmatter is fixed, but you can edit "Memo format template" for the content portion.

**Daily Notes Mode:** Fully customizable via "Memo format template" setting.

### Can I use custom CSS to style Lethe?

Yes! Lethe follows Obsidian's CSS custom properties. Target these classes:
- `.memo-wrapper` - Individual memo cards
- `.tag-input-container` - Tag input
- `.quick-capture-modal` - Quick Capture modal

See WARP.md for architecture details.

### Can I access Lethe's API from other plugins?

Lethe doesn't expose a public API, but you can:
1. Access the plugin instance via `app.plugins.getPlugin('lethe')`
2. Use standard Obsidian file operations on memo files
3. Listen to file events for memo creation/updates

### How does tag autocomplete scan the vault?

```typescript
const metadataCache = app.metadataCache;
const files = app.vault.getMarkdownFiles();

files.forEach((file) => {
  const cache = metadataCache.getFileCache(file);

  // Inline tags: #tag
  if (cache?.tags) {
    cache.tags.forEach((tagRef) => allTags.add(tagRef.tag));
  }

  // Frontmatter tags
  if (cache?.frontmatter?.tags) {
    const fmTags = cache.frontmatter.tags;
    if (Array.isArray(fmTags)) {
      fmTags.forEach((tag) => allTags.add(tag));
    }
  }
});
```

Scans entire vault on dropdown open (cached per session for performance).

---

**Still have questions?** Open an issue on GitHub or check the [Quick Start Guide](QUICKSTART.md).
