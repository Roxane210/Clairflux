import {
  convertToEurCents,
  parseAccountId,
  parseRuleId,
  parseTransactionId,
  toCents,
  toFxRateMicro,
  toSyncRevision,
  type Account,
  type CategorizationRule,
  type Transaction,
  type TransactionNote,
} from '@clairflux/shared';
import { describe, expect, it } from 'vitest';
import { exportTransactionsToCsv, reorderRulesByPriority } from './csvExport';

const ACC_BOURSO = parseAccountId('11111111-1111-4111-8111-111111111111');
const ACC_REVOLUT_USD = parseAccountId('22222222-2222-4222-8222-222222222222');

const TX_EUR = parseTransactionId('33333333-3333-4333-8333-333333333331');
const TX_USD = parseTransactionId('33333333-3333-4333-8333-333333333332');
const TX_INJECT = parseTransactionId('33333333-3333-4333-8333-333333333333');

const RULE_1 = parseRuleId('44444444-4444-4444-8444-444444444441');
const RULE_2 = parseRuleId('44444444-4444-4444-8444-444444444442');
const RULE_3 = parseRuleId('44444444-4444-4444-8444-444444444443');
const RULE_UNKNOWN = parseRuleId('44444444-4444-4444-8444-444444444999');

const SAMPLE_ACCOUNTS: readonly Account[] = [
  {
    id: ACC_BOURSO,
    bank: 'boursobank',
    account_type: 'carte_differee',
    nickname: 'Carte Ultim',
    external_ref_masked: '•••• 7712',
    currency: 'EUR',
    current_balance_cents: toCents(-64210),
    current_balance_eur_cents: toCents(-64210),
    balance_updated_at: '2026-11-20T23:59:59.000Z',
    revision: toSyncRevision(10),
    updated_at: '2026-11-20T18:02:12.000Z',
  },
  {
    id: ACC_REVOLUT_USD,
    bank: 'revolut',
    account_type: 'multi_devises',
    nickname: 'Courant USD',
    external_ref_masked: 'USD •• 9012',
    currency: 'USD',
    current_balance_cents: toCents(185000),
    current_balance_eur_cents: convertToEurCents(toCents(185000), toFxRateMicro(924500)),
    balance_updated_at: '2026-11-20T23:59:59.000Z',
    revision: toSyncRevision(11),
    updated_at: '2026-11-20T18:02:15.000Z',
  },
];

function makeRule(id: ReturnType<typeof parseRuleId>, name: string, priority: number): CategorizationRule {
  return {
    id,
    name,
    priority,
    bank_filter: null,
    account_id_filter: null,
    account_type_filter: null,
    match_mode: 'contains',
    pattern: name.toUpperCase(),
    target_category: 'Alimentation',
    mark_as_internal_transfer: false,
    is_active: true,
    revision: toSyncRevision(1),
    updated_at: '2026-11-20T10:00:00.000Z',
  };
}

