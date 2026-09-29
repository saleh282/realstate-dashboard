import { assertDisposableTarget } from '../src/scripts/disposable-target';

describe('Phase 13 disposable-target guard (scale harness, rehearsal, restore drill)', () => {
  it('accepts localhost databases with the mazad_phase13_ prefix only', () => {
    expect(assertDisposableTarget('mongodb://127.0.0.1:57077/mazad_phase13_scale?replicaSet=r').database).toBe('mazad_phase13_scale');
    expect(assertDisposableTarget('mongodb://localhost/mazad_phase13_drill').database).toBe('mazad_phase13_drill');
  });

  it.each([
    ['a remote host', 'mongodb+srv://u:p@cluster0.example.mongodb.net/mazad_phase13_scale'],
    ['a remote host among local ones', 'mongodb://127.0.0.1,db.example.com/mazad_phase13_scale'],
    ['a production-looking database on localhost', 'mongodb://127.0.0.1:27017/real-estate-auction'],
    ['the Phase 12 disposable database', 'mongodb://127.0.0.1:57077/mazad_phase12_disposable'],
    ['no database name', 'mongodb://127.0.0.1:27017'],
    ['a look-alike prefix', 'mongodb://127.0.0.1/xmazad_phase13_scale'],
  ])('refuses %s', (_name, uri) => expect(() => assertDisposableTarget(uri)).toThrow('Refused'));

  it('requires a connection string', () => expect(() => assertDisposableTarget(undefined)).toThrow('MONGO_URI is required'));
});
