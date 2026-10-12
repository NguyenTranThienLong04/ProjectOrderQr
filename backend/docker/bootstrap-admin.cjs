// Explicit operator command only. Never imported by application startup.
const mongoose = require('mongoose');
const { hash } = require('bcrypt');
const { User, UserSchema } = require('../dist/src/modules/user/user.schema');
const { UserRole } = require('../dist/src/common/enums/user-role.enum');
const { validateEnvironment, checkMongo } = require('./runtime.cjs');

async function main() {
  validateEnvironment();
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new Error('Set ADMIN_EMAIL');
  if (
    !password ||
    password.length < 12 ||
    Buffer.byteLength(password) > 72 ||
    /<|>|change[-_ ]?me|replace/i.test(password)
  ) {
    throw new Error(
      'Set ADMIN_PASSWORD to a unique password (12+ characters, at most 72 UTF-8 bytes)',
    );
  }
  await checkMongo(true);
  await mongoose.connect(process.env.MONGODB_URI);
  try {
    const users = mongoose.model(User.name, UserSchema);
    await users.init();
    if (await users.exists({ email }))
      throw new Error('Account already exists; no changes made');
    await users.create({
      email,
      fullName: 'Administrator',
      passwordHash: await hash(password, 10),
      role: UserRole.ADMIN,
      isActive: true,
    });
    console.log('Administrator created. Sign in at the frontend /login route.');
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  // Do not print driver errors/documents, which may contain credentials.
  console.error(
    error.code === 11000
      ? 'Account already exists; no changes made'
      : error.name === 'Error'
        ? error.message
        : 'Admin bootstrap failed',
  );
  process.exitCode = 1;
});
