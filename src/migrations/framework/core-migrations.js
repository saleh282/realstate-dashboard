'use strict';

const { legalDocumentsMigration } = require('../039-legal-documents');

/** Every migration the CLI runs, in order. */
const CORE_MIGRATIONS = [legalDocumentsMigration];
function validateMigrationRegistry(migrations = CORE_MIGRATIONS) {
  const ids = new Set();
  for (const migration of migrations) {
    if (!/^\d{3}-[a-z0-9-]+$/.test(migration.id))
      throw new Error(`Invalid versioned migration id: ${migration.id}`);
    if (!Number.isSafeInteger(migration.version) || migration.version < 1)
      throw new Error(`Invalid migration version for ${migration.id}`);
    if (ids.has(migration.id)) throw new Error(`Duplicate migration id: ${migration.id}`);
    ids.add(migration.id);
    for (const dependency of migration.dependencies ?? []) {
      if (dependency === migration.id)
        throw new Error(`Migration ${migration.id} cannot depend on itself`);
    }
  }
}

Object.assign(exports, { legalDocumentsMigration, CORE_MIGRATIONS, validateMigrationRegistry });
