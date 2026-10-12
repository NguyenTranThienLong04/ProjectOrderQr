// Test configuration must never read the application's .env, even via AppModule.
jest.mock('dotenv/config', () => ({}));
const { ConfigModule } = require('@nestjs/config');
const forRoot = ConfigModule.forRoot;
ConfigModule.forRoot = function (options = {}) {
  return forRoot.call(this, { ...options, ignoreEnvFile: true });
};
