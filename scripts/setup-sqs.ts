
import 'dotenv/config';

import {
  SQSClient,
  CreateQueueCommand,
  GetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';

const client = new SQSClient({
  region: process.env.AWS_REGION ?? 'us-east-1',
  endpoint:
    process.env.SQS_ENDPOINT ?? 'http://127.0.0.1:4566',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
    secretAccessKey:
      process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
  },
});

const queueName =
  process.env.SQS_QUEUE_NAME ?? 'wager-transactions.fifo';

const dlqName =
  process.env.SQS_DLQ_NAME ?? 'wager-transactions-dlq.fifo';

async function main(): Promise<void> {
  try {
    const dlq = await client.send(
      new CreateQueueCommand({
        QueueName: dlqName,
        Attributes: {
          FifoQueue: 'true',
        },
      }),
    );

    if (!dlq.QueueUrl) {
      throw new Error('DLQ URL not returned');
    }

    const attributes = await client.send(
      new GetQueueAttributesCommand({
        QueueUrl: dlq.QueueUrl,
        AttributeNames: ['QueueArn'],
      }),
    );

    const dlqArn = attributes.Attributes?.QueueArn;

    if (!dlqArn) {
      throw new Error('DLQ ARN not returned');
    }

    const queue = await client.send(
      new CreateQueueCommand({
        QueueName: queueName,
        Attributes: {
          FifoQueue: 'true',
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: dlqArn,
            maxReceiveCount: '5',
          }),
        },
      }),
    );

    const eventsQueue = await client.send(new CreateQueueCommand({
      QueueName: process.env.SQS_EVENTS_QUEUE_NAME ?? 'wager-events.fifo',
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
    }));
    console.log('Events queue:', eventsQueue.QueueUrl);
    console.log('DLQ:', dlq.QueueUrl);
    console.log('Main queue:', queue.QueueUrl);
    console.log('SQS setup completed');
  } finally {
    client.destroy();
  }
}

await main();
