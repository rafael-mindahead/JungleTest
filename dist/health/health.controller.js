var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
import { Controller, Get, Inject, ServiceUnavailableException, } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/core';
import { SQSClient, GetQueueUrlCommand, } from '@aws-sdk/client-sqs';
let HealthController = class HealthController {
    orm;
    sqs;
    constructor(orm) {
        this.orm = orm;
        this.sqs = new SQSClient({
            region: process.env.AWS_REGION ?? 'us-east-1',
            endpoint: process.env.SQS_ENDPOINT ?? 'http://127.0.0.1:4566',
            credentials: {
                accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
                secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
            },
        });
    }
    live() {
        return {
            status: 'ok',
            service: 'jungle-wagering-processor',
        };
    }
    async ready() {
        try {
            await this.orm.em.getConnection().execute('SELECT 1');
            await this.sqs.send(new GetQueueUrlCommand({
                QueueName: process.env.SQS_QUEUE_NAME ??
                    'wager-transactions.fifo',
            }));
            return {
                status: 'ready',
                checks: {
                    postgres: 'up',
                    sqs: 'up',
                },
            };
        }
        catch {
            throw new ServiceUnavailableException({
                status: 'not_ready',
                message: 'Required infrastructure is unavailable',
            });
        }
    }
    onModuleDestroy() {
        this.sqs.destroy();
    }
};
__decorate([
    Get('live'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], HealthController.prototype, "live", null);
__decorate([
    Get('ready'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], HealthController.prototype, "ready", null);
HealthController = __decorate([
    Controller('health'),
    __param(0, Inject(MikroORM)),
    __metadata("design:paramtypes", [MikroORM])
], HealthController);
export { HealthController };
//# sourceMappingURL=health.controller.js.map