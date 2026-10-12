module.exports = async () => {
  await global.__stopTestMongo?.();
  delete process.env.OWNED_TEST_MONGO_URI;
};
