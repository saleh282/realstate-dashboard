import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { MailService } from '../auth/mail.service';

async function sendTestEmail(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule);
  try {
    const config = app.get(ConfigService);
    const recipient = config.get<string>('TEST_EMAIL_TO')?.trim();
    if (!recipient) throw new Error('TEST_EMAIL_TO is required');
    await app.get(MailService).sendTestEmail(recipient);
    Logger.log('SMTP test completed', 'MailTest');
  } finally {
    await app.close();
  }
}

void sendTestEmail().catch((error: Error) => {
  Logger.error(error.message, undefined, 'MailTest');
  process.exitCode = 1;
});
