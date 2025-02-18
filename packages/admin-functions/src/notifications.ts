import { GoogleChatWebhook } from 'google-chat-webhook';
import winston from 'winston';
import { backOff } from 'exponential-backoff';

export interface Notifier {
  sendMessage(message: string): Promise<void>;
}

export class GoogleChatNotifier extends GoogleChatWebhook implements Notifier {
  public async sendMessage(message: string) {
    winston.debug('Sending message to Google Chat', { message });

    await backOff(
      () => {
        return this.sendText(message);
      },
      {
        jitter: 'full',
        maxDelay: 10000,
      },
    );
  }
}

export class NopNotifier implements Notifier {
  public async sendMessage() {}
}
