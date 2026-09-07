import {
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
} from 'class-validator';

export const STRONG_PASSWORD_REGEX =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@#$!%*?&])[A-Za-z\d@#$!%*?&]{8,}$/;

export const STRONG_PASSWORD_MESSAGE =
  'كلمة المرور يجب أن تحتوي على 8 أحرف على الأقل، وتشمل حرف كبير وحرف صغير ورقم ورمز خاص (@#$!%*?&)';

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

export function NotSameAsIdentifier(
  identifierProperty: string,
  validationOptions?: ValidationOptions,
) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      name: 'NotSameAsIdentifier',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [identifierProperty],
      validator: NotSameAsIdentifierConstraint,
    });
  };
}

@ValidatorConstraint({ name: 'NotSameAsIdentifier' })
class NotSameAsIdentifierConstraint implements ValidatorConstraintInterface {
  validate(value: any, args: ValidationArguments) {
    const [identifierProperty] = args.constraints;
    const identifierValue = (args.object as any)[identifierProperty];
    if (typeof value !== 'string' || typeof identifierValue !== 'string') return true;
    return value.toLowerCase() !== identifierValue.toLowerCase();
  }
}
