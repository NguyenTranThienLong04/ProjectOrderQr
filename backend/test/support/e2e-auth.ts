import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { Model } from 'mongoose';
import request from 'supertest';
import type { App } from 'supertest/types';
import { UserRole } from '../../src/common/enums/user-role.enum';
import { SocketAuthService } from '../../src/gateway/socket-auth.service';
import { AuthService } from '../../src/modules/auth/auth.service';
import { User, UserDocument } from '../../src/modules/user/user.schema';
import { Table, TableDocument } from '../../src/modules/table/table.schema';
import {
  Session,
  SessionDocument,
} from '../../src/modules/session/session.schema';

export async function createStaffFixture(
  app: INestApplication,
  role: UserRole,
) {
  const users = app.get<Model<UserDocument>>(getModelToken(User.name));
  const user = await users.create({
    fullName: `E2E ${role}`,
    email: `${role}-${randomUUID()}@test.invalid`,
    passwordHash: 'unused-e2e-fixture',
    role,
    isActive: true,
  });
  const { accessToken } = await app.get(AuthService).generateTokens({
    id: user.id,
    email: user.email,
    role: user.role,
    fullName: user.fullName,
  });
  return { user, accessToken };
}

export async function createStaffFixtures(
  app: INestApplication,
  roles: UserRole[],
) {
  const fixtures = await Promise.all(
    roles.map((role) => createStaffFixture(app, role)),
  );
  return {
    token(role: UserRole): string {
      const fixture = fixtures.find(({ user }) => user.role === role);
      if (!fixture) throw new Error(`Missing staff fixture: ${role}`);
      return fixture.accessToken;
    },
    async cleanup() {
      await app.get<Model<UserDocument>>(getModelToken(User.name)).deleteMany({
        _id: { $in: fixtures.map(({ user }) => user._id) },
      });
    },
  };
}

/** A separate QR session for tests that must reject a real customer on staff routes. */
export async function createCustomerFixture(app: INestApplication<App>) {
  const tables = app.get<Model<TableDocument>>(getModelToken(Table.name));
  const sessions = app.get<Model<SessionDocument>>(getModelToken(Session.name));
  await Promise.all([tables.init(), sessions.init()]);
  const table = await tables.create({
    tableCode: `E2E-${randomUUID()}`,
    qrCodeUrl: 'test-only',
  });
  const grant = await scanTableFixture(app, table.id);
  return {
    ...grant,
    async cleanup() {
      await sessions.deleteOne({ _id: grant.sessionId });
      await tables.deleteOne({ _id: table._id });
    },
  };
}

export interface CustomerSessionFixture {
  sessionId: string;
  tableId: string;
  tableIds: string[];
  version: number;
  cart: Array<{ dishId: string; quantity: number }>;
  customerToken: string;
}

export async function scanTableFixture(
  app: INestApplication<App>,
  tableId: string,
  previousCustomerToken?: string,
): Promise<CustomerSessionFixture> {
  const auth = app.get(SocketAuthService);
  const entryToken = await auth.issueTableEntry(tableId);
  const scan = request(app.getHttpServer())
    .get('/sessions/active')
    .query({ tableId })
    .set('x-table-token', entryToken);
  if (previousCustomerToken)
    scan.set('x-customer-token', previousCustomerToken);
  const response = await scan.expect(200);
  const session = response.body as CustomerSessionFixture;
  // Exercise both QR verification over HTTP and the resulting live capability.
  const identity = await auth.authenticate({
    customerToken: session.customerToken,
  });
  expect(identity).toMatchObject({
    kind: 'customer',
    tableId,
    sessionId: session.sessionId,
  });
  return session;
}
