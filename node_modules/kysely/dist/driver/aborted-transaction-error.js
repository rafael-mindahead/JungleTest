/// <reference types="./aborted-transaction-error.d.ts" />
import { isObject } from '../util/object-utils.js';
const ABORTED_TRANSACTION_ERROR = Symbol.for('kysely.AbortedTransactionError');
/**
 * Thrown when the database rolls back a transaction instead of committing it.
 */
export class AbortedTransactionError extends Error {
    name = 'AbortedTransactionError';
    [ABORTED_TRANSACTION_ERROR] = true;
    constructor() {
        super('Transaction was rolled back instead of committed');
    }
}
export function isAbortedTransactionError(error) {
    return isObject(error) && ABORTED_TRANSACTION_ERROR in error;
}
