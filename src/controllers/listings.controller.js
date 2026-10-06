'use strict';

/** Thin HTTP adapter over the listings service: it only picks the inputs out of the request. */
class ListingsController {
  constructor(listings) {
    this.listings = listings;
  }
  create(req) {
    return this.listings.create(req.user.userId, req.body);
  }
  update(req) {
    return this.listings.update(req.user.userId, req.params.id, req.body);
  }
  submit(req) {
    return this.listings.submit(req.user.userId, req.params.id);
  }
  close(req) {
    return this.listings.close(req.user.userId, req.params.id);
  }
  reopen(req) {
    return this.listings.reopen(req.user.userId, req.params.id);
  }
  remove(req) {
    return this.listings.remove(req.user.userId, req.params.id);
  }
  mine(req) {
    return this.listings.mine(req.user.userId, req.query);
  }
  mineOne(req) {
    return this.listings.mineOne(req.user.userId, req.params.id);
  }
  putShot(req) {
    return this.listings.putShot(req.user.userId, req.params.id, req.params.shot, req.file);
  }
  addPhoto(req) {
    return this.listings.addPhoto(req.user.userId, req.params.id, req.file);
  }
  removePhoto(req) {
    return this.listings.removePhoto(req.user.userId, req.params.id, req.params.photoId);
  }
  orderPhotos(req) {
    return this.listings.orderPhotos(req.user.userId, req.params.id, req.body?.photoIds);
  }
  putVideo(req) {
    return this.listings.putVideo(req.user.userId, req.params.id, req.file);
  }
  removeVideo(req) {
    return this.listings.removeVideo(req.user.userId, req.params.id);
  }
  search(req) {
    return this.listings.search(req.query);
  }
  map(req) {
    return this.listings.map(req.query);
  }
  publicOne(req) {
    return this.listings.publicOne(req.params.id);
  }
  reviewQueue(req) {
    return this.listings.reviewQueue(req.query);
  }
  reviewOne(req) {
    return this.listings.reviewOne(req.params.id);
  }
  approve(req) {
    return this.listings.approve({ userId: req.user.userId, ip: req.ip }, req.params.id);
  }
  unpublish(req) {
    return this.listings.unpublish(
      { userId: req.user.userId, ip: req.ip },
      req.params.id,
      req.body?.reason,
    );
  }
  reject(req) {
    return this.listings.reject(
      { userId: req.user.userId, ip: req.ip },
      req.params.id,
      req.body?.reason,
    );
  }
}

module.exports = { ListingsController };
