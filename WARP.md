# WARP.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Project Overview

Lethe is an Obsidian plugin for quick capture of memos. It integrates deeply with Obsidian's Daily Notes plugin to store and retrieve memos from daily note files. The plugin uses React for UI rendering and implements a custom Redux-like state management system.

## Development Commands

### Building
```bash
# Development build with watch mode
npm run dev

# Production build
npm run build

# Build without linting (use with caution)
npm run build:nolint
```

### Linting and Formatting
```bash
# Run ESLint
npm run lint

# Auto-fix ESLint issues
npm run lint:fix

# Check Prettier formatting
npm run prettier

# Auto-fix Prettier formatting
npm run prettier:fix

# Format and lint (recommended before committing)
npm run format
```

### Testing
```bash
# Run tests
npm test

# Run tests in watch mode
npm run test:watch
```

## Architecture

### Core Plugin Structure
- `src/index.ts`: Main plugin entry point (`MemosPlugin` class)
  - Registers the custom view (`MEMOS_VIEW_TYPE`)
  - Manages plugin lifecycle (load/unload)
  - Defines commands for opening memos, quick capture, etc.
  - Loads settings and initializes services

- `src/memos.ts`: Custom Obsidian view implementation (`Memos` class)
  - Extends `ItemView` from Obsidian API
  - Renders React app into Obsidian view container
  - Handles file system events (create, modify, delete)
  - Manages responsive layout and mobile view detection

### State Management (Redux-like Pattern)
The app uses a custom Redux-like store implementation in `src/labs/`:
- `src/stores/appStore.ts`: Combines all reducers into single app store
- Individual stores in `src/stores/`:
  - `globalStateStore.ts`: UI state (mobile view, popover visibility)
  - `memoStore.ts`: Memo data and operations
  - `dailyNotesStore.ts`: Daily notes data
  - `queryStore.ts`: Query/filter data
  - `locationStore.ts`: Router state
  - `userStore.ts`: User preferences

### Service Layer
Services in `src/services/` handle business logic and dispatch state actions:
- `memoService.ts`: Fetches, creates, updates, and deletes memos
- `dailyNotesService.ts`: Interfaces with Obsidian daily notes
- `globalStateService.ts`: Manages global UI state
- `queryService.ts`: Manages saved queries/filters
- `resourceService.ts`: Handles attachments and resources

### Obsidian Integration Layer
`src/obComponents/` contains Obsidian-specific operations that interact directly with the Obsidian API:
- `obCreateMemo.ts`: Creates memos in daily notes or individual files
- `obGetMemos.ts`: Retrieves memos from daily notes files
- `obUpdateMemo.ts`: Updates existing memos
- `obDeleteMemo.ts`: Handles memo deletion and restoration
- `obGetQueries.ts`: Retrieves saved queries
- `obCreateQuery.ts`: Creates new queries
- Similar files for comments, pinning, hiding, etc.

**Key Pattern**: The `api.ts` helper wraps these obComponents functions, providing a consistent API surface similar to REST endpoints.

### React Components
`src/components/` contains UI components:
- `MemoEditor.tsx`: Main memo input component
- `Memo.tsx`: Individual memo display
- `MemoList.tsx`: Scrollable memo list
- `MemosBoard.tsx`: Main container coordinating UI
- Dialog components for various modals
- `DailyMemo.tsx`: Calendar/heatmap views

### Storage Modes
The plugin supports two storage modes (configured in settings):
1. **Daily Notes Mode** (default): Memos stored under configured heading in daily notes
2. **Individual Files Mode**: Each memo stored as separate file in configured folder

### Memo Format
Memos are stored in daily notes as:
- Regular memo: `- HH:mm {content}`
- Task memo: `- [ ] HH:mm {content}`

Memos are identified by generated IDs: `{YYYYMMDDHHmm}00{lineNum}`

### Router System
Simple client-side routing in `src/routers/`:
- `appRouter.tsx`: Top-level routes
- `homeRouter.tsx`: Home view routes
- Routes dispatch location state changes to trigger re-renders

## Key Implementation Details

### Memo Fetching and Deduplication
`memoService.fetchAllMemos()` implements deduplication to prevent concurrent fetches. If a fetch is in progress, subsequent calls return the same pending promise.

### File Change Handling
The `Memos` view listens to vault events and debounces file modifications (2 second delay) before refetching memos. It uses a `changedByMemos` flag in global state to avoid refetching when changes originate from the plugin itself.

### Mobile Responsiveness
The plugin detects mobile view in two ways:
- Platform.isMobile for actual mobile devices
- Leaf width <= 875px for narrow desktop splits

### Insert After Logic
The `insertAfterHandler` in `obCreateMemo.ts` finds the configured heading and inserts memos after it, before the next heading. This logic is adapted from the QuickAdd plugin.

## Build Output
- `main.js`: Bundled plugin code
- `styles.css`: Compiled styles from LESS files
- `manifest.json`: Plugin metadata
- Built files go to repository root (not dist/) for Obsidian to load

## Configuration
Build is managed by Vite (primary) with Rollup config as backup:
- `vite.config.js`: Main build configuration
- `rollup.config.js`: Alternative build (not currently used)
- Entry: `src/index.ts`
- External: `obsidian` API (provided by Obsidian at runtime)

## Code Style
- ESLint + Prettier enforced (see `.eslintrc.js` and `.prettierrc.js`)
- React hooks rules enabled
- TypeScript with `noImplicitAny`
- 120 character line length
- Single quotes, trailing commas

## Release Process
GitHub Actions workflow (`.github/workflows/release.yml`) triggers on release creation:
1. Builds plugin with `npm run build`
2. Creates zip file
3. Uploads `main.js`, `manifest.json`, `styles.css`, and zip to release assets
