//! Making the site findable, by search engines and by the models people now ask
//! instead of searching.
//!
//! THE PROBLEM, which is architectural rather than cosmetic. The explorer routes
//! on the URL fragment: `#/developers`, `#/protocol`, `#/mempool`. A fragment is
//! never sent to a server and search engines do not index them, so a site with
//! eleven pages of content had exactly ONE indexable URL. Everything written
//! about the protocol, the API and the use cases was invisible to every crawler
//! that has ever visited.
//!
//! THE FIX. Each page also lives at a real path, served with its own title,
//! description, canonical URL and structured data. The app still boots at that
//! path and renders the same page, so nothing about using the site changes; what
//! changes is that a crawler now has eleven documents instead of one.
//!
//! WHY THE COORDINATOR SERVES THEM. It already serves `/{name}` for auction
//! short links, because those need a per-auction preview. Page paths are the
//! same shape, so they are resolved here first and fall through to the name
//! lookup when they are not a page.
//!
//! ONE CONSEQUENCE WORTH NAMING: a page path can no longer be claimed as an
//! auction name. `PealNames` is immutable and cannot refuse them, so somebody
//! could still claim `developers` on chain; this server would keep serving the
//! page. That is the right precedence, and the reserved list below is small and
//! made of words nobody would pick for an auction.

/// A page, its address, and what it should say to a crawler.
pub struct Page {
    /// The path, without a leading slash.
    pub path: &'static str,
    /// The fragment route the app already uses, so the two cannot drift.
    pub route: &'static str,
    pub title: &'static str,
    pub description: &'static str,
    /// schema.org type. Picking the accurate one is what earns a rich result
    /// rather than a plain link.
    pub schema: &'static str,
    /// Whether it belongs in the sitemap. Pages that are a live view of state
    /// rather than a document do not.
    pub index: bool,
}

/// Titles are written for what people actually type, and read as sentences
/// rather than keyword lists, because a title that reads like SEO exhaust is
/// the one a person does not click.
pub const PAGES: &[Page] = &[
    Page {
        path: "",
        route: "#/",
        title: "Peal Network. Private submissions, programmable reveal.",
        description:
            "One API for collecting encrypted bids, votes and commitments, then opening them all at once when the deadline arrives. Nobody can read a submission early, including the operators. No wallet or gas for the people submitting.",
        // WebPage, not WebSite: the site-level WebSite node is declared once
        // beside it, and two nodes of the same type with different ids is a
        // graph a parser has to guess at.
        schema: "WebPage",
        index: true,
    },
    Page {
        path: "developers",
        route: "#/developers",
        title: "Peal API. Seal data until a deadline, then reveal it automatically.",
        description:
            "Three HTTP calls to accept encrypted submissions and open them on a timer or a block height. Timelock encryption for sealed bid auctions, private voting, commit reveal without the reveal step, and agent actions. Free, no API key, runnable examples.",
        schema: "TechArticle",
        index: true,
    },
    Page {
        path: "developers/createauction",
        route: "#/developers/createauction",
        title: "How to add sealed bid auctions to your app. Peal guide.",
        description:
            "A complete integration: open an auction with a reserve and a maximum, take encrypted bids that are all the same size on the wire, read the ranked board when it closes, and collect contact details only the seller can read. Working code, the money rules, and the mistakes worth avoiding.",
        schema: "HowTo",
        index: true,
    },
    Page {
        path: "protocol",
        route: "#/protocol",
        title: "How batched threshold encryption guarantees a reveal. Peal protocol.",
        description:
            "The protocol behind Peal: BLS12-381 batched threshold encryption, a three of five committee, fixed batches of 64, and why the reveal happens whether or not any participant cooperates. Full lifecycle, cryptography and threat model.",
        schema: "TechArticle",
        index: true,
    },
    Page {
        path: "mempool",
        route: "#/mempool",
        title: "Encrypted mempool. Stop transactions being read before they land.",
        description:
            "Seal transactions to the block they belong in, so searchers cannot read the queue and jump it. The whole block's worth opens at once when the block is due. Built on batched threshold encryption.",
        schema: "TechArticle",
        index: true,
    },
    Page {
        path: "auction",
        route: "#/auction",
        title: "Sealed bid auctions where nobody can see a bid early.",
        description:
            "Run a sealed bid auction where every bid is encrypted until the close, then all open together. No sniping, no bid copying, no trusted auctioneer holding the numbers. Bidders need no wallet and pay no gas.",
        schema: "TechArticle",
        index: true,
    },
    Page {
        path: "execution",
        route: "#/execution",
        title: "Private onchain actions. Commit now, execute on cue.",
        description:
            "Submit an action nobody can read or front run, and have it execute when the condition fires. Private execution built on Peal's timed disclosure.",
        schema: "TechArticle",
        index: true,
    },
    Page {
        path: "philosophy",
        route: "#/philosophy",
        title: "Why timed disclosure matters. Peal Network.",
        description:
            "Anywhere people submit something others must not see yet, whoever runs the server can see it. You can promise you do not look; you cannot prove it. What it takes to remove that person from the picture.",
        schema: "Article",
        index: true,
    },
    Page {
        path: "create",
        route: "#/create",
        title: "Create a sealed bid auction. No wallet, no signup.",
        description:
            "Open an auction in one click and share a link. Bids stay encrypted until your close time, then everyone sees them at once. Bidders need no wallet, no account and no gas.",
        schema: "WebPage",
        index: true,
    },
    Page {
        path: "auctions",
        route: "#/auctions",
        title: "Live sealed bid auctions on Peal.",
        description: "Auctions open on Peal right now, and the ones that have already opened.",
        schema: "WebPage",
        index: false,
    },
    Page {
        path: "app",
        route: "#/app",
        title: "Peal network explorer. Every condition and reveal.",
        description:
            "Live view of the Peal network: conditions waiting to fire, batches being opened, and every reveal the committee has performed, with the timings.",
        schema: "WebPage",
        index: false,
    },
];

