export default {
  testEnvironment: 'node',
  // ESM support: required because the package uses "type": "module".
  transform: {},
  setupFiles: ['<rootDir>/test/setup-react-act-environment.js'],
};
