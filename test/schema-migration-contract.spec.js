'use strict';
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');
const expected = require('./fixtures/mongoose-schema-contract.json');

it('preserves database collections, field casting, indexes and field constraints', () => {
  const actual = {};
  for (const file of fs
    .readdirSync(path.join(__dirname, '../src/models'))
    .filter((f) => f.endsWith('.model.js'))) {
    for (const [name, schema] of Object.entries(require('../src/models/' + file))) {
      if (!(schema instanceof mongoose.Schema)) continue;
      actual[name] = {
        collection: schema.options.collection || null,
        indexes: JSON.parse(JSON.stringify(schema.indexes())),
        paths: Object.fromEntries(
          Object.entries(schema.paths).map(([key, value]) => [
            key,
            {
              instance: value.instance,
              constraints: JSON.parse(
                JSON.stringify(
                  Object.fromEntries(
                    Object.entries(value.options).filter(
                      ([key, value]) => !['type', 'validate', 'default'].includes(key),
                    ),
                  ),
                  (key, value) =>
                    typeof value === 'function'
                      ? value.name || 'anonymous'
                      : value instanceof RegExp
                        ? value.toString()
                        : value,
                ),
              ),
            },
          ]),
        ),
      };
    }
  }
  expect(actual).toEqual(expected);
});
