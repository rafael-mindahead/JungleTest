import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { MikroORM } from '@mikro-orm/core';
import type { PostgreSqlDriver } from '@mikro-orm/postgresql';
import ormConfig from './database/mikro-orm.config.js';
import { HealthModule } from './health/health.module.js';
import { PostgresWalletRepository } from './infrastructure/wallets/postgres-wallet.repository.js';
import { WalletsController } from './wagering/wallets.controller.js';
import { WageringController } from './wagering/wagering.controller.js';
import { WageringService } from './wagering/wagering.service.js';
import { WagerWorkers } from './wagering/wager-workers.service.js';
import { FinancialMetrics } from './observability/financial-metrics.service.js';
import { FinancialMetricsController } from './observability/financial-metrics.controller.js';
import { IdentityGuard, OidcTokenVerifier } from './security/identity.guard.js';

@Module({
  imports: [MikroOrmModule.forRoot(ormConfig), HealthModule],
  providers: [
    FinancialMetrics,
    OidcTokenVerifier,
    IdentityGuard,
    WageringService,
    WagerWorkers,
    {
      provide: PostgresWalletRepository,
      useFactory: (orm: MikroORM) => new PostgresWalletRepository(orm as unknown as MikroORM<PostgreSqlDriver>),
      inject: [MikroORM],
    },
  ],
  controllers: [WalletsController, WageringController, FinancialMetricsController],
})
export class AppModule {}
