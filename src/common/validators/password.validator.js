'use strict';

const { registerDecorator, ValidatorConstraint } = require('class-validator');
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_POLICY_MESSAGE = 'كلمة المرور يجب أن تحتوي على 8 أحرف على الأقل';
function isValidPassword(password) {
  return typeof password === 'string' && password.length >= PASSWORD_MIN_LENGTH;
}
function IsApplicationPassword(validationOptions) {
  return (object, propertyName) => {
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
function Match(property, validationOptions) {
  return (object, propertyName) => {
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
let MatchConstraint = class MatchConstraint {
  validate(value, args) {
    const [relatedPropertyName] = args.constraints;
    const relatedValue = args.object[relatedPropertyName];
    return value === relatedValue;
  }
};
ValidatorConstraint({
  name: 'Match',
})(MatchConstraint);

Object.assign(exports, {
  PASSWORD_MIN_LENGTH,
  PASSWORD_POLICY_MESSAGE,
  isValidPassword,
  IsApplicationPassword,
  Match,
});
