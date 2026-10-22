import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// 화면 4개(시작·출력·편집기·리모컨)를 각각 별도 HTML 로 빌드한다.
const root = import.meta.dirname;

export default defineConfig({
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        index: resolve(root, 'index.html'),
        output: resolve(root, 'output/index.html'),
        editor: resolve(root, 'editor/index.html'),
        remote: resolve(root, 'remote/index.html'),
      },
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
