import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type FavoriteDocument = HydratedDocument<Favorite>;

/**
 * A user's bookmark of a property (MAZAD-022). Intentionally minimal: the
 * safe, up-to-date property data is always re-read from `properties` at list
 * time (see `PropertiesService.getPublicProjectionsByIds`) rather than
 * snapshotted here, so a favorite never goes stale or leaks fields the
 * property's current state should no longer expose.
 */
@Schema({ timestamps: true, collection: 'favorites' })
export class Favorite {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true }) userId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: 'Property', required: true, index: true }) propertyId: Types.ObjectId;
}

export const FavoriteSchema = SchemaFactory.createForClass(Favorite);
// The same user can never favorite the same property twice.
FavoriteSchema.index({ userId: 1, propertyId: 1 }, { unique: true, name: 'favorite_user_property_unique' });
// Paginated "my favorites" listing, newest first.
FavoriteSchema.index({ userId: 1, createdAt: -1 }, { name: 'favorite_user_listing' });
