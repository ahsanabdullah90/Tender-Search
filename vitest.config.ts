import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts', 'src/**/*.tsx', 'server.ts'],
      exclude: [
        'src/main.tsx',
        'src/types.ts',
        'vite.config.ts',
        'vitest.config.ts',
        'tests/**',
        'dist/**',
        'data*/**',
        'scripts/seed-sample.ts'
      ],
      thresholds: {
        lines: 100,
        functions: 100,
        statements: 100,
        branches: 98
      }
    },
    projects: [
      {
        test: {
          name: 'node',
          include: ['tests/{unit,db,scraper,api}/**/*.test.ts'],
          environment: 'node',
          setupFiles: ['./tests/setup/node-setup.ts']
        }
      },
      {
        test: {
          name: 'jsdom',
          include: ['tests/ui/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
          setupFiles: ['./tests/setup/jsdom-setup.ts']
        }
      }
    ]
  }
});
