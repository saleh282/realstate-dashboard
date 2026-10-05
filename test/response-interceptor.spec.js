'use strict';
const express = require('express');
const request = require('supertest');
const { sendResponse, responseBody } = require('../src/views/response');
const { StreamableFile } = require('../src/common/http/binary-response');
it('sends private binary data intact outside the JSON envelope', async () => {
  const app = express();
  app.get('/file', (req, res) =>
    sendResponse(res, new StreamableFile(Buffer.from('%PDF-1.7\n%%EOF'))),
  );
  const result = await request(app).get('/file').expect(200);
  expect(result.body).toEqual(Buffer.from('%PDF-1.7\n%%EOF'));
  expect(result.headers['content-type']).toContain('application/octet-stream');
});
it('preserves the API response envelope', () => {
  expect(responseBody({ message: 'ok', item: 1 })).toEqual({
    success: true,
    message: 'ok',
    data: { item: 1 },
  });
  expect(responseBody(null)).toEqual({ success: true, message: 'تمت العملية بنجاح', data: null });
});
