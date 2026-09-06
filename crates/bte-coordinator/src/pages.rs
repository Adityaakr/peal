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
/// The developer section's preview card. One image for the whole section: it
/// says "Developer Docs" rather than naming a page, so it stays accurate as
/// pages are added, and a reader who has seen it once recognises the next link.
const DEV_CARD: &str = "/developers.jpg";

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
    /// A preview card image, as an absolute path from the site root.
    ///
    /// Most pages deliberately have none. A link to Peal should arrive as a
    /// line of text that says what it is rather than a slab of branding, and an
    /// og:image is hard to withdraw once shared links carry it. The developer
    /// section is the exception: it is the thing people paste into a team
    /// channel, where a card is what makes it read as documentation rather than
    /// a bare URL.
    pub image: Option<&'static str>,
    /// Card text: (title, description), used for og: and twitter: only.
    ///
    /// Separate from `title` and `description` because the two audiences want
    /// different things. A search result wants the words somebody typed into a
    /// search box. A card pasted into a channel wants the sentence that says
    /// what this is. Forcing one string to do both means either a card that
    /// reads like a keyword list or a title that competes with the home page
    /// for the same query, which is how a site ends up outranking itself.
    ///
    /// None means the card reuses `title` and `description`, which is right
    /// almost everywhere.
    pub share: Option<(&'static str, &'static str)>,
}

