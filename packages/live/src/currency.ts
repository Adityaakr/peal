/** What bids are counted in.
 *
 * `decimals` is the load-bearing field. Every bid is sealed as an integer of
 * minor units, so the number of decimal places is what turns "1250" back into
 * 12.50, and it is not 2 everywhere: the yen and the won have none, and the
 * Kuwaiti dinar has three. Treating every currency as 2 would seal a ¥1250 bid
 * and open it as ¥12.50.
 *
 * Values are ISO 4217 minor units. `points` is not a currency and is here
 * because plenty of livestream auctions are not denominated in money at all.
 *
 * These are LABELS. Nothing in Peal Live moves money, converts between
 * currencies, or knows an exchange rate, and the terms carry their own
 * `decimals` so an auction created today keeps rendering correctly even if this
 * table changes later.
 */
export interface Currency {
  code: string;
  name: string;
  decimals: number;
  symbol?: string;
}

export const CURRENCIES: readonly Currency[] = [
  { code: 'USD', name: 'US dollar', decimals: 2, symbol: '$' },
  { code: 'EUR', name: 'Euro', decimals: 2, symbol: '€' },
  { code: 'GBP', name: 'Pound sterling', decimals: 2, symbol: '£' },
  { code: 'INR', name: 'Indian rupee', decimals: 2, symbol: '₹' },
  { code: 'JPY', name: 'Japanese yen', decimals: 0, symbol: '¥' },
  { code: 'CNY', name: 'Chinese yuan', decimals: 2, symbol: '¥' },
  { code: 'AUD', name: 'Australian dollar', decimals: 2, symbol: '$' },
  { code: 'CAD', name: 'Canadian dollar', decimals: 2, symbol: '$' },
  { code: 'CHF', name: 'Swiss franc', decimals: 2 },
  { code: 'SGD', name: 'Singapore dollar', decimals: 2, symbol: '$' },
  { code: 'HKD', name: 'Hong Kong dollar', decimals: 2, symbol: '$' },
  { code: 'NZD', name: 'New Zealand dollar', decimals: 2, symbol: '$' },
  { code: 'SEK', name: 'Swedish krona', decimals: 2 },
  { code: 'NOK', name: 'Norwegian krone', decimals: 2 },
  { code: 'DKK', name: 'Danish krone', decimals: 2 },
  { code: 'PLN', name: 'Polish zloty', decimals: 2 },
  { code: 'CZK', name: 'Czech koruna', decimals: 2 },
  { code: 'HUF', name: 'Hungarian forint', decimals: 2 },
  { code: 'RON', name: 'Romanian leu', decimals: 2 },
  { code: 'TRY', name: 'Turkish lira', decimals: 2, symbol: '₺' },
  { code: 'RUB', name: 'Russian ruble', decimals: 2, symbol: '₽' },
  { code: 'UAH', name: 'Ukrainian hryvnia', decimals: 2, symbol: '₴' },
  { code: 'ILS', name: 'Israeli shekel', decimals: 2, symbol: '₪' },
  { code: 'AED', name: 'UAE dirham', decimals: 2 },
  { code: 'SAR', name: 'Saudi riyal', decimals: 2 },
  { code: 'QAR', name: 'Qatari riyal', decimals: 2 },
  { code: 'KWD', name: 'Kuwaiti dinar', decimals: 3 },
  { code: 'BHD', name: 'Bahraini dinar', decimals: 3 },
  { code: 'OMR', name: 'Omani rial', decimals: 3 },
  { code: 'JOD', name: 'Jordanian dinar', decimals: 3 },
  { code: 'TND', name: 'Tunisian dinar', decimals: 3 },
  { code: 'EGP', name: 'Egyptian pound', decimals: 2 },
  { code: 'ZAR', name: 'South African rand', decimals: 2, symbol: 'R' },
  { code: 'NGN', name: 'Nigerian naira', decimals: 2, symbol: '₦' },
  { code: 'KES', name: 'Kenyan shilling', decimals: 2 },
  { code: 'GHS', name: 'Ghanaian cedi', decimals: 2, symbol: '₵' },
  { code: 'MAD', name: 'Moroccan dirham', decimals: 2 },
  { code: 'BRL', name: 'Brazilian real', decimals: 2, symbol: 'R$' },
  { code: 'MXN', name: 'Mexican peso', decimals: 2, symbol: '$' },
  { code: 'ARS', name: 'Argentine peso', decimals: 2, symbol: '$' },
  { code: 'CLP', name: 'Chilean peso', decimals: 0, symbol: '$' },
  { code: 'COP', name: 'Colombian peso', decimals: 2, symbol: '$' },
  { code: 'PEN', name: 'Peruvian sol', decimals: 2 },
  { code: 'KRW', name: 'South Korean won', decimals: 0, symbol: '₩' },
  { code: 'TWD', name: 'New Taiwan dollar', decimals: 2, symbol: '$' },
  { code: 'THB', name: 'Thai baht', decimals: 2, symbol: '฿' },
  { code: 'VND', name: 'Vietnamese dong', decimals: 0, symbol: '₫' },
  { code: 'IDR', name: 'Indonesian rupiah', decimals: 2, symbol: 'Rp' },
  { code: 'MYR', name: 'Malaysian ringgit', decimals: 2, symbol: 'RM' },
  { code: 'PHP', name: 'Philippine peso', decimals: 2, symbol: '₱' },
  { code: 'PKR', name: 'Pakistani rupee', decimals: 2, symbol: '₨' },
  { code: 'BDT', name: 'Bangladeshi taka', decimals: 2, symbol: '৳' },
  { code: 'LKR', name: 'Sri Lankan rupee', decimals: 2, symbol: 'Rs' },
  { code: 'NPR', name: 'Nepalese rupee', decimals: 2, symbol: 'Rs' },
  { code: 'ISK', name: 'Icelandic krona', decimals: 0 },
  { code: 'points', name: 'Points, not money', decimals: 0 },
] as const;

