import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
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
import { FinancialHttpErrorFilter, correlationMiddleware } from './observability/http-observability.js';

@Module({
  imports: [MikroOrmModule.forRoot(ormConfig), HealthModule],
  providers: [
    FinancialMetrics,
    { provide: APP_FILTER, useClass: FinancialHttpErrorFilter },
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
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Express 5 named catch-all, matches health and protected endpoints.
    consumer.apply(correlationMiddleware).forRoutes({ path: '{*splat}', method: RequestMethod.ALL });
  }
}
