//! What bids are counted in.
//!
//! `decimals` is the load-bearing field. Every bid is sealed as an integer of
//! minor units, so the number of decimal places is what turns 1250 back into
//! 12.50, and it is not 2 everywhere: the yen and the won have none, the
//! Kuwaiti dinar has three. Treating every currency as 2 would seal a 1250 yen
//! bid and open it as 12.50.
//!
//! Mirrors packages/live/src/currency.ts, which is where the create page reads
//! it. A caller who passes a code and no decimals gets the right answer instead
//! of having to know that yen has none.
//!
//! These are LABELS. Nothing here moves money or knows an exchange rate, and an
//! auction stores its own decimals, so one created today keeps rendering
//! correctly even if this table changes later. `points` is in it because plenty
//! of auctions are not denominated in money at all.

pub struct Currency {
    pub code: &'static str,
    pub name: &'static str,
    pub decimals: i64,
    pub symbol: Option<&'static str>,
}

pub const CURRENCIES: &[Currency] = &[
    Currency {
        code: "USD",
        name: "US dollar",
        decimals: 2,
        symbol: Some("$"),
    },
    Currency {
        code: "EUR",
        name: "Euro",
        decimals: 2,
        symbol: Some("€"),
    },
    Currency {
        code: "GBP",
        name: "Pound sterling",
        decimals: 2,
        symbol: Some("£"),
    },
    Currency {
        code: "INR",
        name: "Indian rupee",
        decimals: 2,
        symbol: Some("₹"),
    },
    Currency {
        code: "JPY",
        name: "Japanese yen",
        decimals: 0,
        symbol: Some("¥"),
    },
    Currency {
        code: "CNY",
        name: "Chinese yuan",
        decimals: 2,
        symbol: Some("¥"),
    },
    Currency {
        code: "AUD",
        name: "Australian dollar",
        decimals: 2,
        symbol: Some("$"),
    },
    Currency {
        code: "CAD",
        name: "Canadian dollar",
        decimals: 2,
        symbol: Some("$"),
    },
    Currency {
        code: "CHF",
        name: "Swiss franc",
        decimals: 2,
        symbol: None,
    },
    Currency {
        code: "SGD",
        name: "Singapore dollar",
        decimals: 2,
        symbol: Some("$"),
    },
    Currency {
        code: "HKD",
        name: "Hong Kong dollar",
        decimals: 2,
        symbol: Some("$"),
    },
    Currency {
        code: "NZD",
        name: "New Zealand dollar",
        decimals: 2,
        symbol: Some("$"),
    },
    Currency {
        code: "SEK",
        name: "Swedish krona",
        decimals: 2,
        symbol: None,
    },
    Currency {
        code: "NOK",
        name: "Norwegian krone",
        decimals: 2,
        symbol: None,
    },
    Currency {
        code: "DKK",
        name: "Danish krone",
        decimals: 2,
        symbol: None,
    },
    Currency {
        code: "PLN",
        name: "Polish zloty",
        decimals: 2,
        symbol: None,
    },
    Currency {
        code: "CZK",
        name: "Czech koruna",
        decimals: 2,
        symbol: None,
    },
    Currency {
        code: "HUF",
        name: "Hungarian forint",
        decimals: 2,
        symbol: None,
    },
    Currency {
        code: "RON",
        name: "Romanian leu",
        decimals: 2,
        symbol: None,
    },
    Currency {
        code: "TRY",
        name: "Turkish lira",
        decimals: 2,
        symbol: Some("₺"),
    },
    Currency {
        code: "RUB",
        name: "Russian ruble",
        decimals: 2,
        symbol: Some("₽"),
    },
    Currency {
        code: "UAH",
        name: "Ukrainian hryvnia",
        decimals: 2,
        symbol: Some("₴"),
    },
    Currency {
        code: "ILS",
        name: "Israeli shekel",
        decimals: 2,
        symbol: Some("₪"),
    },
    Currency {
        code: "AED",
        name: "UAE dirham",
        decimals: 2,
        symbol: None,
    },
    Currency {
        code: "SAR",
        name: "Saudi riyal",
        decimals: 2,
        symbol: None,
    },
    Currency {
        code: "QAR",
        name: "Qatari riyal",
        decimals: 2,
        symbol: None,
    },
    Currency {
        code: "KWD",
        name: "Kuwaiti dinar",
        decimals: 3,
        symbol: None,
    },
    Currency {
        code: "BHD",
        name: "Bahraini dinar",
        decimals: 3,
        symbol: None,
    },
    Currency {
        code: "OMR",
        name: "Omani rial",
        decimals: 3,
        symbol: None,
    },
    Currency {
        code: "JOD",
        name: "Jordanian dinar",
        decimals: 3,
        symbol: None,
    },
    Currency {
        code: "TND",
        name: "Tunisian dinar",
        decimals: 3,
        symbol: None,
    },
    Currency {
        code: "EGP",
        name: "Egyptian pound",
        decimals: 2,
        symbol: None,
    },
    Currency {
        code: "ZAR",
        name: "South African rand",
        decimals: 2,
        symbol: Some("R"),
    },
    Currency {
        code: "NGN",
        name: "Nigerian naira",
        decimals: 2,
        symbol: Some("₦"),
    },
    Currency {
        code: "KES",
        name: "Kenyan shilling",
        decimals: 2,
        symbol: None,
    },
    Currency {
        code: "GHS",
        name: "Ghanaian cedi",
        decimals: 2,
        symbol: Some("₵"),
    },
    Currency {
        code: "MAD",
        name: "Moroccan dirham",
        decimals: 2,
        symbol: None,
    },
    Currency {
        code: "BRL",
        name: "Brazilian real",
        decimals: 2,
        symbol: Some("R$"),
    },
    Currency {
        code: "MXN",
        name: "Mexican peso",
        decimals: 2,
        symbol: Some("$"),
    },
    Currency {
        code: "ARS",
        name: "Argentine peso",
        decimals: 2,
        symbol: Some("$"),
    },
    Currency {
        code: "CLP",
        name: "Chilean peso",
        decimals: 0,
        symbol: Some("$"),
    },
    Currency {
        code: "COP",
        name: "Colombian peso",
        decimals: 2,
        symbol: Some("$"),
    },
    Currency {
        code: "PEN",
        name: "Peruvian sol",
        decimals: 2,
        symbol: None,
    },
    Currency {
        code: "KRW",
        name: "South Korean won",
        decimals: 0,
        symbol: Some("₩"),
    },
    Currency {
        code: "TWD",
        name: "New Taiwan dollar",
        decimals: 2,
        symbol: Some("$"),
    },
    Currency {
        code: "THB",
        name: "Thai baht",
        decimals: 2,
        symbol: Some("฿"),
    },
    Currency {
        code: "VND",
        name: "Vietnamese dong",
        decimals: 0,
        symbol: Some("₫"),
    },
    Currency {
        code: "IDR",
        name: "Indonesian rupiah",
        decimals: 2,
        symbol: Some("Rp"),
    },
    Currency {
        code: "MYR",
        name: "Malaysian ringgit",
        decimals: 2,
        symbol: Some("RM"),
    },
    Currency {
        code: "PHP",
        name: "Philippine peso",
        decimals: 2,
        symbol: Some("₱"),
    },
    Currency {
        code: "PKR",
        name: "Pakistani rupee",
        decimals: 2,
        symbol: Some("₨"),
    },
    Currency {
        code: "BDT",
        name: "Bangladeshi taka",
        decimals: 2,
        symbol: Some("৳"),
    },
    Currency {
        code: "LKR",
        name: "Sri Lankan rupee",
        decimals: 2,
        symbol: Some("Rs"),
    },
    Currency {
        code: "NPR",
        name: "Nepalese rupee",
        decimals: 2,
        symbol: Some("Rs"),
    },
    Currency {
        code: "ISK",
        name: "Icelandic krona",
        decimals: 0,
        symbol: None,
    },
    Currency {
        code: "points",
        name: "Points, not money",
        decimals: 0,
        symbol: None,
    },
];

