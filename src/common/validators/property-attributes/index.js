'use strict';

/** Dynamic Property Form V1 validation engine (DPF-011). Pure: no database, no HTTP. */
Object.assign(exports, require('./cross-field-rules'));
Object.assign(exports, require('./normalize-text'));
Object.assign(exports, require('./parse-attributes'));
Object.assign(exports, require('./property-attribute-errors'));
Object.assign(exports, require('./validate-attributes'));