const BY_CODE = new Map(CURRENCIES.map((c) => [c.code.toLowerCase(), c]));

/** Look up a currency, case insensitively. Null when it is not one we know.
 *
 * Null rather than a default, because the field it backs is a free text input:
 * silently falling back to dollars would seal an auction denominated in
 * something the seller did not choose. */
export function findCurrency(code: string): Currency | null {
  return BY_CODE.get(code.trim().toLowerCase()) ?? null;
}

/** Currencies matching a typed query, best first.
 *
 * Matches the code, the name and the symbol, so "inr", "rupee", "india" and "₹"
 * all find the same row. A code that starts with the query outranks a name that
 * merely contains it, so typing "in" offers INR before Argentine peso.
 *
 * Ties break on the table's own order rather than alphabetically. Both "Indian
 * rupee" and "Indonesian rupiah" contain "rup", and sorting those by code puts
 * IDR first, which is not what somebody typing it usually means. The table is
 * ordered roughly by how often a currency is reached for, so leaning on that is
 * an editorial choice already made rather than a new one.
 */
export function searchCurrencies(query: string, limit = 12): Currency[] {
  const q = query.trim().toLowerCase();
  if (!q) return CURRENCIES.slice(0, limit);

  const scored: Array<{ c: Currency; rank: number; order: number }> = [];
  for (const [order, c] of CURRENCIES.entries()) {
    const code = c.code.toLowerCase();
    const name = c.name.toLowerCase();
    const rank = code === q ? 0
      : code.startsWith(q) ? 1
        : name.startsWith(q) ? 2
          : c.symbol === query.trim() ? 3
            : name.includes(q) ? 4
              : code.includes(q) ? 5
                : -1;
    if (rank >= 0) scored.push({ c, rank, order });
  }
  scored.sort((a, b) => a.rank - b.rank || a.order - b.order);
  return scored.slice(0, limit).map((s) => s.c);
}

/** How a currency reads in a list: "INR — Indian rupee ₹". */
export function currencyLabel(c: Currency): string {
  return `${c.code} — ${c.name}${c.symbol ? ` ${c.symbol}` : ''}`;
}
