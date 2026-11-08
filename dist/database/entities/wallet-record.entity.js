var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import { DecimalType } from '@mikro-orm/core';
import { Entity, PrimaryKey, Property, Unique, } from '@mikro-orm/decorators/legacy';
let WalletRecord = class WalletRecord {
    id;
    playerId;
    currency;
    balance;
    version;
    createdAt;
    updatedAt;
};
__decorate([
    PrimaryKey({ type: 'uuid' }),
    __metadata("design:type", String)
], WalletRecord.prototype, "id", void 0);
__decorate([
    Property({ type: 'uuid', fieldName: 'player_id' }),
    __metadata("design:type", String)
], WalletRecord.prototype, "playerId", void 0);
__decorate([
    Property({ type: 'string', length: 3 }),
    __metadata("design:type", String)
], WalletRecord.prototype, "currency", void 0);
__decorate([
    Property({
        type: DecimalType,
        precision: 20,
        scale: 2,
    }),
    __metadata("design:type", String)
], WalletRecord.prototype, "balance", void 0);
__decorate([
    Property({ type: 'integer' }),
    __metadata("design:type", Number)
], WalletRecord.prototype, "version", void 0);
__decorate([
    Property({
        type: 'datetime',
        columnType: 'timestamptz',
        fieldName: 'created_at',
    }),
    __metadata("design:type", Date)
], WalletRecord.prototype, "createdAt", void 0);
__decorate([
    Property({
        type: 'datetime',
        columnType: 'timestamptz',
        fieldName: 'updated_at',
    }),
    __metadata("design:type", Date)
], WalletRecord.prototype, "updatedAt", void 0);
WalletRecord = __decorate([
    Entity({ tableName: 'wallets' }),
    Unique({
        properties: ['playerId', 'currency'],
        name: 'wallets_player_currency_unique',
    })
], WalletRecord);
export { WalletRecord };
//# sourceMappingURL=wallet-record.entity.js.map