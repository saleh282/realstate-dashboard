import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User, UserDocument } from './schemas/user.schema';

@Injectable()
export class UsersService {
  constructor(@InjectModel(User.name) private userModel: Model<UserDocument>) {}

  
  static isEmail(identifier: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier);
  }

  async findByIdentifier(identifier: string, withSecrets = false) {
    const query = UsersService.isEmail(identifier)
      ? { email: identifier.toLowerCase() }
      : { phone: identifier };

    const q = this.userModel.findOne(query);
    if (withSecrets) {
      q.select('+password +failedLoginAttempts +accountLockedUntil');
    }
    return q.exec();
  }

  async findById(id: string, withSecrets = false) {
    const q = this.userModel.findById(id);
    if (withSecrets) {
      q.select('+password +failedLoginAttempts +accountLockedUntil');
    }
    return q.exec();
  }

  async create(data: Partial<User>) {
    return this.userModel.create(data);
  }

  async save(user: UserDocument) {
    return user.save();
  }
}
