import type { Transaction } from '@clairflux/shared';

// ============================================================================
// Time Range Contracts & Presets
// ============================================================================

export type TimeRangePreset = '1w' | '1m' | '3m' | '6m' | '1y' | 'all' | 'custom';

export type TimeRangeFilter =
  | { readonly preset: '1w' }
  | { readonly preset: '1m' }
  | { readonly preset: '3m' }
  | { readonly preset: '6m' }
  | { readonly preset: '1y' }
  | { readonly preset: 'all' }
  | { readonly preset: 'custom'; readonly from: string; readonly to: string };

export type ChartGranularity = 'day' | 'month';

export interface ResolvedDateBounds {
  readonly preset: TimeRangePreset;
  readonly from: string;
  readonly to: string;
  readonly daySpan: number;
  readonly granularity: ChartGranularity;
  readonly label: string;
  readonly isCustomRangeInvalid: boolean;
}

export interface TimeSlotDescriptor {
  readonly key: string;
  readonly label: string;
}

export const DAY_GRANULARITY_THRESHOLD_DAYS = 45;

export const DEFAULT_TIME_RANGE: TimeRangeFilter = { preset: '1m' };

export const TIME_RANGE_OPTIONS: readonly {
  readonly preset: TimeRangePreset;
  readonly label: string;
}[] = [
  { preset: '1w', label: '1 semaine' },
  { preset: '1m', label: '1 mois' },
  { preset: '3m', label: '3 mois' },
  { preset: '6m', label: '6 mois' },
  { preset: '1y', label: '1 an' },
  { preset: 'all', label: 'Tout' },
  { preset: 'custom', label: 'Personnalisé' },
];

const SHORT_MONTH_LABELS: readonly string[] = [
  'Janv.',
  'Févr.',
  'Mars',
  'Avr.',
  'Mai',
  'Juin',
  'Juil.',
  'Août',
  'Sept.',
  'Oct.',
  'Nov.',
  'Déc.',
];

const MS_PER_DAY = 86_400_000;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// ============================================================================
// Pure UTC Calendar Helpers
// ============================================================================

export function parseIsoDateUtc(value: string): Date | null {
  if (!ISO_DATE_REGEX.test(value)) {
    return null;
  }
  const [yearStr, monthStr, dayStr] = value.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (
    Number.isNaN(utc.getTime()) ||
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== day
  ) {
    return null;
  }
  return utc;
}

export function isValidIsoDate(value: string): boolean {
  return parseIsoDateUtc(value) !== null;
}

export function formatUtcIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDaysIso(isoDate: string, deltaDays: number): string {
  const parsed = parseIsoDateUtc(isoDate);
  if (parsed === null) {
    return isoDate;
  }
  const next = new Date(parsed.getTime() + deltaDays * MS_PER_DAY);
  return formatUtcIsoDate(next);
}

export function addMonthsClampedIso(isoDate: string, deltaMonths: number): string {
  const parsed = parseIsoDateUtc(isoDate);
  if (parsed === null) {
    return isoDate;
  }
  const totalMonths = parsed.getUTCFullYear() * 12 + parsed.getUTCMonth() + deltaMonths;
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonth = ((totalMonths % 12) + 12) % 12;
  const lastDayOfTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const targetDay = Math.min(parsed.getUTCDate(), lastDayOfTargetMonth);
  return formatUtcIsoDate(new Date(Date.UTC(targetYear, targetMonth, targetDay)));
}

export function addMonthsToYm(ym: string, deltaMonths: number): string {
  const [yearStr, monthStr] = ym.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return ym;
  }
  const totalMonths = year * 12 + (month - 1) + deltaMonths;
  const nextYear = Math.floor(totalMonths / 12);
  const nextMonth = (((totalMonths % 12) + 12) % 12) + 1;
  return `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}`;
}

export function diffDaysInclusive(fromIso: string, toIso: string): number {
  const fromDate = parseIsoDateUtc(fromIso);
  const toDate = parseIsoDateUtc(toIso);
  if (fromDate === null || toDate === null) {
    return 1;
  }
  const rawDays = Math.floor((toDate.getTime() - fromDate.getTime()) / MS_PER_DAY) + 1;
  return Math.max(1, rawDays);
}

export function formatFrenchShortDate(isoDate: string): string {
  if (!isValidIsoDate(isoDate)) {
    return isoDate;
  }
  const [year, month, day] = isoDate.split('-');
  return `${day ?? ''}/${month ?? ''}/${year ?? ''}`;
}

export function formatDayTickLabel(isoDate: string): string {
  const [, month, day] = isoDate.split('-');
  return `${day ?? ''}/${month ?? ''}`;
}

export function formatMonthTickLabel(ym: string, includeYear: boolean): string {
  const [yearStr, monthStr] = ym.split('-');
  const monthIndex = Number(monthStr) - 1;
  const shortMonth = SHORT_MONTH_LABELS[monthIndex] ?? ym;
  if (!includeYear || yearStr === undefined) {
    return shortMonth;
  }
  return `${shortMonth} ${yearStr.slice(2)}`;
}