pub fn find(path: &str) -> Option<&'static Page> {
    let key = path.trim_matches('/');
    PAGES.iter().find(|p| p.path == key)
}

/// The site's own name, used in structured data and the sitemap.
pub const SITE_NAME: &str = "Peal Network";

/// schema.org JSON-LD for one page.
///
/// This is the part an answer engine reads. A model summarising "what is Peal"
/// is far more likely to get it right from a typed object than from prose it
/// has to infer structure out of, and a search engine needs it for anything
/// richer than a blue link.
pub fn json_ld(page: &Page, origin: &str) -> String {
    let url = if page.path.is_empty() {
        origin.to_string()
    } else {
        format!("{origin}/{}", page.path)
    };
    let escaped = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");

    let mut graph = format!(
        r#"{{"@type":"{}","@id":"{url}#page","url":"{url}","name":"{}","description":"{}","isPartOf":{{"@id":"{origin}#website"}},"inLanguage":"en"}}"#,
        page.schema,
        escaped(page.title),
        escaped(page.description),
    );

    // The site and the product itself, declared once on the home page, which is
    // the document an engine treats as authoritative for both.
    if page.path.is_empty() {
        graph = format!(
            r#"{graph},
{{"@type":"WebSite","@id":"{origin}#website","url":"{origin}","name":"{SITE_NAME}","description":"{}"}},
{{"@type":"SoftwareApplication","@id":"{origin}#software","name":"Peal","applicationCategory":"DeveloperApplication","operatingSystem":"Any","url":"{origin}/developers","description":"An API for collecting encrypted submissions and opening them all at once at a deadline. Timelock and threshold encryption for sealed bid auctions, private voting, encrypted mempools and agent actions.","offers":{{"@type":"Offer","price":"0","priceCurrency":"USD"}},"featureList":["Sealed bid auctions","Encrypted mempool","Timed disclosure","Threshold decryption","No wallet or gas for participants"]}},
{{"@type":"Organization","@id":"{origin}#org","name":"{SITE_NAME}","url":"{origin}"}}"#,
            escaped(PAGES[0].description),
        );
    }

    // The questions people actually ask, answered plainly. An answer engine
    // quotes these; a search engine can show them directly.
    if page.path == "developers" {
        graph = format!(
            r#"{graph},
{{"@type":"FAQPage","@id":"{url}#faq","mainEntity":[
{},{},{},{}]}}"#,
            faq(
                "What is Peal?",
                "Peal is an API for collecting encrypted submissions and opening them all at the same moment. A caller encrypts a payload in their own process, sends the ciphertext, and it becomes readable only when the deadline the round names arrives."
            ),
            faq(
                "How do I encrypt data until a specific time?",
                "Create a round with the moment it should open, seal a payload to that round, and read the round back after the deadline. Sealing runs in your process, so the plaintext never reaches the network, and no single operator can open a batch early."
            ),
            faq(
                "Does Peal work for sealed bid auctions?",
                "Yes. Each auction is one round and each bid is one seal. Bids stay unreadable until the close, then every bid opens at once, so nobody can watch the leader and outbid it at the last second. Bidders need no wallet and pay no gas."
            ),
            faq(
                "How is this different from a commit and reveal scheme?",
                "In commit and reveal the participant has to come back and reveal, so whoever is losing can simply decline. With Peal the reveal is not a participant's move: the network opens the batch on its own when the condition fires."
            ),
        );
    }

    format!(
        r#"<script type="application/ld+json">{{"@context":"https://schema.org","@graph":[{graph}]}}</script>"#
    )
}

