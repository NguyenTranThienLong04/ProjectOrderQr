require('./no-env.cjs');
const mongoose = require('mongoose');
const refuse = () => {
  throw new Error(
    'Unit tests cannot connect to MongoDB; use test:integration or test:e2e',
  );
};
// Plain assignments survive jest.restoreAllMocks() in individual suites.
mongoose.Connection.prototype.openUri = refuse;
mongoose.mongo.MongoClient.prototype.connect = refuse;
