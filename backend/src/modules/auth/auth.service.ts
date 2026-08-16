import {
  Injectable,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UserService } from '../user/user.service';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { UserRole } from '../../common/enums/user-role.enum';

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

  async generateTokens(user: {
    id: string;
    email: string;
    role: string;
    fullName: string;
  }) {
    const payload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      fullName: user.fullName,
    };

    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(payload, {
        secret: this.accessSecret,
        expiresIn: '15m',
      }),
      this.jwtService.signAsync(payload, {
        secret: this.refreshSecret,
        expiresIn: '7d',
      }),
    ]);

    // Save refresh token hash in DB
    await this.userService.updateRefreshToken(user.id, refreshToken);

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

  decodeTokenWithoutVerify(token: string): any {
    return this.jwtService.decode(token);
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

  async refreshTokens(userId: string, refreshToken: string) {
    const user = await this.userService.findByIdWithRefreshToken(userId);
    if (!user || !user.refreshTokenHash || !user.isActive) {
      throw new ForbiddenException(
        'Truy cập bị từ chối hoặc Token không hợp lệ',
      );
    }

    // Verify token
    try {
      await this.jwtService.verifyAsync(refreshToken, {
        secret: this.refreshSecret,
      });
    } catch {
      // Clear refresh token if verification fails
      await this.userService.updateRefreshToken(userId, null);
      throw new ForbiddenException('Token hết hạn hoặc không hợp lệ');
    }

    const isMatch = await bcrypt.compare(refreshToken, user.refreshTokenHash);
    if (!isMatch) {
      throw new ForbiddenException('Truy cập bị từ chối');
    }

    return this.generateTokens({
      id: user.id,
      email: user.email,
      role: user.role,
      fullName: user.fullName,
    });
  }

  async logout(userId: string) {
    await this.userService.updateRefreshToken(userId, null);
    return { success: true };
  }
}
