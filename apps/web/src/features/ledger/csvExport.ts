import type {
  Account,
  AccountId,
  CategorizationRule,
  Cents,
  RuleId,
  Transaction,
  TransactionId,
  TransactionNote,
} from '@clairflux/shared';
import { ACCOUNT_TYPE_LABELS, BANK_LABELS } from '../dashboard/types';

export const LEDGER_CATEGORIES: readonly string[] = [
  'Alimentation',
  'Logiciels & Cloud',
  'Logement & Charges',
  'Déplacements',
  'Santé',
  'Loisirs',
  'Revenus',
  'Transfert interne',
  'Autre',
];

const CSV_BOM = '\uFEFF';
const CSV_SEPARATOR = ';';
const CSV_CRLF = '\r\n';
const FORMULA_TRIGGER_CHARS = new Set<string>(['=', '+', '-', '@', '\t', '\r']);

const CSV_HEADERS = [
  'Date',
  'Banque',
  'Type de compte',
  'Compte',
  'Devise',
  'Libellé',
  'Catégorie',
  'Transfert interne',
  'Note',
  'Montant',
  'Équivalent EUR',
] as const;

export function neutralizeCsvFormula(value: string): string {
  const firstChar = value[0];
  if (firstChar !== undefined && FORMULA_TRIGGER_CHARS.has(firstChar)) {
    return `'${value}`;
  }
  return value;
}

function escapeRfc4180Cell(value: string): string {
  const needsQuotes =
    value.includes('"') ||
    value.includes(CSV_SEPARATOR) ||
    value.includes('\n') ||
    value.includes('\r');
  if (!needsQuotes) {
    return value;
  }
  return `"${value.replace(/"/g, '""')}"`;
}

function formatTextCell(value: string): string {
  return escapeRfc4180Cell(neutralizeCsvFormula(value));
}

export function formatCsvCents(cents: Cents): string {
  const normalized = cents === 0 ? 0 : cents;
  const sign = normalized < 0 ? '-' : '';
  const abs = Math.abs(normalized);
  const euros = Math.floor(abs / 100);
  const remainder = String(abs % 100).padStart(2, '0');
  return `${sign}${euros},${remainder}`;
}

export function exportTransactionsToCsv(
  transactions: readonly Transaction[],
  accounts: readonly Account[],
  notes: readonly TransactionNote[],
): string {
  const accountsById = new Map<AccountId, Account>();
  for (const account of accounts) {
    accountsById.set(account.id, account);
  }

  const notesByTxId = new Map<TransactionId, TransactionNote>();
  for (const note of notes) {
    notesByTxId.set(note.transaction_id, note);
  }

  const headerLine = CSV_HEADERS.map((header) => formatTextCell(header)).join(CSV_SEPARATOR);
  const lines: string[] = [headerLine];

  for (const tx of transactions) {
    const account = accountsById.get(tx.account_id);
    const note = notesByTxId.get(tx.id);
    const accountLabel = account ? account.nickname : tx.external_ref_masked;

    const row = [
      formatTextCell(tx.booking_date),
      formatTextCell(BANK_LABELS[tx.bank]),
      formatTextCell(ACCOUNT_TYPE_LABELS[tx.account_type]),
      formatTextCell(accountLabel),
      formatTextCell(tx.currency),
      formatTextCell(tx.clean_label),
      formatTextCell(tx.category),
      formatTextCell(tx.is_internal_transfer ? 'Oui' : 'Non'),
      formatTextCell(note ? note.content : ''),
      escapeRfc4180Cell(formatCsvCents(tx.amount_cents)),
      escapeRfc4180Cell(formatCsvCents(tx.amount_eur_cents)),
    ];
    lines.push(row.join(CSV_SEPARATOR));
  }

  return `${CSV_BOM}${lines.join(CSV_CRLF)}`;
}

export function reorderRulesByPriority(
  rules: readonly CategorizationRule[],
  ruleId: RuleId,
  direction: 'up' | 'down',
): CategorizationRule[] {
  const sorted = [...rules].sort((a, b) => {
    if (a.priority !== b.priority) {
      return a.priority - b.priority;
    }
    return a.id.localeCompare(b.id);
  });

  const currentIndex = sorted.findIndex((rule) => rule.id === ruleId);
  if (currentIndex === -1) {
    return sorted;
  }

  const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
  if (targetIndex < 0 || targetIndex >= sorted.length) {
    return sorted;
  }

  const currentRule = sorted[currentIndex];
  const targetRule = sorted[targetIndex];
  if (!currentRule || !targetRule) {
    return sorted;
  }

  sorted[currentIndex] = targetRule;
  sorted[targetIndex] = currentRule;

  const step = sorted.length > 1000 ? 1 : 10;
  return sorted.map((rule, index) => ({
    ...rule,
    priority: Math.min(10000, (index + 1) * step),
  }));
}
