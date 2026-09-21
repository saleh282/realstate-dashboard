import * as fs from 'fs';
import * as path from 'path';

const root = path.join(__dirname, '..');
const readJson = (file: string) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const installed = (name: string): string => readJson(`node_modules/${name}/package.json`).version;

function atLeast(version: string, minimum: string): boolean {
  const a = version.split('.').map(Number);
  const b = minimum.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) > (b[index] ?? 0);
  }
  return true;
}

// Minimum patched versions for the advisories that npm audit reported against
// the versions @nestjs/platform-express, express and @nestjs/config pin.
const PATCHED: Record<string, string> = {
  multer: '2.3.0',
  'body-parser': '1.20.6',
  qs: '6.16.0',
  lodash: '4.18.0',
  'file-type': '21.3.2',
};

describe('patched transitive dependencies', () => {
  it.each(Object.entries(PATCHED))('%s resolves to a patched release', (name, minimum) => {
    expect(atLeast(installed(name), minimum)).toBe(true);
  });

  it('keeps the package.json overrides that force those releases', () => {
    const { overrides } = readJson('package.json');
    for (const name of Object.keys(PATCHED)) expect(overrides).toHaveProperty(name);
  });

  it('locks every override to the same release in the lockfile', () => {
    const lock = readJson('package-lock.json');
    for (const name of Object.keys(PATCHED)) {
      const versions = Object.entries(lock.packages as Record<string, { version?: string }>)
        .filter(([key]) => key === `node_modules/${name}` || key.endsWith(`/node_modules/${name}`))
        .map(([, value]) => value.version as string);
      expect(versions.length).toBeGreaterThan(0);
      for (const version of versions) expect(atLeast(version, PATCHED[name])).toBe(true);
    }
  });
});
