/**
 * Top-level document paths an update would write, for schema hooks that must
 * reject (not silently drop, as Mongoose `immutable` does) changes to
 * engineering-owned fields. `$setOnInsert` is reported separately: it only
 * writes when the update inserts.
 */
export function updatedPaths(update: unknown): { paths: string[]; insertOnlyPaths: string[] } {
  if (!update || typeof update !== 'object') return { paths: [], insertOnlyPaths: [] };
  const stages = Array.isArray(update) ? update : [update];
  const paths = new Set<string>();
  const insertOnlyPaths = new Set<string>();
  for (const stage of stages) {
    for (const [operator, value] of Object.entries(stage as Record<string, unknown>)) {
      if (!operator.startsWith('$')) {
        paths.add(topLevel(operator));
        continue;
      }
      if (!value || typeof value !== 'object') continue;
      const target = operator === '$setOnInsert' ? insertOnlyPaths : paths;
      for (const path of Object.keys(value as Record<string, unknown>)) target.add(topLevel(path));
      if (operator === '$rename') for (const path of Object.values(value as Record<string, string>)) paths.add(topLevel(String(path)));
    }
  }
  return { paths: [...paths], insertOnlyPaths: [...insertOnlyPaths] };
}

const topLevel = (path: string) => path.split('.')[0];
