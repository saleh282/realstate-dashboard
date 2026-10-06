'use strict';

const { Schema } = require('mongoose');

/** A listing an account marked with the heart. */
const FavouriteSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    listingId: { type: Schema.Types.ObjectId, ref: 'Listing', required: true, immutable: true },
  },
  {
    collection: 'favourites',
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
  },
);

FavouriteSchema.index({ userId: 1, listingId: 1 }, { unique: true });
FavouriteSchema.index({ userId: 1, createdAt: -1 });

module.exports = { FavouriteSchema };
