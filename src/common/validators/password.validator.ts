import {
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
} from 'class-validator';

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_POLICY_MESSAGE = 'كلمة المرور يجب أن تحتوي على 8 أحرف على الأقل';

export function isValidPassword(password: unknown): password is string {
  return typeof password === 'string' && password.length >= PASSWORD_MIN_LENGTH;
}

export function IsApplicationPassword(validationOptions?: ValidationOptions) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      name: 'IsApplicationPassword',
      target: object.constructor,
      propertyName,
      options: {
        message: PASSWORD_POLICY_MESSAGE,
        ...validationOptions,
      },
      validator: { validate: isValidPassword },
    });
  };
}

export function Match(property: string, validationOptions?: ValidationOptions) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      name: 'Match',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [property],
      validator: MatchConstraint,
    });
  };
}

@ValidatorConstraint({ name: 'Match' })
class MatchConstraint implements ValidatorConstraintInterface {
  validate(value: any, args: ValidationArguments) {
    const [relatedPropertyName] = args.constraints;
    const relatedValue = (args.object as any)[relatedPropertyName];
    return value === relatedValue;
  }
}

