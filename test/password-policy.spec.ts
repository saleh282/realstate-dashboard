import { validate } from 'class-validator';
import { RegisterDto } from '../src/auth/dto/register.dto';
import { ResetPasswordDto } from '../src/auth/dto/password-reset.dto';
import {
  PASSWORD_MIN_LENGTH,
  isValidPassword,
} from '../src/common/validators/password.validator';

const validPasswords = [
  '12345678',
  'abcdefgh',
  'password',
  'ABCDEFGH',
  'abc12345',
];

describe('shared application password policy', () => {
  it.each(validPasswords)('accepts %s', (password) => {
    expect(isValidPassword(password)).toBe(true);
  });

  it('rejects a seven-character password', () => {
    expect(isValidPassword('1234567')).toBe(false);
    expect(PASSWORD_MIN_LENGTH).toBe(8);
  });

  it.each(validPasswords)('is applied by registration for %s', async (password) => {
    const dto = Object.assign(new RegisterDto(), {
      fullName: 'Test User',
      identifier: 'user@example.com',
      phone: '+201012345678',
      password,
      confirmPassword: password,
    });

    const errors = await validate(dto);
    expect(errors.find((error) => error.property === 'password')).toBeUndefined();
  });

  it.each(validPasswords)('is applied by password reset for %s', async (password) => {
    const dto = Object.assign(new ResetPasswordDto(), {
      resetToken: 'test-reset-token',
      newPassword: password,
      confirmPassword: password,
    });

    const errors = await validate(dto);
    expect(errors.find((error) => error.property === 'newPassword')).toBeUndefined();
  });

  it('rejects seven characters in registration and reset DTOs', async () => {
    const registration = Object.assign(new RegisterDto(), {
      fullName: 'Test User',
      identifier: 'user@example.com',
      password: '1234567',
      phone: '+201012345678',
      confirmPassword: '1234567',
    });
    const reset = Object.assign(new ResetPasswordDto(), {
      resetToken: 'test-reset-token',
      newPassword: '1234567',
      confirmPassword: '1234567',
    });

    const registrationErrors = await validate(registration);
    const resetErrors = await validate(reset);
    expect(registrationErrors.some((error) => error.property === 'password')).toBe(true);
    expect(resetErrors.some((error) => error.property === 'newPassword')).toBe(true);
  });
});
