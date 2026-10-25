/** Unit specs live next to the code; e2e specs in test/ hit a real Postgres (DATABASE_URL_TEST). */
module.exports = {
  testEnvironment: 'node',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  testRegex: '(src|test)/.*\\.spec\\.ts$',
  moduleFileExtensions: ['ts', 'js', 'json'],
};
