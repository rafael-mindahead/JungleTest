
import {
  Controller,
  Get,
  Inject,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';

import { MikroORM } from '@mikro-orm/core';

import {
  SQSClient,
  GetQueueUrlCommand,
} from '@aws-sdk/client-sqs';

@Controller('health')
export class HealthController implements OnModuleDestroy {
  private readonly sqs: SQSClient;

  constructor(
    @Inject(MikroORM)
    private readonly orm: MikroORM,
  ) {
    this.sqs = new SQSClient({
      region: process.env.AWS_REGION ?? 'us-east-1',
      endpoint:
        process.env.SQS_ENDPOINT ?? 'http://127.0.0.1:4566',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
        secretAccessKey:
          process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
      },
    });
  }

  @Get('live')
  live() {
    return {
      status: 'ok',
      service: 'jungle-wagering-processor',
    };
  }

  @Get('ready')
  async ready() {
    try {
      await this.orm.em.getConnection().execute('SELECT 1');

      await this.sqs.send(
        new GetQueueUrlCommand({
          QueueName:
            process.env.SQS_QUEUE_NAME ??
            'wager-transactions.fifo',
        }),
      );

      return {
        status: 'ready',
        checks: {
          postgres: 'up',
          sqs: 'up',
        },
      };
    } catch {
      throw new ServiceUnavailableException({
        status: 'not_ready',
        message: 'Required infrastructure is unavailable',
      });
    }
  }

  onModuleDestroy(): void {
    this.sqs.destroy();
  }
}
