import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { isMongoId } from 'class-validator';
import { UserService } from '../user/user.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly configService: ConfigService,
    private readonly userService: UserService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      algorithms: ['HS256'],
      secretOrKey:
        configService.get<string>('JWT_ACCESS_SECRET') ||
        'default_access_secret_1234567890',
    });
  }

  async validate(payload: {
    sub: string;
    email: string;
    role: string;
    fullName: string;
  }) {
    if (
      typeof payload.sub !== 'string' ||
      !isMongoId(payload.sub) ||
      typeof payload.email !== 'string' ||
      typeof payload.role !== 'string'
    ) {
      throw new UnauthorizedException('Token không hợp lệ');
    }
    const user = await this.userService.findActiveAuthUser(payload.sub);
    if (!user) throw new UnauthorizedException('Tài khoản không còn hoạt động');
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      fullName: user.fullName,
    };
  }
}