fn faq(q: &str, a: &str) -> String {
    format!(
        r#"{{"@type":"Question","name":"{q}","acceptedAnswer":{{"@type":"Answer","text":"{a}"}}}}"#
    )
}

// ------------------------------------------------------- crawler documents --

/// robots.txt, generated from the same table as everything else.
///
/// It currently returns the app shell as text/html, because nothing serves it
/// and the SPA fallback catches everything. A crawler asking for directives and
/// receiving a web page is worse than a missing file: it is a malformed answer
/// to a question that decides whether the rest of the site gets read.
pub fn robots(origin: &str) -> String {
    format!(
        "User-agent: *\n\
         Allow: /\n\
         # The API is for programs, not indexes. Nothing here is secret; it is\n\
         # simply not content, and crawling it wastes both our budget and theirs.\n\
         Disallow: /v0/\n\
         Disallow: /v1/\n\
         \n\
         Sitemap: {origin}/sitemap.xml\n"
    )
}

pub fn sitemap(origin: &str, lastmod: &str) -> String {
    let urls: String = PAGES
        .iter()
        .filter(|p| p.index)
        .map(|p| {
            let loc = if p.path.is_empty() {
                origin.to_string()
            } else {
                format!("{origin}/{}", p.path)
            };
            let priority = if p.path.is_empty() { "1.0" } else { "0.8" };
            format!(
                "  <url>\n    <loc>{loc}</loc>\n    <lastmod>{lastmod}</lastmod>\n    \
                 <changefreq>weekly</changefreq>\n    <priority>{priority}</priority>\n  </url>\n"
            )
        })
        .collect();
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n{urls}</urlset>\n"
    )
}

/// llms.txt, the convention for telling a model what a site is and where to
/// read more (llmstxt.org).
///
/// This is the whole of answer engine optimisation that is actually under our
/// control. A model asked "how do I encrypt something until a deadline" will
/// either have a clear, quotable description of this product or it will not.
/// Prose written for a crawler is prose nobody reads; this is written to be
/// quoted, which means short sentences that are true on their own.
pub fn llms_txt(origin: &str) -> String {
    let links: String = PAGES
        .iter()
        .filter(|p| p.index)
        .map(|p| {
            let loc = if p.path.is_empty() {
                origin.to_string()
            } else {
                format!("{origin}/{}", p.path)
            };
            format!("- [{}]({loc}): {}\n", p.title, p.description)
        })
        .collect();

    format!(
        "# Peal Network\n\
         \n\
         > Peal is an API for collecting encrypted submissions and opening them all at the same \
         moment. A caller encrypts a payload in their own process and sends only the ciphertext. \
         Nobody can read it early, including the operators who run the network, and when the \
         deadline arrives every submission opens at once.\n\
         \n\
         Use it when people submit something that others must not see yet: sealed bid auctions, \
         private voting, encrypted mempools, quote and procurement rounds, prediction \
         tournaments, bounty submissions, and actions taken by autonomous agents that must not be \
         front run.\n\
         \n\
         What makes it different from a commit and reveal scheme: the reveal is not a \
         participant's move. In commit and reveal, whoever is losing can simply decline to \
         reveal. Here the network opens the batch on its own when the condition fires, so there \
         is nothing to withhold.\n\
         \n\
         How it works, briefly. A ROUND is a moment and everything sealed to it. A SEAL is one \
         encrypted payload inside a round. Encryption happens in the caller's process using \
         batched threshold encryption on BLS12-381. Any three of five operators can open a batch; \
         two cannot. Batches are padded with decoys so a round does not reveal how many took \
         part, and slot positions come from the ciphertext hashes, so a batch cannot be reordered \
         after the fact.\n\
         \n\
         Getting started takes three HTTP calls and no API key, no account and no payment. \
         Participants need no wallet and pay no gas.\n\
         \n\
         ```\n\
         POST {origin}/v1/rounds        open a round with a deadline\n\
         POST {origin}/v1/rounds/ID/seals   submit an encrypted payload\n\
         GET  {origin}/v1/rounds/ID     read it; payloads appear once it opens\n\
         ```\n\
         \n\
         The client is one file with the encryption built in, loaded from the site itself:\n\
         `import {{ peal }} from '{origin}/peal.js'`\n\
         \n\
         ## Pages\n\
         \n\
         {links}\n\
         ## API\n\
         \n\
         - [API reference]({origin}/developers): every endpoint, the error codes, the rate \
         limits, and examples that run against the live network from the page.\n\
         - [Service description]({origin}/v1): payload cap, page sizes and rate limits, as JSON.\n"
    )
}

/// Today, as YYYY-MM-DD, for the sitemap's lastmod.
pub fn today() -> String {
    let unix = crate::db::unix_now();
    let days = unix.div_euclid(86_400);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}
