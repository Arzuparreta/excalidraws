import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
import { readFileSync } from 'node:fs';

export default defineConfig({
  plugins: [
    solid(),
    {
      name: 'shell-distribution-boundary',
      generateBundle(_options, bundle) {
        for (const chunk of Object.values(bundle)) {
          if (
            chunk.type === 'chunk' &&
            Object.keys(chunk.modules).some((id) =>
              /node_modules\/(?:@excalidraw\/excalidraw|react|react-dom)\//.test(id),
            )
          )
            throw new Error('The shell must not bundle Excalidraw or React.');
        }
        for (const fileName of ['favicon.ico', 'favicon.svg', 'apple-touch-icon.png'])
          this.emitFile({
            type: 'asset',
            fileName,
            source: readFileSync(new URL(`./public/${fileName}`, import.meta.url)),
          });
      },
    },
  ],
  build: { outDir: 'dist/client', copyPublicDir: false },
  server: { proxy: { '/api': 'http://127.0.0.1:3001', '/editor': 'http://127.0.0.1:3001' } },
});
