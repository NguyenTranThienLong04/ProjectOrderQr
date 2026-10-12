const { MongoClient } = require('mongoose').mongo;

function validateEnvironment(env = process.env) {
  if (env.NODE_ENV !== 'production')
    throw new Error('Docker requires NODE_ENV=production');
  for (const name of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET']) {
    const value = env[name]?.trim();
    if (
      !value ||
      value.length < 32 ||
      /<|>|change[-_ ]?me|replace|generate|default.*secret/i.test(value)
    ) {
      throw new Error(
        `${name} must be a generated random secret of at least 32 characters, not a placeholder`,
      );
    }
  }
  if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET)
    throw new Error('JWT secrets must be different');
  if (!env.MONGODB_URI) throw new Error('MONGODB_URI is required');
  for (const name of ['FRONTEND_URL', 'CORS_ORIGIN', 'VNP_RETURN_URL']) {
    let url;
    try {
      url = new URL(env[name]);
    } catch {
      throw new Error(`${name} must be a public HTTP(S) URL`);
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      ['backend', 'frontend', 'mongodb'].includes(url.hostname)
    ) {
      throw new Error(
        `${name} must use the browser-visible host, not a Docker service name`,
      );
    }
    if (name !== 'VNP_RETURN_URL' && env[name] !== url.origin) {
      throw new Error(
        `${name} must be an origin without path, query or trailing slash`,
      );
    }
    if (
      name === 'VNP_RETURN_URL' &&
      (url.pathname !== '/vnpay/return' || url.search || url.hash)
    ) {
      throw new Error(
        'PUBLIC_BACKEND_URL must be an origin without a trailing slash',
      );
    }
  }
  const port = Number(env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('PORT must be a valid TCP port');
}

async function checkMongo(transaction = false) {
  const client = new MongoClient(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 2000,
    connectTimeoutMS: 2000,
    socketTimeoutMS: 2000,
  });
  try {
    await client.connect();
    const hello = await client.db().admin().command({ hello: 1 });
    if (
      hello.setName !== 'rs0' ||
      !hello.isWritablePrimary ||
      hello.logicalSessionTimeoutMinutes == null
    ) {
      throw new Error('MongoDB rs0 is not ready for transactions');
    }
    if (transaction) {
      const session = client.startSession();
      try {
        session.startTransaction({ readConcern: { level: 'snapshot' } });
        await client
          .db()
          .collection('users')
          .findOne(
            { _id: '__docker_readiness__' },
            { session, maxTimeMS: 2000 },
          );
        await session.abortTransaction();
      } finally {
        await session.endSession();
      }
    }
  } finally {
    await client.close();
  }
}

module.exports = { validateEnvironment, checkMongo };
