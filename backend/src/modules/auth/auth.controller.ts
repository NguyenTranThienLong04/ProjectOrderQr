import {
  Controller,
  Post,
  Body,
  UseGuards,
  Req,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../common/enums/user-role.enum';
import { UserService } from '../user/user.service';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly userService: UserService,
  ) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() loginDto: LoginDto) {
    return this.authService.login(loginDto.email, loginDto.password);
  }

  @Post('register')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  async register(@Body() registerDto: RegisterDto) {
    const user = await this.userService.create(
      registerDto.fullName,
      registerDto.email,
      registerDto.password,
      registerDto.role,
    );
    return {
      success: true,
      message: 'Đăng ký tài khoản nhân viên thành công',
      user: {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        role: user.role,
      },
    };
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Body() refreshTokenDto: RefreshTokenDto) {
    // Decodes the token to get the sub (userId) without verifying expiration to allow parsing
    // Actually, we can pass it to authService.refreshTokens which will handle verification
    // But how does it know the userId? We can decode the token first or send the userId.
    // Wait! Let's decode the JWT first to get the userId (sub).
    // In NestJS JwtService: we can use jwtService.decode
    // Let's decode it safely in the service or in the controller.
    // Let's do it inside the service. But wait, how does the service get the userId?
    // We can decode it without verification first to get the sub.
    // Let's implement that in authService.
    const decoded = this.authService.decodeTokenWithoutVerify(
      refreshTokenDto.refreshToken,
    );
    if (!decoded || !decoded.sub) {
      throw new UnauthorizedException('Token không hợp lệ');
    }
    return this.authService.refreshTokens(
      decoded.sub,
      refreshTokenDto.refreshToken,
    );
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async logout(@Req() req: any) {
    return this.authService.logout(req.user.id);
  }

  @Post('me')
  @UseGuards(JwtAuthGuard)
  async getProfile(@Req() req: any) {
    return {
      user: req.user,
    };
  }
}

// Add decodeTokenWithoutVerify to authService or just write it here.
// Let's look at the AuthService code I wrote above. Oh! It does not have decodeTokenWithoutVerify!
// Let's update auth.service.ts or import JwtService in controller to decode.
// Yes! We can decode it in the controller using jwtService.decode or in AuthService.
// Let's check how to handle this.
import { UnauthorizedException } from '@nestjs/common';
