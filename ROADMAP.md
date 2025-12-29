# Lethe Development Roadmap

## Vision: "Just capture it. But fast."

Core principles:
- **Speed**: Instant capture, zero friction
- **Simplicity**: Fewer features, done well
- **Focus**: One job - capturing thoughts quickly

---

## Current State (Problems)

| Metric | Current | Target |
|--------|---------|--------|
| Lines of code | 14,788 | ~4,000 |
| Settings | 40+ | ~10 |
| Components | 35+ | ~12 |
| Store slices | 8 | 2-3 |
| Time to capture | 3+ clicks | 1 hotkey |

**Bloat to remove:**
- Query system (400+ LOC)
- Image sharing dialogs (400+ LOC)
- Comments/replies system (300+ LOC)
- Heatmap visualization (250+ LOC)
- 20+ language translations
- Dataview integration complexity

---

## Phase 1: Speed First (v1.1)

**Goal:** Make capture instant

### 1.1 Global Hotkey Capture
- Add command: "Quick capture" - opens minimal popup anywhere in Obsidian
- Single input field + save button
- No need to open full Lethe view
- Auto-close after save

### 1.2 Reduce Startup Time
- Lazy load memo list (don't parse all files on open)
- Remove unnecessary event listeners
- Defer non-essential UI rendering

### 1.3 Streamline Save Flow
- Remove confirmation dialogs
- Instant save feedback (subtle, non-blocking)
- Pre-create daily note in background

**Files to modify:**
- `src/index.ts` - Add quick capture command
- `src/memos.ts` - Optimize onOpen
- `src/obComponents/obCreateMemo.ts` - Streamline save

---

## Phase 2: Simplify UI (v1.2)

**Goal:** Remove visual clutter

### 2.1 Remove Non-Essential UI
- Remove sidebar by default (tags, queries, heatmap)
- Remove "Daily Memos" dialog
- Remove share as image feature
- Simplify header (just search + settings)

### 2.2 Simplify Memo Display
- Cleaner memo cards
- Remove inline editing complexity
- Single-click actions and keyboard shortcuts (ctr+enter to submit)

### 2.3 Mobile-First Editor
- Always show editor at top
- Remove floating button complexity
- Larger touch targets

**Files to remove/simplify:**
- `src/components/Sidebar.tsx` - Make optional/remove
- `src/components/UsageHeatMap.tsx` - Remove
- `src/components/QueryList.tsx` - Remove
- `src/components/ShareMemoImageDialog.tsx` - Remove
- `src/components/DailyMemoDiaryDialog.tsx` - Remove

---

## Phase 3: Settings Reduction (v1.3)

**Goal:** Sensible defaults, fewer choices

### Keep Only Essential Settings (~10):
1. Insert after heading
2. Process memos below
3. Storage mode (daily notes / individual files)
4. Individual memo folder (if applicable)
5. Default prefix (list/task)
6. Show time in memos
7. User name
8. Focus on editor
9. Default tags (for individual files)
10. Theme (follow Obsidian)

### Remove These Settings:
- Share footer customization
- Background images
- Memo composition format
- Query/delete file names
- Multiple date format options
- Comment-related settings
- Sidebar visibility toggles
- Copy format options

**Files to modify:**
- `src/setting.ts` - Reduce to ~10 settings
- `src/memos.ts` - Remove unused exports

---

## Phase 4: Code Cleanup (v1.4)

**Goal:** Maintainable, lean codebase

### 4.1 Remove Dead Code
- Delete unused components
- Remove comment system entirely
- Remove dataview integration
- Remove translation files (English only)

### 4.2 Simplify State Management
Reduce from 8 slices to 3:
- `memoState` - Memo data
- `uiState` - UI state (loading, filters)
- `settingsState` - User preferences

### 4.3 Reduce Dependencies
Remove:
- `react-rnd` (unused)
- `@webscopeio/react-textarea-autocomplete` (use native)
- `focus-trap-react` (unnecessary)
- `obsidian-dataview` (optional feature removed)

**Estimated result:**
- ~4,000 LOC (73% reduction)
- ~12 components
- ~10 settings
- Faster load, smaller bundle

---

## Phase 5: Polish (v2.0)

**Goal:** Refined, fast experience

### 5.1 Performance
- Bundle size optimization
- CSS reduction (from 283KB)
- Memory usage audit

### 5.2 UX Refinement
- Keyboard navigation
- Better empty states
- Subtle animations (optional)

### 5.3 Documentation
- Simple README
- Quick start guide
- No feature bloat in docs

---

## Implementation Priority

| Version | Focus | Key Deliverable |
|---------|-------|-----------------|
| v1.1 | Speed | Global quick capture hotkey |
| v1.2 | UI | Clutter-free interface |
| v1.3 | Settings | 10 settings max |
| v1.4 | Code | 73% code reduction |
| v2.0 | Polish | Production-ready minimal app |

---

## What Lethe Will NOT Have

Intentionally excluded for simplicity:
- ❌ Query builder/saved queries
- ❌ Heatmap/activity visualization
- ❌ Image sharing/export
- ❌ Comments/replies on memos
- ❌ Dataview integration
- ❌ Multiple language support
- ❌ Complex memo composition formats
- ❌ Recycle bin with restore

**Philosophy:** If it doesn't help capture faster, it doesn't belong.
