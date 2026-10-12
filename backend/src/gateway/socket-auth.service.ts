import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { createHmac } from 'node:crypto';
import { Model } from 'mongoose';
import { isMongoId } from 'class-validator';
import { UserRole } from '../common/enums/user-role.enum';
import { SessionStatus } from '../common/enums/session-status.enum';
import { Session, SessionDocument } from '../modules/session/session.schema';
import { Table, TableDocument } from '../modules/table/table.schema';
import { UserService } from '../modules/user/user.service';

export const STAFF_ROOMS: Record<UserRole, string[]> = {
  [UserRole.KITCHEN]: ['kitchen'],
  [UserRole.WAITER]: ['waiter'],
  [UserRole.ADMIN]: ['admin', 'kitchen', 'waiter'],
};
export type SocketIdentity =
  | { kind: 'staff'; sub: string; role: UserRole; exp: number }
  | { kind: 'customer'; sessionId: string; tableId: string; exp: number };
export type CustomerIdentity = Extract<SocketIdentity, { kind: 'customer' }>;

@Injectable()
export class SocketAuthService {
  private readonly accessSecret: string;
  private readonly customerSecret: string;

  constructor(
    private readonly jwt: JwtService,
    config: ConfigService,
    @InjectModel(Session.name)
    private readonly sessions: Model<SessionDocument>,
    @InjectModel(Table.name) private readonly tables: Model<TableDocument>,
    private readonly users: UserService,
  ) {
    // Do not accept the HTTP development fallback as a signing key for sockets.
    this.accessSecret = config.getOrThrow<string>('JWT_ACCESS_SECRET');
    this.customerSecret = createHmac('sha256', this.accessSecret)
      .update('customer-socket-capability-v1')
      .digest('hex');
  }

  private token(value: unknown): string {
    if (typeof value !== 'string' || !value || value.length > 8192)
      throw new UnauthorizedException('Thiếu hoặc sai token Socket');
    return value;
  }

  private async verify<T extends object = Record<string, any>>(
    token: unknown,
    secret: string,
    audience?: string,
  ): Promise<T> {
    try {
      return await this.jwt.verifyAsync<T>(this.token(token), {
        secret,
        algorithms: ['HS256'],
        ...(audience ? { audience } : {}),
      });
    } catch {
      throw new UnauthorizedException('Token không hợp lệ hoặc đã hết hạn');
    }
  }

  async authenticate(auth: {
    token?: unknown;
    customerToken?: unknown;
  }): Promise<SocketIdentity> {
    if (auth?.token !== undefined) {
      const claims = await this.verify(auth.token, this.accessSecret);
      if (
        !isMongoId(claims.sub) ||
        typeof claims.email !== 'string' ||
        !Object.values(UserRole).includes(claims.role)
      )
        throw new UnauthorizedException('Staff token không hợp lệ');
      const user = await this.users.findActiveAuthUser(claims.sub);
      if (!user || !Object.values(UserRole).includes(user.role))
        throw new UnauthorizedException('Tài khoản không còn hoạt động');
      const identity: SocketIdentity = {
        kind: 'staff',
        sub: claims.sub,
        role: user.role,
        exp: claims.exp,
      };
      this.assertFresh(identity);
      return identity;
    }
    const identity = await this.verifyCustomer(auth?.customerToken);
    await this.authorizeCustomer(
      identity,
      identity.sessionId,
      identity.tableId,
    );
    return identity;
  }

  assertFresh(identity?: SocketIdentity): asserts identity is SocketIdentity {
    if (
      !identity ||
      !Number.isFinite(identity.exp) ||
      identity.exp * 1000 <= Date.now()
    )
      throw new UnauthorizedException('Quyền Socket đã hết hạn');
  }

  async authorizeStaff(identity: SocketIdentity | undefined) {
    this.assertFresh(identity);
    if (identity.kind !== 'staff')
      throw new UnauthorizedException('Staff required');
    const user = await this.users.findActiveAuthUser(identity.sub);
    // A role change invalidates existing room membership. Reconnect resolves
    // the current role instead of keeping any of the old role's subscriptions.
    if (!user || user.role !== identity.role)
      throw new UnauthorizedException('Quyền nhân viên đã thay đổi');
    return identity;
  }

  async authorizeCustomer(
    identity: SocketIdentity | undefined,
    sessionId?: string,
    tableId?: string,
  ) {
    this.assertFresh(identity);
    if (
      identity.kind !== 'customer' ||
      (sessionId !== undefined && sessionId !== identity.sessionId) ||
      (tableId !== undefined && tableId !== identity.tableId)
    )
      throw new UnauthorizedException('Không có quyền truy cập phiên/bàn này');
    const session = await this.sessions.exists({
      _id: identity.sessionId,
      status: SessionStatus.ACTIVE,
      tableIds: identity.tableId,
    });
    const table = await this.tables.exists({
      _id: identity.tableId,
      currentSessionId: identity.sessionId,
    });
    if (!session || !table)
      throw new UnauthorizedException('Quyền phiên/bàn không còn hiệu lực');
    return identity;
  }

  async issueCustomer(sessionId: string, tableId: string) {
    const exp = Math.floor(Date.now() / 1000) + 12 * 60 * 60;
    const identity: CustomerIdentity = {
      kind: 'customer',
      sessionId,
      tableId,
      exp,
    };
    await this.authorizeCustomer(identity, sessionId, tableId);
    const customerToken = await this.jwt.signAsync(identity, {
      secret: this.customerSecret,
      algorithm: 'HS256',
      audience: 'customer-socket',
    });
    return { customerToken, sessionId, tableId, expiresAt: exp * 1000 };
  }

  async verifyCustomer(token: unknown): Promise<CustomerIdentity> {
    const identity = await this.verify<CustomerIdentity>(
      token,
      this.customerSecret,
      'customer-socket',
    );
    if (
      identity.kind !== 'customer' ||
      !isMongoId(identity.sessionId) ||
      !isMongoId(identity.tableId)
    )
      throw new UnauthorizedException('Customer token không hợp lệ');
    this.assertFresh(identity);
    return identity;
  }

  issueTableEntry(tableId: string) {
    return this.jwt.signAsync(
      { tableId },
      {
        secret: this.customerSecret,
        algorithm: 'HS256',
        audience: 'table-entry',
        expiresIn: '365d',
      },
    );
  }

  async authorizeEntry(
    tableId: string,
    tableToken?: string,
    customerToken?: string,
  ) {
    if (customerToken) {
      try {
        const identity = await this.verifyCustomer(customerToken);
        return await this.authorizeCustomer(identity, undefined, tableId);
      } catch (error) {
        if (!(error instanceof UnauthorizedException) || !tableToken)
          throw error;
      }
    }
    if (tableToken) {
      const claims = await this.verify(
        tableToken,
        this.customerSecret,
        'table-entry',
      );
      if (claims.tableId !== tableId || !Number.isFinite(claims.exp))
        throw new UnauthorizedException('QR không thuộc bàn này');
      return undefined;
    }
    throw new UnauthorizedException('Vui lòng quét QR hợp lệ tại bàn');
  }
}
