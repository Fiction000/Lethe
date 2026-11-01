import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// import reactSvgPlugin from 'vite-plugin-react-svg';
import svgr from 'vite-plugin-svgr';

export default defineConfig(({ mode }) => {
  return {
    plugins: [
      // Vite 3 does not resolve vfile 6's package-import aliases. Keep the
      // compatibility mapping local to vfile and select its browser shims.
      {
        name: 'lethe-vfile-browser-imports',
        resolveId(id, importer) {
          if (importer?.includes('/node_modules/vfile/lib/') && ['#minpath', '#minproc', '#minurl'].includes(id)) {
            return path.join(path.dirname(importer), `${id.slice(1)}.browser.js`);
          }
          return null;
        },
      },
      react(),
      svgr({
        svgrOptions: {
          exportType: 'default',
        },
      }),
    ],
    css: {
      preprocessorOptions: {
        less: {
          compress: true,
        },
      },
    },
    build: {
      sourcemap: mode === 'development' ? 'inline' : false,
      minify: mode === 'development' ? false : 'esbuild',
      // Use Vite lib mode https://vitejs.dev/guide/build.html#library-mode
      lib: {
        entry: path.resolve(__dirname, './src/index.ts'),
        formats: ['cjs'],
      },
      rollupOptions: {
        output: {
          // Obsidian installs one main.js; do not leave runtime require chunks.
          inlineDynamicImports: true,
          // Overwrite default Vite output fileName
          entryFileNames: 'main.js',
          assetFileNames: 'styles.css',
        },
        external: ['obsidian'],
      },
      // Use root as the output dir
      emptyOutDir: false,
      outDir: '.',
    },
  };
});
