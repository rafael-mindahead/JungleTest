
import 'dotenv/config';

import { defineConfig } from '@mikro-orm/postgresql';
import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import { Migrator } from '@mikro-orm/migrations';

import { WalletRecord } from './entities/wallet-record.entity.js';
import { WalletLedgerRecord } from './entities/wallet-ledger-record.entity.js';

export default defineConfig({
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT ?? 5434),
  dbName: process.env.DB_NAME ?? 'jungle_wagering',
  user: process.env.DB_USER ?? 'jungle',
  password: process.env.DB_PASSWORD ?? 'jungle_dev',

  entities: [WalletRecord, WalletLedgerRecord],

  metadataProvider: ReflectMetadataProvider,

  extensions: [Migrator],

  migrations: {
    path: './dist/src/database/migrations',
    pathTs: './src/database/migrations',
    emit: 'ts',
    transactional: true,
    allOrNothing: true,
    dropTables: false,
  },

  pool: {
    min: 1,
    max: 10,
  },
});
