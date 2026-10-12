import { testMongoUri } from '../../../test/support/test-database';
import { ForbiddenException, INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { hash } from 'bcrypt';
import { createHash } from 'node:crypto';
import { Connection, createConnection, Types } from 'mongoose';
import request from 'supertest';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';
import { User, UserSchema } from '../user/user.schema';
import { UserService } from '../user/user.service';
import { UserRole } from '../../common/enums/user-role.enum';

// Database lifecycle is owned by the shared integration harness.
describe('Refresh rotation and current staff authorization', () => {
  const accessSecret = 'auth-test-access-012345678901234567890';
  const refreshSecret = 'auth-test-refresh-012345678901234567890';
  const config = new ConfigService({
    JWT_ACCESS_SECRET: accessSecret,
    JWT_REFRESH_SECRET: refreshSecret,
  });
  const jwt = new JwtService();
  const fingerprint = (token: string) =>
    createHash('sha256').update(token).digest('hex');
  const connections: Connection[] = [];

  let first: ReturnType<typeof instance>;
  let second: ReturnType<typeof instance>;
  let app: INestApplication;
  let passwordHash: string;

  function instance(connection: Connection) {
    const model = connection.model(User.name, UserSchema);
    const users = new UserService(model);
    return { model, users, auth: new AuthService(users, jwt, config) };
  }

  beforeAll(async () => {
    const uri = testMongoUri();
    const connection = createConnection(uri);
    connections.push(connection);
    await connection.asPromise();
    const other = createConnection(uri);
    connections.push(other);
    await other.asPromise();
    first = instance(connection);
    second = instance(other);
    await first.model.init();
    passwordHash = await hash('test-password', 4);
    const module = await Test.createTestingModule({
      imports: [PassportModule.register({ defaultStrategy: 'jwt' })],
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: first.auth },
        { provide: UserService, useValue: first.users },
        {
          provide: JwtStrategy,
          useValue: new JwtStrategy(config, first.users),
        },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  }, 30000);

  afterAll(async () => {
    jest.restoreAllMocks();
    await app?.close();
    await Promise.all(connections.map((connection) => connection.close()));
  }, 15000);

  beforeEach(() => jest.restoreAllMocks());

  async function seed() {
    const user = await first.model.create({
      email: `${new Types.ObjectId()}@auth.test`,
      fullName: 'Test staff',
      passwordHash,
      role: UserRole.ADMIN,
      isActive: true,
    });
    // Exercise the existing login token path without re-testing login CRUD.
    const tokens = await first.auth.login(user.email, 'test-password');
    return { user, tokens };
  }
  const stored = (id: string) =>
    first.model.findById(id).select('+refreshTokenHash').lean();

  describe('1. verify before identity/query/mutation', () => {
    it('rejects forged, malformed, expired and wrong-purpose tokens without touching any user', async () => {
      const { user, tokens } = await seed();
      const before = await first.model
        .find()
        .select('+refreshTokenHash')
        .lean();
      const read = jest.spyOn(first.users, 'findActiveAuthUser');
      const write = jest.spyOn(first.model, 'updateOne');
      const claims = { sub: user.id, jti: 'test-id', tokenUse: 'refresh' };
      const invalid = [
        'not-a-jwt',
        jwt.sign(claims, { secret: 'forged', expiresIn: '7d' }),
        jwt.sign(claims, { secret: refreshSecret, expiresIn: -1 }),
        jwt.sign(
          { ...claims, sub: { $ne: null } },
          { secret: refreshSecret, expiresIn: '7d' },
        ),
        jwt.sign({ sub: user.id }, { secret: refreshSecret, expiresIn: '7d' }),
        tokens.accessToken,
      ];
      for (const refreshToken of invalid) {
        await request(app.getHttpServer())
          .post('/auth/refresh')
          .send({ refreshToken })
          .expect(403);
      }
      expect(read).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
      expect(
        await first.model.find().select('+refreshTokenHash').lean(),
      ).toEqual(before);
    });
  });

  describe('2. rotation/storage/replay', () => {
    it('hashes the entire JWT, rotates even within one second and rejects replay without revoking the winner', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(Date.now());
      const { user, tokens } = await seed();
      const initial = await stored(user.id);
      expect(initial!.refreshTokenHash).toBe(fingerprint(tokens.refreshToken));
      expect(initial!.refreshTokenHash).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(initial)).not.toContain(tokens.refreshToken);
      expect(
        (await first.model.findById(user.id))!.refreshTokenHash,
      ).toBeUndefined();
      const response = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: tokens.refreshToken })
        .expect(200);
      const rotated = response.body;
      expect(rotated.refreshToken).not.toBe(tokens.refreshToken);
      const oldClaims = jwt.verify(tokens.refreshToken, {
        secret: refreshSecret,
      });
      const newClaims = jwt.verify(rotated.refreshToken, {
        secret: refreshSecret,
      });
      expect(newClaims.iat).toBe(oldClaims.iat);
      expect(newClaims.jti).not.toBe(oldClaims.jti);
      expect((await stored(user.id))!.refreshTokenHash).toBe(
        fingerprint(rotated.refreshToken),
      );
      const after = await stored(user.id);
      await expect(
        first.auth.refreshTokens(tokens.refreshToken),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(await stored(user.id)).toEqual(after);
      await expect(
        first.auth.refreshTokens(rotated.refreshToken),
      ).resolves.toHaveProperty('refreshToken');
    });

    it('rejects legacy bcrypt storage, requiring a new login', async () => {
      const { user, tokens } = await seed();
      await first.model.updateOne(
        { _id: user.id },
        { refreshTokenHash: await hash(tokens.refreshToken, 4) },
      );
      await expect(
        first.auth.refreshTokens(tokens.refreshToken),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('3. concurrent rotation on independent DB connections', () => {
    it('allows exactly one CAS winner and only its refresh token remains valid', async () => {
      const { user, tokens } = await seed();
      let reads = 0;
      let release!: () => void;
      const barrier = new Promise<void>((done) => {
        release = done;
      });
      for (const instance of [first, second]) {
        const read = instance.users.findActiveAuthUser.bind(instance.users);
        jest
          .spyOn(instance.users, 'findActiveAuthUser')
          .mockImplementationOnce(async (id) => {
            const snapshot = await read(id);
            if (++reads === 2) release();
            await barrier;
            return snapshot;
          });
      }
      const attempts = await Promise.allSettled([
        first.auth.refreshTokens(tokens.refreshToken),
        second.auth.refreshTokens(tokens.refreshToken),
      ]);
      const winners = attempts.filter(
        (result) => result.status === 'fulfilled',
      );
      const losers = attempts.filter((result) => result.status === 'rejected');
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(losers[0].reason).toBeInstanceOf(ForbiddenException);
      const winner = winners[0].value;
      expect((await stored(user.id))!.refreshTokenHash).toBe(
        fingerprint(winner.refreshToken),
      );
      await expect(
        second.auth.refreshTokens(tokens.refreshToken),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        second.auth.refreshTokens(winner.refreshToken),
      ).resolves.toHaveProperty('refreshToken');
    });
  });

  describe('4. logout/disable/current role', () => {
    it('backend logout revokes the rotated token', async () => {
      const { user, tokens } = await seed();
      const rotated = await first.auth.refreshTokens(tokens.refreshToken);
      await request(app.getHttpServer())
        .post('/auth/logout')
        .auth(rotated.accessToken, { type: 'bearer' })
        .expect(200);
      expect((await stored(user.id))!.refreshTokenHash).toBeNull();
      await expect(
        first.auth.refreshTokens(rotated.refreshToken),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it.each(['logout', 'disable', 'role-change'] as const)(
      'cannot resurrect refresh state if %s wins before CAS',
      async (action) => {
        const { user, tokens } = await seed();
        const rotate = first.users.rotateRefreshToken.bind(first.users);
        jest
          .spyOn(first.users, 'rotateRefreshToken')
          .mockImplementationOnce(async (...args) => {
            if (action === 'logout') await second.auth.logout(user.id);
            else
              await second.users.updateManagedUser(
                user.id,
                action === 'disable'
                  ? { isActive: false }
                  : { role: UserRole.WAITER },
              );
            return rotate(...args);
          });
        await expect(
          first.auth.refreshTokens(tokens.refreshToken),
        ).rejects.toBeInstanceOf(ForbiddenException);
        if (action === 'role-change') {
          const current = await first.auth.refreshTokens(tokens.refreshToken);
          expect(current.user.role).toBe(UserRole.WAITER);
          expect(
            jwt.verify(current.accessToken, { secret: accessSecret }).role,
          ).toBe(UserRole.WAITER);
        } else expect((await stored(user.id))!.refreshTokenHash).toBeNull();
      },
    );

    it('HTTP authorization uses current role and disable revokes refresh even after re-enable', async () => {
      const { user, tokens } = await seed();
      await first.users.updateManagedUser(user.id, { role: UserRole.WAITER });
      const profile = await request(app.getHttpServer())
        .post('/auth/me')
        .auth(tokens.accessToken, { type: 'bearer' })
        .expect(201);
      expect(profile.body.user.role).toBe(UserRole.WAITER);
      await request(app.getHttpServer())
        .post('/auth/register')
        .auth(tokens.accessToken, { type: 'bearer' })
        .send({})
        .expect(403);
      await first.users.updateManagedUser(user.id, { isActive: false });
      await request(app.getHttpServer())
        .post('/auth/me')
        .auth(tokens.accessToken, { type: 'bearer' })
        .expect(401);
      await expect(
        first.auth.refreshTokens(tokens.refreshToken),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await first.users.updateManagedUser(user.id, { isActive: true });
      await expect(
        first.auth.refreshTokens(tokens.refreshToken),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
