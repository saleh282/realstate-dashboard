'use strict';

var SystemRole;
(function (SystemRole) {
  SystemRole['USER'] = 'USER';
  SystemRole['ADMIN'] = 'ADMIN';
  SystemRole['SUPER_ADMIN'] = 'SUPER_ADMIN';
})(SystemRole || (SystemRole = {}));
/** @deprecated Use SystemRole. Kept during the MAZAD-007 compatibility window. */

Object.assign(exports, { SystemRole, UserRole: SystemRole });
