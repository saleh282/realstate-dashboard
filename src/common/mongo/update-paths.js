'use strict';

/**
 * Top-level document paths an update would write, for schema hooks that must
 * reject (not silently drop, as Mongoose `immutable` does) changes to
 * engineering-owned fields. `$setOnInsert` is reported separately: it only
 * writes when the update inserts.
 */
function updatedPaths(update) {
  if (!update || typeof update !== 'object') return { paths: [], insertOnlyPaths: [] };
  const stages = Array.isArray(update) ? update : [update];
  const paths = new Set();
  const insertOnlyPaths = new Set();
  for (const stage of stages) {
    for (const [operator, value] of Object.entries(stage)) {
      if (!operator.startsWith('$')) {
        paths.add(topLevel(operator));
        continue;
      }
      if (!value || typeof value !== 'object') continue;
      const target = operator === '$setOnInsert' ? insertOnlyPaths : paths;
      for (const path of Object.keys(value)) target.add(topLevel(path));
      if (operator === '$rename')
        for (const path of Object.values(value)) paths.add(topLevel(String(path)));
    }
  }
  return { paths: [...paths], insertOnlyPaths: [...insertOnlyPaths] };
}
const topLevel = (path) => path.split('.')[0];

Object.assign(exports, { updatedPaths });
