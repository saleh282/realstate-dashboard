'use strict';

const { v2: cloudinary } = require('cloudinary');
const { ConfigService } = require('./config');
const CLOUDINARY = 'CLOUDINARY';
const CloudinaryProvider = {
  provide: CLOUDINARY,
  inject: [ConfigService],
  useFactory: (config) => {
    cloudinary.config({
      cloud_name: config.get('CLOUDINARY_CLOUD_NAME'),
      api_key: config.get('CLOUDINARY_API_KEY'),
      api_secret: config.get('CLOUDINARY_API_SECRET'),
    });
    return cloudinary;
  },
};

Object.assign(exports, { CLOUDINARY, CloudinaryProvider });