/// Titles are written for what people actually type, and read as sentences
/// rather than keyword lists, because a title that reads like SEO exhaust is
/// the one a person does not click.
pub const PAGES: &[Page] = &[
    Page {
        path: "",
        route: "#/",
        title: "Peal. The programmable confidentiality layer for digital markets.",
        description:
            "One API to collect encrypted bids, offers, votes, commitments and agent intents, then reveal them only when predefined conditions are met. Nobody can read a submission early, including the operators. No wallet or gas for the people submitting.",
        // WebPage, not WebSite: the site-level WebSite node is declared once
        // beside it, and two nodes of the same type with different ids is a
        // graph a parser has to guess at.
        schema: "WebPage",
        index: true,
        image: None,
        share: None,
    },
    Page {
        path: "developers",
        route: "#/developers",
        title: "Peal API. Seal data until a deadline, then reveal it automatically.",
        description:
            "Three HTTP calls to accept encrypted submissions and open them on a timer or a block height. Timelock encryption for sealed bid auctions, private voting, commit reveal without the reveal step, and agent actions. Free, no API key, runnable examples.",
        schema: "TechArticle",
        index: true,
        image: Some(DEV_CARD),
        share: Some((
            "The programmable confidentiality layer for digital markets.",
            "One API to collect encrypted bids, offers, votes, commitments and agent intents, \
             then reveal them only when predefined conditions are met.",
        )),
    },
    Page {
        path: "developers/quickstart",
        route: "#/developers/quickstart",
        title: "Peal quickstart. Three calls to seal data until a deadline.",
        description:
            "Open a round, seal an encrypted payload to it, and read it back when it opens. Runnable against the live network from the page, with no signup, no API key and no wallet.",
        schema: "WebPage",
        // The procedure is emitted as its own HowTo node with real steps, so
        // this one is the page rather than a second, emptier HowTo beside it.
        index: true,
        image: Some(DEV_CARD),
        share: None,
    },
    Page {
        path: "developers/agents",
        route: "#/developers/agents",
        title: "Add Peal from Claude Code or any coding agent. One skill.",
        description:
            "Install one skill and your agent can add sealed bids and timed disclosure to an application without reading the docs first. Four markdown files, no package, no registry, no account.",
        schema: "HowTo",
        index: true,
        image: Some(DEV_CARD),
        share: None,
    },
    Page {
        path: "developers/howitworks",
        route: "#/developers/howitworks",
        title: "How Peal works. Batched threshold encryption, explained.",
        description:
            "The cue is a row that fires on its own, the encryption happens on the caller's machine, and three of five operators open a batch. What you can check afterwards, and why the batch is padded.",
        schema: "TechArticle",
        index: true,
        image: Some(DEV_CARD),
        share: None,
    },
    Page {
        path: "developers/auctions",
        route: "#/developers/auctions",
        title: "Sealed bid auctions API. Reserve, maximum, ranked results.",
        description:
            "Run a sealed bid auction in three calls. Every bid is the same size on the wire, a maximum stops joke bids, the result is a queue rather than only a winner, and replays are discarded.",
        schema: "TechArticle",
        index: true,
        image: Some(DEV_CARD),
        share: None,
    },
    Page {
        path: "developers/usecases",
        route: "#/developers/usecases",
        title: "What to build with timed disclosure. Peal.",
        description:
            "Sealed bid auctions, encrypted mempools, private voting, agent actions, procurement and quotes, prediction tournaments, bounty submissions and fair launches.",
        schema: "TechArticle",
        index: true,
        image: Some(DEV_CARD),
        share: None,
    },
    Page {
        path: "developers/api",
        route: "#/developers/api",
        title: "Peal API reference. Rounds, seals, auctions.",
        description:
            "Every endpoint with its parameters, the RFC 9457 error codes to branch on, the rate limit headers and the one-file client. Plain JSON over HTTP, no key.",
        schema: "APIReference",
        index: true,
        image: Some(DEV_CARD),
        share: None,
    },
    Page {
        path: "developers/x402",
        route: "#/developers/x402",
        title: "Metered API calls with x402 on Peal.",
        description:
            "Charge per sealed action with HTTP 402: the server quotes a price, the caller pays on \
             Tempo, and the response carries the transaction hash. No account, no API key, no \
             invoice. The free API is unchanged.",
        schema: "TechArticle",
        index: true,
        image: Some(DEV_CARD),
        share: None,
    },
    Page {
        path: "developers/limits",
        route: "#/developers/limits",
        title: "Peal API limits and errors.",
        description:
            "What the server enforces: payload caps, page sizes, rate limits, batch size, and the error codes returned when you cross one.",
        schema: "TechArticle",
        index: true,
        image: Some(DEV_CARD),
        share: None,
    },
    Page {
        path: "developers/network",
        route: "#/developers/network",
        title: "Activity on the Peal network.",
        description:
            "Rounds created, payloads sealed, batches opened, how long opening takes and how often the agent skill is installed, counted from the coordinator's own tables. No visitor tracking: there are no accounts on this network to count.",
        schema: "WebPage",
        index: false,
        image: Some(DEV_CARD),
        share: None,
    },
    Page {
        path: "developers/roadmap",
        route: "#/developers/roadmap",
        title: "Peal roadmap. Peal Commit and paid access.",
        description:
            "The one-call seal API, webhook delivery, an MCP tool, x402 paid access and typed SDKs, with what is live stated separately from what is not.",
        schema: "WebPage",
        index: true,
        image: Some(DEV_CARD),
        share: None,
    },
    Page {
        path: "developers/createauction",
        route: "#/developers/createauction",
        title: "How to add sealed bid auctions to your app. Peal guide.",
        description:
            "A complete integration: open an auction with a reserve and a maximum, take encrypted bids that are all the same size on the wire, read the ranked board when it closes, and collect contact details only the seller can read. Working code, the money rules, and the mistakes worth avoiding.",
        schema: "HowTo",
        index: true,
        image: Some(DEV_CARD),
        share: None,
    },
    Page {
        path: "protocol",
        route: "#/protocol",
        title: "How batched threshold encryption guarantees a reveal. Peal protocol.",
        description:
            "The protocol behind Peal: BLS12-381 batched threshold encryption, a three of five committee, fixed batches of 64, and why the reveal happens whether or not any participant cooperates. Full lifecycle, cryptography and threat model.",
        schema: "TechArticle",
        index: true,
        image: None,
        share: None,
    },
    Page {
        path: "mempool",
        route: "#/mempool",
        title: "Encrypted mempool. Stop transactions being read before they land.",
        description:
            "Seal transactions to the block they belong in, so searchers cannot read the queue and jump it. The whole block's worth opens at once when the block is due. Built on batched threshold encryption.",
        schema: "TechArticle",
        index: true,
        image: None,
        share: None,
    },
    Page {
        path: "auction",
        route: "#/auction",
        title: "Sealed bid auctions where nobody can see a bid early.",
        description:
            "Run a sealed bid auction where every bid is encrypted until the close, then all open together. No sniping, no bid copying, no trusted auctioneer holding the numbers. Bidders need no wallet and pay no gas.",
        schema: "TechArticle",
        index: true,
        image: None,
        share: None,
    },
    Page {
        path: "execution",
        route: "#/execution",
        title: "Private onchain actions. Commit now, execute on cue.",
        description:
            "Submit an action nobody can read or front run, and have it execute when the condition fires. Private execution built on Peal's timed disclosure.",
        schema: "TechArticle",
        index: true,
        image: None,
        share: None,
    },
    Page {
        path: "philosophy",
        route: "#/philosophy",
        title: "Why timed disclosure matters. Peal Network.",
        description:
            "Anywhere people submit something others must not see yet, whoever runs the server can see it. You can promise you do not look; you cannot prove it. What it takes to remove that person from the picture.",
        schema: "Article",
        index: true,
        image: None,
        share: None,
    },
    Page {
        path: "create",
        route: "#/create",
        title: "Create a sealed bid auction. No wallet, no signup.",
        description:
            "Open an auction in one click and share a link. Bids stay encrypted until your close time, then everyone sees them at once. Bidders need no wallet, no account and no gas.",
        schema: "WebPage",
        index: true,
        image: None,
        share: None,
    },
    Page {
        path: "app",
        route: "#/app",
        title: "Peal network explorer. Every condition and reveal.",
        description:
            "Live view of the Peal network: conditions waiting to fire, batches being opened, and every reveal the committee has performed, with the timings.",
        schema: "WebPage",
        index: false,
        image: None,
        share: None,
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

    // The questions people actually ask, answered plainly.
    //
    // An answer engine quotes these and a search engine can show them directly,
    // which makes them the highest leverage text on the site: they are the only
    // part written to be lifted whole. So they are answers, not teasers, and
    // they are wrong the moment the product changes, which is why they live
    // beside the page table rather than in the markup.
    if let Some(questions) = faqs_for(page.path) {
        let entries: Vec<String> = questions.iter().map(|(q, a)| faq(q, a)).collect();
        graph = format!(
            r#"{graph},
{{"@type":"FAQPage","@id":"{url}#faq","mainEntity":[{}]}}"#,
            entries.join(",")
        );
    }

    // The steps, for the one page that is a procedure. A HowTo is the shape an
    // answer engine reaches for when somebody asks how to do a thing, and this
    // page is literally three calls in order.
    if page.path == "developers/quickstart" {
        graph = format!(
            r#"{graph},
{{"@type":"HowTo","@id":"{url}#howto","name":"Seal data until a deadline with the Peal API","totalTime":"PT5M","estimatedCost":{{"@type":"MonetaryAmount","currency":"USD","value":"0"}},"step":[{{"@type":"HowToStep","position":1,"name":"Open a round","text":"POST /v1/rounds with opens_in or opens_at. The round is the moment everything sealed to it becomes readable. No API key and no account are needed.","url":"{url}#the-three-calls"}},{{"@type":"HowToStep","position":2,"name":"Seal a payload","text":"Encrypt in your own process against the committee public parameters and POST the ciphertext to /v1/rounds/ID/seals. The plaintext never leaves your machine.","url":"{url}#the-three-calls"}},{{"@type":"HowToStep","position":3,"name":"Read it after the deadline","text":"GET /v1/rounds/ID. Before the deadline it reports its status and nothing about what is inside. After it, every payload is readable at once.","url":"{url}#the-three-calls"}}]}}"#
        );
    }

    // Where this page sits, for the nested ones. A crawler that knows the
    // hierarchy shows it in the result instead of a bare URL.
    if let Some((section, _)) = page.path.split_once('/') {
        if let Some(parent) = PAGES.iter().find(|p| p.path == section) {
            graph = format!(
                r#"{graph},
{{"@type":"BreadcrumbList","@id":"{url}#breadcrumb","itemListElement":[{{"@type":"ListItem","position":1,"name":"{}","item":"{origin}"}},{{"@type":"ListItem","position":2,"name":"{}","item":"{origin}/{}"}},{{"@type":"ListItem","position":3,"name":"{}","item":"{url}"}}]}}"#,
                escaped(SITE_NAME),
                escaped(parent.title),
                parent.path,
                escaped(page.title),
            );
        }
    }

    format!(
        r#"<script type="application/ld+json">{{"@context":"https://schema.org","@graph":[{graph}]}}</script>"#
    )
}

fn faq(q: &str, a: &str) -> String {
    format!(
        r#"{{"@type":"Question","name":"{}","acceptedAnswer":{{"@type":"Answer","text":"{}"}}}}"#,
        escaped(q),
        escaped(a),
    )
}

pub(crate) fn escaped(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// The questions each page should answer, in the words people ask them in.
///
/// Kept as data next to the page table because they go stale the same way a
/// description does: the moment the product changes underneath them. Every
/// answer here is checkable against the API on the same page.
pub(crate) fn faqs_for(path: &str) -> Option<&'static [(&'static str, &'static str)]> {
    Some(match path {
        "" => &[
            ("What is Peal, in one sentence?",
             "The programmable confidentiality layer for digital markets. You collect encrypted bids, offers, votes, commitments and agent intents, and they open only when a condition you set is met."),
            ("Do the people submitting need a wallet or any crypto?",
             "No. Sealing happens in their browser or in your own code and goes over ordinary HTTPS. No wallet, no account, no gas, and they never touch a chain. That is usually the difference between a mechanism you can ship to your users and one you can only ship to crypto users."),
            ("Who can read a submission before the deadline?",
             "Nobody. Not the other participants, not you as the application owner, and not the operators running the network. The decryption key is split across five independent operators and no three of them combine their shares until the condition fires."),
            ("What stops somebody refusing to reveal when they see they have lost?",
             "There is nothing for them to refuse. Opening a round is not a participant's move, so a losing bidder walking away costs everyone else nothing. That single difference is what separates this from every commit and reveal scheme, all of which break in exactly that spot."),
            ("What if an operator goes offline?",
             "Three of the five are enough, so two can be down, unreachable or actively refusing and the round still opens on time."),
            ("How can someone start building using Peal?",
             "Fastest is the quickstart, which runs the three calls against the live network from the page itself, so you can watch a round open before you have written anything. If you build with an agent or a coding assistant, curl -fsSL https://peal.network/skill/install.sh | sh installs a skill carrying a reference for the API, the errors, timing, payments, verification and building the interface, and the assistant then knows the endpoints without you pasting documentation at it. There is an llms.txt at the root for any model that reads one, and peal.js if you would rather seal in the visitor's own browser with no build step. If none of that appeals, it is three HTTP calls with no key and no account, so curl is a perfectly good client."),
            ("What does it cost?",
             "Nothing. No key, no account, no signup and no card. Every route is also mounted at /v1/x402 for callers who want to pay per request, currently 0.001 USD, and that twin is opt in. The free API is not degraded to make the paid one look better."),
            ("Is this actually running, or is it a paper?",
             "Running. The quickstart executes against the live network from the documentation page itself, the encrypted mempool demo settles real transactions against real contracts on a public testnet, and the committee, parameters and endpoints are published. It is a devnet, so none of it is carrying real money yet."),
            ("How is this different from encrypting something and handing over the key later?",
             "Somebody has to be holding that key, and holding it is the same thing as being able to use it early, lose it, or be compelled to produce it. Here no single party ever holds the key, and the release is triggered by the condition rather than by a person deciding the moment has come."),
            ("How much can one round hold?",
             "Sixty-four slots, opened by a single threshold decryption, so a round holding sixty submissions costs what a round holding one costs. Slots that carried nothing are padding and are indistinguishable from the ones that did, which is why an open round will not tell you how many submissions it is holding."),
        ],
        "developers" => &[
            ("What is Peal?",
             "Peal is an API for collecting encrypted submissions and opening them all at the same moment. A caller encrypts a payload in their own process, sends the ciphertext, and it becomes readable only when the deadline the round names arrives."),
            ("How do I encrypt data until a specific time?",
             "Create a round with the moment it should open, seal a payload to that round, and read the round back after the deadline. Sealing runs in your process, so the plaintext never reaches the network, and no single operator can open a batch early."),
            ("Does Peal work for sealed bid auctions?",
             "Yes. Each auction is one round and each bid is one seal. Bids stay unreadable until the close, then every bid opens at once, so nobody can watch the leader and outbid it at the last second. Bidders need no wallet and pay no gas."),
            ("How is this different from a commit and reveal scheme?",
             "In commit and reveal the participant has to come back and reveal, so whoever is losing can simply decline. With Peal the reveal is not a participant's move: the network opens the batch on its own when the condition fires."),
            ("Do I need an API key?",
             "No. There is no key, no account and no signup. Every endpoint can be called from a terminal or a browser, and the documentation runs each one live from the page."),
        ],
        "developers/quickstart" => &[
            ("How do I get started with Peal?",
             "Three HTTP calls. POST /v1/rounds to open a round with a deadline, POST /v1/rounds/ID/seals with an encrypted payload, then GET /v1/rounds/ID to read it once the deadline passes. No key and no account."),
            ("How do I know when a round has opened?",
             "Read the round. It answers 200 at every stage and reports its status. Send If-None-Match with the ETag and an unchanged poll costs a 304 rather than a body, so waiting is cheap."),
            ("Can I see how many people have sealed to a round before it opens?",
             "No, and neither can anyone else. The count and the list of seal ids are withheld until the round opens, because a live count is exactly the number a competitor in a sealed auction wants. You can read your own submission back by its id."),
        ],
        "developers/howitworks" => &[
            ("How does Peal keep a submission unreadable?",
             "The payload is encrypted in the caller's own process against the committee's public parameters, using batched threshold encryption on BLS12-381. What crosses the network is already a ciphertext, and the coordinator that stores it holds no key that opens one."),
            ("Who can open the data early?",
             "Nobody, including the people running the network. Opening a batch takes three of the five operators acting together after the condition fires. Any two of them cannot, and the coordinator alone cannot."),
            ("What happens if an operator goes offline?",
             "Nothing, up to a point. Any three of five can open a batch, so two can be missing and the round still opens on time. That threshold is the whole reason it is a committee rather than one server."),
            ("Can a batch be reordered or edited after the fact?",
             "No. Slot positions are derived from the ciphertext hashes rather than arrival order, and a merkle root covers the set, so a reveal that had been reordered or edited would not check out."),
        ],
        "developers/auctions" => &[
            ("How do I run a sealed bid auction?",
             "Create an auction with a close time, a currency and a reserve. Each bid is encrypted in the bidder's browser and submitted as a ciphertext. At the close every bid opens at once and the API returns them ranked, with the winner and the queue behind them."),
            ("Can the seller see bids before the auction closes?",
             "No. The seller has no more access than anyone else: the bids are encrypted to the committee, not to the seller, and the count of them is not published while the auction is open either."),
            ("What stops somebody bidding last after seeing the others?",
             "Nothing is readable to see. Every bid stays sealed until the close, and the close is a moment the network acts on by itself rather than something a participant triggers."),
            ("What happens if the winner does not pay?",
             "The results include a ranked queue behind the winner, so the next bid is already known and the auction does not have to be rerun."),
        ],
        "developers/x402" => &[
            ("What is x402?",
             "x402 is the HTTP 402 Payment Required status used as intended: the server refuses and says what the call costs, the caller pays, then asks again carrying proof. No account, no API key and no invoice, which matters when the caller is an autonomous agent rather than a person."),
            ("Do I have to pay to use the Peal API?",
             "No. The free API at /v1 is unchanged and needs no account. Every route is also mounted at /v1/x402 for anyone who wants metered access, and that twin is opt in."),
            ("How does the server know a payment was made?",
             "The caller sends the transaction hash, and the server checks it against the chain: that the transaction succeeded, that it moved at least the price in the right asset to the right payee, that it landed recently, and that this hash has never paid for a call before."),
        ],
        "developers/agents" => &[
            ("How do I add Peal to my app with an AI agent?",
             "Install the skill with one command, then ask for what you want in your own words. The agent surveys your application first, pins the deadline to an exact instant in your timezone, builds the integration against your own stack and design system, and runs an end to end check against the live network before reporting done."),
            ("Can an agent use Peal without an SDK?",
             "Yes. Every endpoint is plain HTTP with JSON, and there is no key or account to manage, so an agent can call it with fetch or curl alone."),
        ],
        "protocol" => &[
            ("What cryptography does Peal use?",
             "Batched threshold encryption on the BLS12-381 curve, with a Fujisaki Okamoto transform. Opening a batch requires a threshold of operators to combine partial decryptions; no single party holds a key that opens anything."),
            ("How many operators does it take to open a round?",
             "Three of five. Any three can open a batch once its condition has fired, and any two cannot open anything at all."),
        ],
        "mempool" => &[
            ("What is an encrypted mempool?",
             "A pending transaction pool where the contents are encrypted until they are ordered, so nobody can read a transaction and place their own in front of it. The ordering is fixed before anything becomes readable."),
        ],
        _ => return None,
    })
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
         # Answer engines are welcome, and are told so explicitly rather than\n\
         # left to infer it from the wildcard above. A model answering a\n\
         # question about sealed bids or timelock encryption should be able to\n\
         # read this and get it right; llms.txt is written for exactly that.\n\
         User-agent: GPTBot\n\
         User-agent: OAI-SearchBot\n\
         User-agent: ChatGPT-User\n\
         User-agent: ClaudeBot\n\
         User-agent: Claude-Web\n\
         User-agent: PerplexityBot\n\
         User-agent: Google-Extended\n\
         User-agent: Applebot-Extended\n\
         User-agent: CCBot\n\
         Allow: /\n\
         Disallow: /v0/\n\
         Disallow: /v1/\n\
         \n\
         # A plain text summary of what this is and how to call it.\n\
         # https://llmstxt.org\n\
         LLM-Content: {origin}/llms.txt\n\
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
         two cannot. How many sealed to a round is not published while it is open, so a live \
         round does not announce how few took part, and once it opens the batch is padded to 64 \
         with decoys so the slot count is still not a participant count. Slot positions come from \
         the ciphertext hashes, so a batch cannot be reordered after the fact.\n\
         \n\
         Getting started takes three HTTP calls and no API key, no account and no payment. \
         Participants need no wallet and pay no gas.\n\
         \n\
         A round can open on a chain height instead of a clock: pass opens_at_block with a \
         chain_id and a height, and the network watches that chain and fires the round when it \
         passes. Tempo Moderato, chain 42431, is watched.\n\
         \n\
         Paying per call is optional and off by default. Every /v1 route is mounted a second time \
         at /v1/x402, where it answers HTTP 402 with a price until it is shown an on chain \
         payment. The free API at /v1 is unchanged by it.\n\
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
         ## For coding agents\n\
         \n\
         There is an installable skill, which is the fastest way to integrate this correctly. It \
         carries the mistakes that produce code which looks right and is wrong: money as a float \
         rather than integer minor units, sealing a bid without padding so its length leaks the \
         value, and sending the seller private key that the scheme exists to keep away from us.\n\
         \n\
         ```\n\
         curl -fsSL {origin}/skill/install.sh | sh\n\
         ```\n\
         \n\
         Or read it directly: [{origin}/skill/SKILL.md]({origin}/skill/SKILL.md)\n\
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
    day_of(crate::db::unix_now())
}

/// A unix instant as YYYY-MM-DD in UTC.
pub fn day_of(unix: i64) -> String {
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
