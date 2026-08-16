import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Dish, DishSchema } from './dish.schema';
import { DishService } from './dish.service';
import { DishController } from './dish.controller';
import { CloudinaryModule } from '../cloudinary/cloudinary.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Dish.name, schema: DishSchema }]),
    CloudinaryModule,
  ],
  controllers: [DishController],
  providers: [DishService],
  exports: [MongooseModule, DishService],
})
export class DishModule {}
