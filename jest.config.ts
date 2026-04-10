import type { Config } from 'jest';

const tsJestTransform: Config['transform'] = {
  '^.+\\.ts$': [
    'ts-jest',
    {
      tsconfig: 'tsconfig.json',
    },
  ],
};

const config: Config = {
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/index.ts',
    '!src/**/index.ts',
    '!src/**/*.interface.ts',
  ],
  coverageDirectory: 'coverage',
  coverageThreshold: {
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
      clearMocks: true,
      restoreMocks: true,
      testMatch: ['<rootDir>/test/e2e/**/*.e2e-spec.ts'],
    },
  ],
};

export default config;
