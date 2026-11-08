/**
 * Test-only fault injection. Consumes a FIFO request and exits the Bun process
 * immediately AFTER committing the SQL transaction but BEFORE SQS DeleteMessage.
 * No production worker code paths or HTTP commands are changed.
 */
import { Test } from '@nestjs/testing';
import {
  GetQueueUrlCommand, ReceiveMessageCommand, SQSClient,
} from '@aws-sdk/client-sqs';
import { AppModule } from '../../src/app.module.js';
import { WageringService } from '../../src/wagering/wagering.service.js';

if (process.env.RUN_SQS_TESTS !== '1' || !process.env.DB_NAME?.endsWith('_test')) {
  throw new Error('Crash simulator restricted to SQS tests and a disposable *_test DB');
}
process.env.SQS_WORKER_ENABLED = '0';
process.env.OUTBOX_PUBLISHER_ENABLED = '0';
process.env.REFERENCE_WORKER_ENABLED = '0';

const testing = await Test.createTestingModule({ imports: [AppModule] }).compile();
const app = testing.createNestApplication();
await app.init();
const sqs = new SQSClient({
  region: process.env.AWS_REGION ?? 'us-east-1',
  endpoint: process.env.SQS_ENDPOINT ?? 'http://127.0.0.1:4566',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
  },
});
const queue = await sqs.send(new GetQueueUrlCommand({
  QueueName: process.env.SQS_QUEUE_NAME ?? 'wager-transactions.fifo',
}));
if (!queue.QueueUrl) throw new Error('Missing FIFO queue URL');
const received = await sqs.send(new ReceiveMessageCommand({
  QueueUrl: queue.QueueUrl,
  MaxNumberOfMessages: 1,
  WaitTimeSeconds: 3,
  VisibilityTimeout: 2,
}));
const msg = received.Messages?.[0];
if (!msg) throw new Error('No message to consume in crash simulator');
const envelope = JSON.parse(msg.Body ?? '{}') as {
  messageId: string; type: string; data: Record<string, unknown> & { idempotencyKey: string };
};
if (envelope.type !== 'WagerTransactionRequested') {
  throw new Error('Unexpected crash fixture');
}
await app.get(WageringService).submit(envelope.data, envelope.data.idempotencyKey, {
  messageId: envelope.messageId,
  consumerName: 'wager-processor',
});
// Intentionally skip DeleteMessage and all graceful shutdown hooks:
// this simulates SIGKILL in the dangerous post-COMMIT/pre-ACK window.
process.stderr.write('CRASH_AFTER_FINANCIAL_COMMIT_BEFORE_SQS_ACK\n');
process.exit(17);
