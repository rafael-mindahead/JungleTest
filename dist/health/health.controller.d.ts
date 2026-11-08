import { OnModuleDestroy } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/core';
export declare class HealthController implements OnModuleDestroy {
    private readonly orm;
    private readonly sqs;
    constructor(orm: MikroORM);
    live(): {
        status: string;
        service: string;
    };
    ready(): Promise<{
        status: string;
        checks: {
            postgres: string;
            sqs: string;
        };
    }>;
    onModuleDestroy(): void;
}
