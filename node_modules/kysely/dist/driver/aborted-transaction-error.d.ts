declare const ABORTED_TRANSACTION_ERROR: unique symbol;
/**
 * Thrown when the database rolls back a transaction instead of committing it.
 */
export declare class AbortedTransactionError extends Error {
    name: string;
    readonly [ABORTED_TRANSACTION_ERROR] = true;
    constructor();
}
export declare function isAbortedTransactionError(error: unknown): error is AbortedTransactionError;
export {};