// ============================================================================
// Bounds & Granularity Resolution
// ============================================================================

export function resolveDateBounds(
  filter: TimeRangeFilter,
  transactions: readonly Transaction[],
  referenceDateIso?: string,
): ResolvedDateBounds {
  const anchor =
    referenceDateIso !== undefined && isValidIsoDate(referenceDateIso)
      ? referenceDateIso
      : formatUtcIsoDate(new Date());

  const makeBounds = (
    preset: TimeRangePreset,
    from: string,
    to: string,
    label: string,
    isCustomRangeInvalid = false,
  ): ResolvedDateBounds => {
    const daySpan = diffDaysInclusive(from, to);
    return {
      preset,
      from,
      to,
      daySpan,
      granularity: daySpan <= DAY_GRANULARITY_THRESHOLD_DAYS ? 'day' : 'month',
      label,
      isCustomRangeInvalid,
    };
  };

  switch (filter.preset) {
    case '1w': {
      const from = addDaysIso(anchor, -6);
      return makeBounds('1w', from, anchor, '7 derniers jours');
    }
    case '1m': {
      const from = addMonthsClampedIso(anchor, -1);
      return makeBounds('1m', from, anchor, '1 dernier mois');
    }
    case '3m': {
      const from = addMonthsClampedIso(anchor, -3);
      return makeBounds('3m', from, anchor, '3 derniers mois');
    }
    case '6m': {
      const from = addMonthsClampedIso(anchor, -6);
      return makeBounds('6m', from, anchor, '6 derniers mois');
    }
    case '1y': {
      const from = addMonthsClampedIso(anchor, -12);
      return makeBounds('1y', from, anchor, '12 derniers mois');
    }
    case 'all': {
      if (transactions.length === 0) {
        const from = addMonthsClampedIso(anchor, -5);
        return makeBounds('all', from, anchor, 'Tout l’historique');
      }
      let minDate = anchor;
      let maxDate = anchor;
      let initialized = false;
      for (const tx of transactions) {
        if (!isValidIsoDate(tx.booking_date)) {
          continue;
        }
        if (!initialized) {
          minDate = tx.booking_date;
          maxDate = tx.booking_date > anchor ? tx.booking_date : anchor;
          initialized = true;
        } else {
          if (tx.booking_date < minDate) {
            minDate = tx.booking_date;
          }
          if (tx.booking_date > maxDate) {
            maxDate = tx.booking_date;
          }
        }
      }
      if (!initialized) {
        const from = addMonthsClampedIso(anchor, -5);
        return makeBounds('all', from, anchor, 'Tout l’historique');
      }
      return makeBounds('all', minDate, maxDate, 'Tout l’historique');
    }
    case 'custom': {
      const validFrom = isValidIsoDate(filter.from);
      const validTo = isValidIsoDate(filter.to);
      if (!validFrom || !validTo || filter.from > filter.to) {
        const fallbackFrom = addMonthsClampedIso(anchor, -1);
        return makeBounds(
          'custom',
          fallbackFrom,
          anchor,
          'Plage personnalisée invalide (repli sur 1 mois)',
          true,
        );
      }
      return makeBounds(
        'custom',
        filter.from,
        filter.to,
        `Du ${formatFrenchShortDate(filter.from)} au ${formatFrenchShortDate(filter.to)}`,
        false,
      );
    }
  }
}

export function isTransactionInBounds(
  tx: Pick<Transaction, 'booking_date'>,
  bounds: ResolvedDateBounds,
): boolean {
  return tx.booking_date >= bounds.from && tx.booking_date <= bounds.to;
}

export function enumerateDaySlots(from: string, to: string): readonly TimeSlotDescriptor[] {
  if (!isValidIsoDate(from) || !isValidIsoDate(to) || from > to) {
    return [];
  }
  const maxDays = 90;
  const totalDays = Math.min(diffDaysInclusive(from, to), maxDays);
  const slots: TimeSlotDescriptor[] = [];
  for (let offset = 0; offset < totalDays; offset += 1) {
    const key = addDaysIso(from, offset);
    slots.push({
      key,
      label: formatDayTickLabel(key),
    });
  }
  return slots;
}

export function enumerateMonthSlots(from: string, to: string): readonly TimeSlotDescriptor[] {
  if (!isValidIsoDate(from) || !isValidIsoDate(to) || from > to) {
    return [];
  }
  const startYm = from.slice(0, 7);
  const endYm = to.slice(0, 7);
  const includeYear = startYm.slice(0, 4) !== endYm.slice(0, 4);

  const slots: TimeSlotDescriptor[] = [];
  let cursor = startYm;
  for (let guard = 0; guard < 240; guard += 1) {
    slots.push({
      key: cursor,
      label: formatMonthTickLabel(cursor, includeYear),
    });
    if (cursor >= endYm) {
      break;
    }
    cursor = addMonthsToYm(cursor, 1);
  }
  return slots;
}
