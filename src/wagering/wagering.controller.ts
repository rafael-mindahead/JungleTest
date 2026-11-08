import {
  Body, Controller, Get, Headers, HttpCode, HttpStatus, NotFoundException,
  Param, Post, Res, UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { WageringService } from './wagering.service.js';
import { Access, IdentityGuard } from '../security/identity.guard.js';

@Controller()
@UseGuards(IdentityGuard)
export class WageringController {
  constructor(private readonly wagers: WageringService) {}

  @Post('wagering/transactions')
  @Access('provider')
  @HttpCode(HttpStatus.OK)
  async submit(@Body() body: unknown, @Headers('idempotency-key') key: string,
               @Res({ passthrough: true }) res: Response) {
    const result = await this.wagers.submit(body, key);
    res.status(result.status === 'PENDING_REFERENCE' ? HttpStatus.ACCEPTED :
      result.status === 'REJECTED' ? HttpStatus.UNPROCESSABLE_ENTITY : HttpStatus.OK);
    return result;
  }

  @Get('wagering/transactions/:transactionId')
  @Access('admin')
  async byId(@Param('transactionId') id: string) {
    const result = await this.wagers.getById(id);
    if (!result) throw new NotFoundException('Transaction not found');
    return result;
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  @Access('admin-or-provider')
  async byProvider(@Param('providerId') providerId: string,
                   @Param('externalTransactionId') externalTransactionId: string) {
    const result = await this.wagers.getByExternal(providerId, externalTransactionId);
    if (!result) throw new NotFoundException('Transaction not found');
    return result;
  }
}
