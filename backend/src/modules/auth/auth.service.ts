import {
  Injectable,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UserService } from '../user/user.service';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { createHash, randomUUID } from 'node:crypto';
import { isMongoId } from 'class-validator';
import { UserRole } from '../../common/enums/user-role.enum';

interface TokenUser {
  id: string;
  email: string;
  role: UserRole;
  fullName: string;
}

@Injectable()
export class AuthService {
  private readonly accessSecret: string;
  private readonly refreshSecret: string;

  constructor(
    private readonly userService: UserService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {
    this.accessSecret =
      this.configService.get<string>('JWT_ACCESS_SECRET') ||
      'default_access_secret_1234567890';
    this.refreshSecret =
      this.configService.get<string>('JWT_REFRESH_SECRET') ||
      'default_refresh_secret_1234567890_refresh';
  }

  async validateUser(email: string, pass: string): Promise<any> {
    const user = await this.userService.findByEmailWithPassword(email);
    if (!user || !user.isActive) {
      return null;
    }
    const isMatch = await bcrypt.compare(pass, user.passwordHash);
    if (isMatch) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { passwordHash, ...result } = user.toObject();
      return result;
    }
    return null;
  }

  private fingerprint(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }

  private async signTokens(user: TokenUser) {
    const payload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      fullName: user.fullName,
    };

    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(payload, {
        secret: this.accessSecret,
        algorithm: 'HS256',
        expiresIn: '15m',
      }),
      this.jwtService.signAsync(
        { sub: user.id, tokenUse: 'refresh' },
        {
          secret: this.refreshSecret,
          algorithm: 'HS256',
          jwtid: randomUUID(),
          expiresIn: '7d',
        },
      ),
    ]);

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        fullName: user.fullName,
      },
    };
  }

  async generateTokens(user: TokenUser) {
    const tokens = await this.signTokens(user);
    const stored = await this.userService.storeRefreshToken(
      user.id,
      user.role,
      this.fingerprint(tokens.refreshToken),
    );
    if (!stored) throw new UnauthorizedException('Tài khoản không còn hợp lệ');
    return tokens;
  }

  async login(email: string, pass: string) {
    const user = await this.validateUser(email, pass);
    if (!user) {
      throw new UnauthorizedException('Email hoặc mật khẩu không chính xác');
    }
    // user.id is MongoDB ObjectId (might be _id)
    const id = user._id ? user._id.toString() : user.id;
    return this.generateTokens({
      id,
      email: user.email,
      role: user.role,
      fullName: user.fullName,
    });
  }

  async refreshTokens(refreshToken: string) {
    let claims: { sub: string; jti: string; tokenUse: string; exp: number };
    // Never use identity or touch user state before signature/expiry verification.
    try {
      claims = await this.jwtService.verifyAsync(refreshToken, {
        secret: this.refreshSecret,
        algorithms: ['HS256'],
      });
      if (
        typeof claims.sub !== 'string' ||
        !isMongoId(claims.sub) ||
        typeof claims.jti !== 'string' ||
        !claims.jti ||
        claims.tokenUse !== 'refresh' ||
        !Number.isFinite(claims.exp)
      )
        throw new Error('Invalid refresh claims');
    } catch {
      throw new ForbiddenException('Token hết hạn hoặc không hợp lệ');
    }

    const user = await this.userService.findActiveAuthUser(claims.sub);
    if (!user) throw new ForbiddenException('Truy cập bị từ chối');
    const tokens = await this.signTokens(user);
    // Signing prepares a candidate; only the atomic CAS winner can return it.
    const rotated = await this.userService.rotateRefreshToken(
      user.id,
      user.role,
      this.fingerprint(refreshToken),
      this.fingerprint(tokens.refreshToken),
    );
    if (!rotated)
      throw new ForbiddenException('Refresh token không còn hiệu lực');
    return tokens;
  }

  async logout(userId: string) {
    await this.userService.revokeRefreshToken(userId);
    return { success: true };
  }
}
