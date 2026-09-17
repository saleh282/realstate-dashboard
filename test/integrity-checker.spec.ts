import { runIntegrityChecks } from '../src/migrations/integrity-checker';

function cursor(value: unknown[] = []) { return { toArray: jest.fn().mockResolvedValue(value) }; }

function cleanDb() {
  const collections = new Map<string, any>();
  const collection = (name: string) => {
    if (!collections.has(name)) collections.set(name, {
      aggregate: jest.fn().mockImplementation(() => cursor()),
      countDocuments: jest.fn().mockResolvedValue(0),
      find: jest.fn().mockReturnValue({ limit: jest.fn().mockReturnValue(cursor()) }),
    });
    return collections.get(name);
  };
  return { db: { collection } as any, collections };
}

describe('MAZAD-011 integrity checks', () => {
  it('returns a clean read-only report for a consistent snapshot', async () => {
    const { db } = cleanDb();
    await expect(runIntegrityChecks(db, new Date('2026-01-01T00:00:00Z'))).resolves.toEqual({ generatedAt: '2026-01-01T00:00:00.000Z', ok: true, errorCount: 0, warningCount: 0, findings: [] });
  });

  it('reports duplicate identifiers without leaking identifier values', async () => {
    const { db, collections } = cleanDb();
    const users = db.collection('users');
    users.aggregate.mockImplementationOnce(() => cursor([{ _id: 'secret@example.com', ids: ['u1', 'u2'], count: 2 }])).mockImplementation(() => cursor());
    const report = await runIntegrityChecks(db, new Date('2026-01-01T00:00:00Z'));
    expect(report.ok).toBe(false);
    expect(report.findings[0]).toMatchObject({ code: 'DUPLICATE_USER_EMAIL', sampleIds: ['u1', 'u2'] });
    expect(JSON.stringify(report)).not.toContain('secret@example.com');
    expect(collections.size).toBeGreaterThan(0);
  });
});
