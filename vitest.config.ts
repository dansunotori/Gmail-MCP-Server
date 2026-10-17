import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Worktrees are other checkouts of this repository: their tests are not this tree's, and
    // running both copies at once races them on shared temporary files.
    exclude: ['dist/**', 'node_modules/**', '.claude/worktrees/**', '.worktrees/**'],
  },
});
