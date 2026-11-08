import { randomUUID } from 'node:crypto';
import {
  BadRequestException, Body, ConflictException, Controller, Get, Inject,
  NotFoundException, Param, Post, Query,
} from '@nestjs/common';
import { MikroORM } from '@mikro-orm/core';
import type { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { Money } from '../domain/shared/value-objects/money.js';
import { PostgresWalletRepository } from '../infrastructure/wallets/postgres-wallet.repository.js';

interface LedgerRow {
  id: string; transaction_id: string; direction: string; currency: string;
  amount: string; balance_before: string; balance_after: string; created_at: Date;
}
const UUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
function requireId(id: string): string {
  if (!UUID_RE.test(id)) throw new BadRequestException('Invalid UUID');
  return id;
}

@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly wallets: PostgresWalletRepository,
    @Inject(MikroORM) private readonly orm: MikroORM<PostgreSqlDriver>,
  ) {}

  @Post()
  async create(@Body() raw: unknown) {
    const body = raw as Record<string, unknown>;
    if (!body || typeof body.playerId !== 'string' || !UUID_RE.test(body.playerId) ||
        !body.initialBalance || typeof body.initialBalance !== 'object') {
      throw new BadRequestException('playerId UUID and initialBalance are required');
    }
    const balance = body.initialBalance as Record<string, unknown>;
    let initialBalance: Money;
    try {
      initialBalance = Money.from({amount: balance.amount as string, currency: balance.currency as string});
    } catch {
      throw new BadRequestException('Invalid initialBalance');
    }
    try {
      const wallet = await this.wallets.create({
        walletId: randomUUID(), playerId: body.playerId, initialBalance,
      });
      return { id: wallet.id, playerId: wallet.playerId,
        balance: wallet.balance.toJSON(), version: wallet.version };
    } catch (error) {
      const pg = error as { code?: string; cause?: { code?: string } };
      if (pg.code === '23505' || pg.cause?.code === '23505') {
        throw new ConflictException('Wallet already exists for player and currency');
      }
      throw error;
    }
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string) {
    const wallet = await this.wallets.findById(requireId(walletId));
    if (!wallet) throw new NotFoundException('Wallet not found');
    return { id: wallet.id, playerId: wallet.playerId,
      balance: wallet.balance.toJSON(), version: wallet.version };
  }

  @Get(':walletId/ledger')
  async ledger(@Param('walletId') walletId: string,
               @Query('cursor') cursor?: string, @Query('limit') limitInput?: string) {
    requireId(walletId);
    const limit = limitInput === undefined ? 50 : Number(limitInput);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException('limit must be 1..100');
    }
    let after: { createdAt: string; id: string } | null = null;
    if (cursor) {
      try {
        const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        const value = decoded as { createdAt: string; id: string };
        if (!value || !UUID_RE.test(value.id) || !Number.isFinite(Date.parse(value.createdAt))) {
          throw new Error('Invalid cursor');
        }
        after = value;
      } catch {
        throw new BadRequestException('Invalid ledger cursor');
      }
    }
    const rows = await this.orm.em.fork().execute<LedgerRow[]>([
      'SELECT id, transaction_id, direction, currency, amount, balance_before, balance_after, created_at',
      'FROM wallet_ledger_entries WHERE wallet_id = ?',
      after ? 'AND (created_at, id) > (?, ?)' : '',
      'ORDER BY created_at, id LIMIT ?',
    ].join(' '), after ? [walletId, new Date(after.createdAt), after.id, limit + 1] : [walletId, limit + 1], 'all');
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      entries: page.map(row => ({ id: row.id, transactionId: row.transaction_id,
        direction: row.direction, money: { amount: String(row.amount), currency: row.currency },
        balanceBefore: { amount: String(row.balance_before), currency: row.currency },
        balanceAfter: { amount: String(row.balance_after), currency: row.currency },
        createdAt: new Date(row.created_at).toISOString() })),
      nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({
        createdAt: new Date(last.created_at).toISOString(), id: last.id,
      })).toString('base64url') : null,
    };
  }

  @Post(':walletId/reconciliation')
  async reconcile(@Param('walletId') walletId: string) {
    const wallet = await this.wallets.findById(requireId(walletId));
    if (!wallet) throw new NotFoundException('Wallet not found');
    const rows = await this.orm.em.fork().execute<Array<{ total: string; entries: number }>>([
      "SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0)::text AS total,",
      'COUNT(*)::integer AS entries FROM wallet_ledger_entries WHERE wallet_id = ?',
    ].join(' '), [walletId], 'all');
    const calculated = Money.from({ amount: rows[0].total, currency: wallet.currency });
    const difference = wallet.balance.subtract(calculated);
    return {
      walletId: wallet.id, storedBalance: wallet.balance.toJSON(),
      calculatedBalance: calculated.toJSON(), difference: difference.toJSON(),
      consistent: difference.isZero(), checkedEntries: Number(rows[0].entries),
    };
  }
}
