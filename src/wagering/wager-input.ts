import { BadRequestException } from '@nestjs/common';
import { Money } from '../domain/shared/value-objects/money.js';
import type { WagerKind } from '../domain/wagering/wager-transaction.js';

const UUID_RE = /^[a-f\\d]{8}(-[a-f\\d]{4}){3}-[a-f\\d]{12}$/i;

export interface WagerInput {
  providerId: string; externalTransactionId: string; playerId: string;
  walletId: string; roundId: string; gameId: string; kind: WagerKind;
  money: Money; referenceExternalTransactionId?: string;
}
export function nonempty(value: unknown, name: string, maxLength = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new BadRequestException(name + ' must be a nonempty string (max ' + maxLength + ')');
  }
  return value;
}
export function uuid(value: unknown, name: string): string {
  const v = nonempty(value, name);
  if (!UUID_RE.test(v)) throw new BadRequestException(name + ' must be UUID');
  return v.toLowerCase();
}
export function parseInput(raw: unknown): WagerInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BadRequestException('Body must be an object');
  }
  const input = raw as Record<string, unknown>;
  if (!['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'].includes(String(input.kind))) {
    throw new BadRequestException('Invalid transaction kind');
  }
  if (!input.money || typeof input.money !== 'object' || Array.isArray(input.money)) {
    throw new BadRequestException('money must be a decimal amount and currency');
  }
  const monetary = input.money as Record<string, unknown>;
  let money: Money;
  try {
    money = Money.from({ amount: monetary.amount as string, currency: monetary.currency as string });
  } catch {
    throw new BadRequestException('Invalid money: require nonnegative decimal string with two places and ISO currency');
  }
  if (!money.isPositive()) throw new BadRequestException('Transaction amount must be positive');
  const kind = input.kind as WagerKind;
  const reference = input.referenceExternalTransactionId === undefined
    ? undefined : nonempty(input.referenceExternalTransactionId, 'referenceExternalTransactionId');
  if (['REFUND', 'ROLLBACK'].includes(kind) && !reference) {
    throw new BadRequestException('REFUND/ROLLBACK require referenceExternalTransactionId');
  }
  const externalId = nonempty(input.externalTransactionId, 'externalTransactionId');
  if (reference === externalId) {
    throw new BadRequestException('A transaction cannot reference itself');
  }
  if (kind === 'BET' && reference) {
    throw new BadRequestException('BET does not accept referenceExternalTransactionId');
  }
  return {
    providerId: nonempty(input.providerId, 'providerId', 128),
    externalTransactionId: externalId,
    playerId: uuid(input.playerId, 'playerId'), walletId: uuid(input.walletId, 'walletId'),
    roundId: nonempty(input.roundId, 'roundId'), gameId: nonempty(input.gameId, 'gameId'),
    kind, money, referenceExternalTransactionId: reference,
  };
}
