import 'obsidian';

declare module 'obsidian' {
  interface WorkspaceLeaf {
    width: number;
  }

  interface App {
    plugins: {
      getPlugin(name: string): any;
    };
  }

  interface MetadataCache {
    // Dataview integration removed (Phase 4)
  }

  interface Workspace {
    on(name: 'receive-text-menu', callback: (menu: Menu, source: string) => any, ctx?: any): EventRef;
    on(name: 'receive-files-menu', callback: (menu: Menu, file: array) => any, ctx?: any): EventRef;
  }
}
