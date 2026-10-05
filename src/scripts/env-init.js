'use strict';

/**
 * Writes the one-time environment identity marker into the target database.
 *   DEPLOYMENT_ENV=staging MONGO_URI=... npm run env:init -- --confirm=<host>/<database>
 * The confirmation must equal the target parsed from MONGO_URI, so the operator
 * has to name the exact database being labelled. An existing marker is never
 * overwritten with a different environment.
 */
require('dotenv/config');
const { MongoClient } = require('mongodb');
const {
  ENVIRONMENT_MARKER_COLLECTION,
  ENVIRONMENT_MARKER_ID,
  EnvironmentSafetyError,
  guardAction,
  isTargetAllowed,
  parseMongoTarget,
  readEnvironmentMarker,
} = require('../config/deployment-environment');
async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new EnvironmentSafetyError('MONGO_URI is required');
  const target = parseMongoTarget(uri);
  const expected = `${target.hosts[0]}/${target.database}`;
  const confirm = process.argv
    .find((arg) => arg.startsWith('--confirm='))
    ?.slice('--confirm='.length);
  if (!confirm || !isTargetAllowed(target, [confirm]) || target.hosts.length !== 1) {
    throw new EnvironmentSafetyError(
      `Refused: pass --confirm=${expected} to label exactly this database`,
    );
  }
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  try {
    await client.connect();
    const db = client.db();
    const deployment = await guardAction('env:init', process.env);
    const existing = await readEnvironmentMarker(db);
    if (existing) {
      if (existing.env !== deployment)
        throw new EnvironmentSafetyError(`Refused: database is already marked "${existing.env}"`);
      console.log(JSON.stringify({ status: 'unchanged', env: existing.env }));
      return;
    }
    await db
      .collection(ENVIRONMENT_MARKER_COLLECTION)
      .insertOne({ _id: ENVIRONMENT_MARKER_ID, env: deployment, createdAt: new Date() });
    console.log(JSON.stringify({ status: 'created', env: deployment, target: expected }));
  } finally {
    await client.close();
  }
}
void main().catch((error) => {
  console.error(
    error instanceof Error
      ? error.message.replace(/mongodb(?:\+srv)?:\/\/[^\s]+/gi, '[REDACTED_URI]')
      : 'env:init failed',
  );
  process.exitCode = 1;
});
