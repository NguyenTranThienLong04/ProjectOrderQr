import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { UserService } from './modules/user/user.service';
import { UserRole } from './common/enums/user-role.enum';

@Injectable()
export class AppService implements OnApplicationBootstrap {
  constructor(private readonly userService: UserService) {}

  getHello(): string {
    return 'Hello World!';
  }

  async onApplicationBootstrap() {
    try {
      const count = await this.userService.countUsers();
      if (count === 0) {
        await this.userService.create(
          'Restaurant Admin',
          'admin@restaurant.com',
          'Admin@123',
          UserRole.ADMIN,
        );
        console.log(
          '[Seeding] Đã khởi tạo thành công tài khoản Admin mặc định: admin@restaurant.com / Admin@123',
        );
      }
    } catch (error) {
      console.error('[Seeding] Có lỗi xảy ra khi seed dữ liệu admin:', error);
    }
  }
}
