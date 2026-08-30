module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: 'tsconfig.json',
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'prettier',
  ],
  root: true,
  env: {
    node: true,
    jest: true,
  },
  ignorePatterns: [
    'dist/',
    'coverage/',
    'test/e2e/generated/',
    'test/modern-consumer/fixture/',
    'jest.config.ts',
  ],
  rules: {
    '@typescript-eslint/no-explicit-any': 'off',
  },
};