/// Exact match on the code, case-insensitively, so "usd" and "USD" are one
/// currency rather than two.
pub fn find(code: &str) -> Option<&'static Currency> {
    let code = code.trim();
    CURRENCIES
        .iter()
        .find(|c| c.code.eq_ignore_ascii_case(code))
}

/// Everything matching a query, best first: an exact code, then a code that
/// starts with it, then a name or symbol that contains it. The create page
/// searches by code, name and symbol because people type all three.
pub fn search(query: &str, limit: usize) -> Vec<&'static Currency> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return CURRENCIES.iter().take(limit).collect();
    }
    let mut scored: Vec<(u8, &'static Currency)> = CURRENCIES
        .iter()
        .filter_map(|c| {
            let code = c.code.to_lowercase();
            let name = c.name.to_lowercase();
            if code == q {
                Some((0, c))
            } else if code.starts_with(&q) {
                Some((1, c))
            } else if name.starts_with(&q) {
                Some((2, c))
            } else if name.contains(&q) || c.symbol.is_some_and(|s| s == query.trim()) {
                Some((3, c))
            } else {
                None
            }
        })
        .collect();
    scored.sort_by_key(|(rank, _)| *rank);
    scored.into_iter().take(limit).map(|(_, c)| c).collect()
}

pub fn to_json(c: &Currency) -> serde_json::Value {
    serde_json::json!({
        "code": c.code,
        "name": c.name,
        "decimals": c.decimals,
        "symbol": c.symbol,
    })
}
