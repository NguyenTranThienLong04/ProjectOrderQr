import { Reflector } from '@nestjs/core';
import { ForbiddenException } from '@nestjs/common';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '../../common/enums/user-role.enum';
import { PromotionController } from './promotion.controller';

describe('PromotionController RBAC', () => {
  const contextFor = (role: UserRole) =>
    ({
      getHandler: () => PromotionController.prototype.update,
      getClass: () => PromotionController,
      switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
    }) as never;

  it('allows Admin and blocks non-Admin promotion updates', () => {
    const guard = new RolesGuard(new Reflector());
    expect(guard.canActivate(contextFor(UserRole.ADMIN))).toBe(true);
    expect(() => guard.canActivate(contextFor(UserRole.WAITER))).toThrow(
      ForbiddenException,
    );
  });
});
