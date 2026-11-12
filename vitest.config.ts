import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 30000,
    maxWorkers: 4,
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
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 70
      }
    },
    projects: [
      {
        test: {
          name: 'node',
          testTimeout: 30000,
          include: ['tests/{unit,db,scraper,api}/**/*.test.ts'],
          environment: 'node',
          setupFiles: ['./tests/setup/node-setup.ts']
        }
      },
      {
        test: {
          name: 'jsdom',
          testTimeout: 30000,
          include: ['tests/ui/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
          setupFiles: ['./tests/setup/jsdom-setup.ts']
        }
      }
    ]
  }
});
