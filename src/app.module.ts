
import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';

import ormConfig from './database/mikro-orm.config.js';
import { HealthModule } from './health/health.module.js';

@Module({
  imports: [
    MikroOrmModule.forRoot(ormConfig),
    HealthModule,
  ],
})
export class AppModule {}
