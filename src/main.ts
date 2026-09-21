import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { configureApp, configureHttpServer } from './app.setup';
import { installProcessHandlers } from './common/process-handlers';

async function bootstrap() {
  installProcessHandlers();
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  configureApp(app);

  const port = process.env.PORT || 3000;
  await app.listen(port);
  configureHttpServer(app.getHttpServer());
  Logger.log(`Backend listening on port ${port}`, 'Bootstrap');
}
void bootstrap();
