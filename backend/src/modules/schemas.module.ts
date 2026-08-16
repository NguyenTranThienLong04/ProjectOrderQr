import { Module } from '@nestjs/common';
import { CategoryModule } from './category/category.module';
import { DishModule } from './dish/dish.module';
import { OrderModule } from './order/order.module';
import { SessionModule } from './session/session.module';
import { TableModule } from './table/table.module';
import { UserModule } from './user/user.module';

@Module({
  imports: [
    UserModule,
    TableModule,
    CategoryModule,
    DishModule,
    SessionModule,
    OrderModule,
  ],
  exports: [
    UserModule,
    TableModule,
    CategoryModule,
    DishModule,
    SessionModule,
    OrderModule,
  ],
})
export class SchemasModule {}
