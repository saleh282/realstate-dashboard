'use strict';

/**
 * Frozen §D #1-2 / §H6-H7. A client that renders FormDefinitions
 * (`formSchema=1`) gets every listed type and decides availability from the
 * pointers. An old client only gets types it can still create with the fixed
 * legacy form: an active definition whose current published version is
 * `legacyWritable`. Types that need the new renderer are never exposed to it.
 */
function creatableTypesForClient(types, pointers, formSchema) {
  if (formSchema) return types;
  return types.filter((type) => pointers.get(type.id)?.legacyWritable === true);
}

Object.assign(exports, { creatableTypesForClient });
