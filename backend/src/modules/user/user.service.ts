import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { User, UserDocument } from './user.schema';
import { UserRole } from '../../common/enums/user-role.enum';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

export interface UserResponse {
  id: string;
  fullName: string;
  email: string;
  role: UserRole;
  isActive: boolean;
}

@Injectable()
export class UserService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
  ) {}

  async create(
    fullName: string,
    email: string,
    passwordPlain: string,
    role: UserRole,
  ): Promise<UserDocument> {
    const existing = await this.userModel.findOne({
      email: email.toLowerCase(),
    });
    if (existing) {
      throw new ConflictException('Email đã tồn tại trong hệ thống');
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(passwordPlain, salt);

    const newUser = new this.userModel({
      fullName,
      email: email.toLowerCase(),
      passwordHash,
      role,
      isActive: true,
    });

    return newUser.save();
  }

  async findByEmail(email: string): Promise<UserDocument | null> {
    return this.userModel.findOne({ email: email.toLowerCase() });
  }

  async findByEmailWithPassword(email: string): Promise<UserDocument | null> {
    return this.userModel
      .findOne({ email: email.toLowerCase() })
      .select('+passwordHash +role +fullName');
  }

  async findById(id: string): Promise<UserDocument | null> {
    return this.userModel.findById(id);
  }

  async findByIdWithRefreshToken(id: string): Promise<UserDocument | null> {
    return this.userModel.findById(id).select('+refreshTokenHash');
  }

  async updateRefreshToken(
    userId: string,
    refreshToken: string | null,
  ): Promise<void> {
    if (refreshToken === null) {
      await this.userModel.findByIdAndUpdate(userId, {
        refreshTokenHash: null,
      });
      return;
    }
    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash(refreshToken, salt);
    await this.userModel.findByIdAndUpdate(userId, { refreshTokenHash: hash });
  }

  async countUsers(): Promise<number> {
    return this.userModel.countDocuments();
  }

  async createManagedUser(createUserDto: CreateUserDto): Promise<UserResponse> {
    const user = await this.create(
      createUserDto.fullName,
      createUserDto.email,
      createUserDto.password,
      createUserDto.role,
    );
    if (createUserDto.isActive !== undefined) {
      user.isActive = createUserDto.isActive;
      await user.save();
    }
    return this.toResponse(user);
  }

  async findAll(): Promise<UserResponse[]> {
    const users = await this.userModel.find().sort({ createdAt: -1 }).exec();
    return users.map((user) => this.toResponse(user));
  }

  async findOneForManagement(id: string): Promise<UserResponse> {
    return this.toResponse(await this.getExistingUser(id));
  }

  async updateManagedUser(
    id: string,
    updateUserDto: UpdateUserDto,
  ): Promise<UserResponse> {
    const user = await this.getExistingUser(id);

    if (
      updateUserDto.email &&
      updateUserDto.email.toLowerCase() !== user.email
    ) {
      const existing = await this.userModel.findOne({
        email: updateUserDto.email.toLowerCase(),
      });
      if (existing && existing.id !== id) {
        throw new ConflictException('Email đã tồn tại trong hệ thống');
      }
      user.email = updateUserDto.email.toLowerCase();
    }

    if (updateUserDto.fullName !== undefined)
      user.fullName = updateUserDto.fullName;
    if (updateUserDto.role !== undefined) user.role = updateUserDto.role;
    if (updateUserDto.isActive !== undefined)
      user.isActive = updateUserDto.isActive;
    if (updateUserDto.password) {
      const salt = await bcrypt.genSalt(10);
      user.passwordHash = await bcrypt.hash(updateUserDto.password, salt);
    }

    await user.save();
    return this.toResponse(user);
  }

  async removeManagedUser(id: string): Promise<void> {
    const user = await this.getExistingUser(id);
    await user.deleteOne();
  }

  private async getExistingUser(id: string): Promise<UserDocument> {
    if (!isValidObjectId(id)) {
      throw new NotFoundException(`Không tìm thấy người dùng với ID ${id}`);
    }
    const user = await this.userModel.findById(id).exec();
    if (!user) {
      throw new NotFoundException(`Không tìm thấy người dùng với ID ${id}`);
    }
    return user;
  }

  private toResponse(user: UserDocument): UserResponse {
    return {
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      role: user.role,
      isActive: user.isActive,
    };
  }
}