describe('exportTransactionsToCsv', () => {
  it('exports RFC-4180 CSV with UTF-8 BOM, semicolon separator, multi-currency EUR/USD, and custom notes', () => {
    const fxMicro = toFxRateMicro(924500);
    const transactions: readonly Transaction[] = [
      {
        id: TX_USD,
        account_id: ACC_REVOLUT_USD,
        bank: 'revolut',
        account_type: 'multi_devises',
        external_ref_masked: 'USD •• 9012',
        booking_date: '2026-11-18',
        value_date: '2026-11-18',
        raw_label: 'CURSOR AI *MONTHLY',
        clean_label: 'Cursor AI',
        amount_cents: toCents(-2000),
        currency: 'USD',
        fx_rate_micro: fxMicro,
        amount_eur_cents: convertToEurCents(toCents(-2000), fxMicro),
        category: 'Logiciels & Cloud',
        is_manual_category: false,
        matched_rule_id: RULE_1,
        is_internal_transfer: false,
        is_manual_transfer_override: false,
        transfer_group_id: null,
        source_drive_file_id: '88888888-8888-4888-8888-888888888881',
        revision: toSyncRevision(12),
        updated_at: '2026-11-18T09:00:00.000Z',
      },
      {
        id: TX_EUR,
        account_id: ACC_BOURSO,
        bank: 'boursobank',
        account_type: 'carte_differee',
        external_ref_masked: '•••• 7712',
        booking_date: '2026-11-15',
        value_date: '2026-11-15',
        raw_label: 'VIREMENT INTERNE',
        clean_label: 'Virement épargne',
        amount_cents: toCents(50000),
        currency: 'EUR',
        fx_rate_micro: toFxRateMicro(1_000_000),
        amount_eur_cents: toCents(50000),
        category: 'Transfert interne',
        is_manual_category: true,
        matched_rule_id: null,
        is_internal_transfer: true,
        is_manual_transfer_override: false,
        transfer_group_id: '99999999-9999-4999-8999-999999999991',
        source_drive_file_id: '88888888-8888-4888-8888-888888888882',
        revision: toSyncRevision(13),
        updated_at: '2026-11-15T12:00:00.000Z',
      },
    ];

    const notes: readonly TransactionNote[] = [
      {
        transaction_id: TX_USD,
        content: 'Abonnement annuel; dev "pro"',
        revision: toSyncRevision(14),
        updated_at: '2026-11-19T09:10:00.000Z',
      },
    ];

    const csv = exportTransactionsToCsv(transactions, SAMPLE_ACCOUNTS, notes);
    expect(csv.startsWith('\uFEFF')).toBe(true);

    const rows = csv.slice(1).split('\r\n');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toBe(
      'Date;Banque;Type de compte;Compte;Devise;Libellé;Catégorie;Transfert interne;Note;Montant;Équivalent EUR',
    );
    expect(rows[1]).toBe(
      '2026-11-18;Revolut;Multi-devises;Courant USD;USD;Cursor AI;Logiciels & Cloud;Non;"Abonnement annuel; dev ""pro""";-20,00;-18,49',
    );
    expect(rows[2]).toBe(
      '2026-11-15;BoursoBank;Carte différée;Carte Ultim;EUR;Virement épargne;Transfert interne;Oui;;500,00;500,00',
    );
  });

  it('neutralizes CSV formula injection payloads across all trigger characters (=, +, -, @, \\t, \\r)', () => {
    const payloads = [
      '=cmd|"/C calc"!A0',
      '+SUM(A1:A2)',
      '-10+20',
      '@SUM(1+1)',
      '\tIMPORTXML()',
      '\rHYPERLINK("https://evil.example")',
    ] as const;

    for (const payload of payloads) {
      const tx: Transaction = {
        id: TX_INJECT,
        account_id: ACC_BOURSO,
        bank: 'boursobank',
        account_type: 'courant',
        external_ref_masked: '•••• 4821',
        booking_date: '2026-11-10',
        value_date: '2026-11-10',
        raw_label: payload,
        clean_label: payload,
        amount_cents: toCents(-1250),
        currency: 'EUR',
        fx_rate_micro: toFxRateMicro(1_000_000),
        amount_eur_cents: toCents(-1250),
        category: '+Catégorie',
        is_manual_category: false,
        matched_rule_id: null,
        is_internal_transfer: false,
        is_manual_transfer_override: false,
        transfer_group_id: null,
        source_drive_file_id: '88888888-8888-4888-8888-888888888883',
        revision: toSyncRevision(15),
        updated_at: '2026-11-10T10:00:00.000Z',
      };
      const note: TransactionNote = {
        transaction_id: TX_INJECT,
        content: '=1+1',
        revision: toSyncRevision(16),
        updated_at: '2026-11-10T10:05:00.000Z',
      };

      const csv = exportTransactionsToCsv([tx], SAMPLE_ACCOUNTS, [note]);
      const dataRow = csv.slice(1).split('\r\n')[1] ?? '';

      expect(dataRow).toContain(`'${payload.replace(/"/g, '""')}`);
      expect(dataRow).toContain("'+Catégorie");
      expect(dataRow).toContain("'=1+1");
      expect(dataRow.endsWith(';-12,50;-12,50')).toBe(true);
    }
  });
});

describe('reorderRulesByPriority', () => {
  it('moves a rule up and down and reassigns clean sequential priorities without mutating input', () => {
    const initial: readonly CategorizationRule[] = [
      makeRule(RULE_2, 'Biocoop', 20),
      makeRule(RULE_1, 'Cursor', 10),
      makeRule(RULE_3, 'SNCF', 30),
    ];

    const movedUp = reorderRulesByPriority(initial, RULE_3, 'up');
    expect(movedUp.map((r) => [r.id, r.priority])).toEqual([
      [RULE_1, 10],
      [RULE_3, 20],
      [RULE_2, 30],
    ]);
    expect(initial[0]?.priority).toBe(20);

    const movedDown = reorderRulesByPriority(movedUp, RULE_1, 'down');
    expect(movedDown.map((r) => [r.id, r.priority])).toEqual([
      [RULE_3, 10],
      [RULE_1, 20],
      [RULE_2, 30],
    ]);
  });

  it('keeps order unchanged at boundaries or for unknown rule id', () => {
    const initial: readonly CategorizationRule[] = [
      makeRule(RULE_1, 'Cursor', 10),
      makeRule(RULE_2, 'Biocoop', 20),
    ];

    expect(reorderRulesByPriority(initial, RULE_1, 'up').map((r) => r.id)).toEqual([RULE_1, RULE_2]);
    expect(reorderRulesByPriority(initial, RULE_2, 'down').map((r) => r.id)).toEqual([RULE_1, RULE_2]);
    expect(reorderRulesByPriority(initial, RULE_UNKNOWN, 'up').map((r) => r.id)).toEqual([RULE_1, RULE_2]);
  });
});
