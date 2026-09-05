import type { Config } from 'jest';

const tsJestTransform: Config['transform'] = {
  '^.+\\.ts$': [
    'ts-jest',
    {
      tsconfig: 'tsconfig.test.json',
    },
  ],
  '^.+\\.js$': '<rootDir>/scripts/jest-esm-dependency.js',
};

// Nest 12 ships ESM JavaScript. Transform that dependency through the same
// CommonJS test compiler; production builds and packed consumers stay intact.
const transformIgnorePatterns = ['/node_modules/(?!@nestjs/)'];

const config: Config = {
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/index.ts',
    '!src/**/index.ts',
    '!src/**/*.interface.ts',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['json', 'json-summary', 'lcov', 'text'],
  coverageThreshold: {
    './src/outbox.poller.ts': {
      branches: 90,
      statements: 95,
      lines: 95,
      functions: 100,
    },
    './src/outbox.admin.service.ts': {
      branches: 95,
      statements: 95,
      lines: 95,
      functions: 100,
    },
    './src/outbox.listener.ts': {
      branches: 90,
      statements: 95,
      lines: 95,
      functions: 95,
    },
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80,
    },
  },
  projects: [
    {
      displayName: 'unit',
      preset: 'ts-jest',
      testEnvironment: 'node',
      moduleFileExtensions: ['ts', 'js', 'json'],
      transform: tsJestTransform,
      transformIgnorePatterns,
      clearMocks: true,
      restoreMocks: true,
      testMatch: ['<rootDir>/test/**/*.spec.ts'],
      testPathIgnorePatterns: ['<rootDir>/test/e2e/'],
    },
    {
      displayName: 'e2e',
      preset: 'ts-jest',
      testEnvironment: 'node',
      moduleFileExtensions: ['ts', 'js', 'json'],
      transform: tsJestTransform,
      transformIgnorePatterns,
      clearMocks: true,
      restoreMocks: true,
      testMatch: ['<rootDir>/test/e2e/**/*.e2e-spec.ts'],
    },
  ],
};

export default config;
