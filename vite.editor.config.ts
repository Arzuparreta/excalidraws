import { defineConfig } from 'vite';

export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist/editor',
    target: 'es2022',
    license: true,
    lib: {
      entry: 'src/editor/ExcalidrawAdapter.tsx',
      formats: ['es'],
      fileName: () => 'editor.js',
      cssFileName: 'editor',
    },
    rollupOptions: {
      output: {
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
});
