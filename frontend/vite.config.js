import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  // Relative base + repo-root outDir keep the build behaving like the old
  // document.baseURI-relative CSV fetches, regardless of GitHub Pages subpath.
  base: './',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
})
