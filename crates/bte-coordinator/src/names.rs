//! Link previews for named auctions.
//!
//! WHY THIS LIVES ON THE SERVER AND ALMOST NOTHING ELSE DOES.
//!
//! A Peal Live link normally carries the whole auction in its URL fragment,
//! which browsers never send anywhere. That is a deliberate property and it
//! costs exactly one thing: a chat client asking for a preview sends only the
//! path, so there is nothing for a server to preview. Those links unfurl as the
//! plain site card and there is no way around it short of giving up the
//! property.
//!
//! A SHORT link is different. `peal.network/shoonya` is a path, the name is
//! public on chain, and the request already reaches us today because Caddy has
//! to serve the app shell for it. So a preview for a named auction leaks
//! nothing that the request did not already leak, and only named auctions get
//! one.
//!
//! WHAT IS SERVED. The same `index.html` the static edge would have served,
//! with the auction's own name, description and picture written into its meta
//! tags. The app boots exactly as before; a crawler that runs no JavaScript now
//! has something true to show.
//!
//! CACHING IS FREE HERE. `PealNames.claim` is permanent and a name can never be
//! repointed, so a hit is cached for the life of the process without any
//! staleness question to reason about. A miss is cached briefly, because an
//! unclaimed name can be claimed a minute later.

use std::collections::HashMap;
use std::sync::Mutex;

use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::json;
use sha3::{Digest, Keccak256};
use tracing::warn;

use crate::state::App;

/// Tempo Moderato, where PealNames is deployed.
pub(crate) const TEMPO_CHAIN_ID: i64 = 42431;
pub(crate) const TEMPO_RPC_FALLBACK: &str = "https://rpc.moderato.tempo.xyz";
/// The registry. Immutable, and the address IS the namespace: pointing this at
/// a different deployment does not migrate names, it reads an empty registry.
pub(crate) const PEAL_NAMES: &str = "0x98D1a8b4d8C5d36D5D9a357F7fccE17cB0F63D2f";

/// A miss is only cached this long, because an unclaimed name is not a
/// permanent answer the way a claimed one is.
const MISS_TTL_MS: i64 = 60_000;

/// The parts of an auction's terms a preview needs. Everything else in the
/// terms is the auction's business and none of a chat client's.
#[derive(Clone, Debug, PartialEq)]
pub struct Preview {
    pub title: String,
    pub description: Option<String>,
    pub image: Option<String>,
}

#[derive(Default)]
pub struct PreviewCache {
    entries: Mutex<HashMap<String, (Option<Preview>, i64)>>,
}

impl PreviewCache {
    fn get(&self, name: &str, now: i64) -> Option<Option<Preview>> {
        let entries = self.entries.lock().unwrap();
        match entries.get(name) {
            // A claim is permanent, so a hit never needs re-checking.
            Some((Some(p), _)) => Some(Some(p.clone())),
            Some((None, at)) if now - at < MISS_TTL_MS => Some(None),
            _ => None,
        }
    }

    fn put(&self, name: &str, value: Option<Preview>, now: i64) {
        let mut entries = self.entries.lock().unwrap();
        // Bounded so a flood of made-up names cannot grow it without limit.
        // Misses are the only churn; hits are permanent and few.
        if entries.len() > 10_000 {
            entries.retain(|_, (v, _)| v.is_some());
        }
        entries.insert(name.to_string(), (value, now));
    }
}

/// Serve the app shell for `/{name}`, with the auction's own preview in it.
///
/// Every failure path serves the ordinary shell. A preview is a nicety; the
/// auction opening is not, so nothing here may turn a slow RPC or a bad name
/// into a page that does not load.
pub async fn named_shell(
    State(app): State<App>,
    Path(name): Path<String>,
    headers: axum::http::HeaderMap,
) -> Response {
    let shell = match read_shell() {
        Some(s) => s,
        None => return (StatusCode::NOT_FOUND, "explorer shell not found").into_response(),
    };

    let canonical = canonical_url(&headers, &name);

    // A page path wins over a name lookup. See pages.rs for why that precedence
    // is the right one and what it costs.
    if let Some(page) = crate::pages::find(&name) {
        let shell = read_prerendered(page.path).unwrap_or(shell);
        return page_response(&shell, page, canonical.as_deref());
    }

    let html = match preview_for(&app, &name).await {
        Some(p) => inject(&shell, &p, canonical.as_deref()),
        None => shell,
    };

    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            // Same reasoning as page_response: this shell names the bundle,
            // so holding it means running yesterday's code against today's
            // API. Names are permanent, so there is nothing else here worth
            // caching.
            (header::CACHE_CONTROL, "no-cache"),
        ],
        html,
    )
        .into_response()
}

/// A page at a path of any depth, for guides that live under a section.
///
/// The single-segment handler cannot serve these: it shares its shape with
/// auction short links, and /developers/createauction is not a name anybody
/// could claim.
pub async fn nested_page(Path(path): Path<String>, headers: axum::http::HeaderMap) -> Response {
    let Some(shell) = read_shell() else {
        return (StatusCode::NOT_FOUND, "explorer shell not found").into_response();
    };
    let Some(page) = crate::pages::find(&path) else {
        // Not a page we know. The shell still renders, and the app decides what
        // to show, which is what the static edge would have done anyway.
        return plain_shell();
    };
    let canonical = canonical_url(&headers, &path);
    let shell = read_prerendered(page.path).unwrap_or(shell);
    page_response(&shell, page, canonical.as_deref())
}

/// robots.txt, sitemap.xml and llms.txt, each with the content type a crawler
/// expects. Generated from the page table rather than kept as static files, so
/// adding a page cannot leave the sitemap behind.
pub async fn crawler_doc(Path(doc): Path<String>, headers: axum::http::HeaderMap) -> Response {
    let origin = canonical_url(&headers, "")
        .and_then(|c| c.rsplit_once('/').map(|(o, _)| o.to_string()))
        .unwrap_or_else(|| "https://peal.network".to_string());

    let (body, content_type) = match doc.as_str() {
        "robots.txt" => (crate::pages::robots(&origin), "text/plain; charset=utf-8"),
        "llms.txt" => (crate::pages::llms_txt(&origin), "text/plain; charset=utf-8"),
        "sitemap.xml" => {
            // Dated from the build, which is when the content last changed.
            let today = crate::pages::today();
            (
                crate::pages::sitemap(&origin, &today),
                "application/xml; charset=utf-8",
            )
        }
        _ => return (StatusCode::NOT_FOUND, "not found").into_response(),
    };

    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, content_type),
            (header::CACHE_CONTROL, "public, max-age=3600"),
        ],
        body,
    )
        .into_response()
}

/// The site root, which Caddy sends here so the home page gets its own title
/// and structured data rather than the shell's defaults.
pub async fn root_shell(headers: axum::http::HeaderMap) -> Response {
    let Some(shell) = read_shell() else {
        return (StatusCode::NOT_FOUND, "explorer shell not found").into_response();
    };
    let home = &crate::pages::PAGES[0];
    let canonical = canonical_url(&headers, "");
    page_response(&shell, home, canonical.as_deref())
}

/// One page, with its own title, description, canonical URL and structured
/// data written into the shell.
fn page_response(shell: &str, page: &crate::pages::Page, canonical: Option<&str>) -> Response {
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            // Revalidated every time, never held.
            //
            // The shell is the thing that names which hashed bundle to load, so
            // caching it for five minutes meant that for five minutes after a
            // deploy a browser would run the previous bundle against the new
            // API. That is exactly how the activity page ended up stuck on
            // "loading": old code read a field the new server had stopped
            // sending. The assets it points at are content hashed and can be
            // cached for ever; the pointer to them cannot.
            (header::CACHE_CONTROL, "no-cache"),
        ],
        page_html(shell, page, canonical),
    )
        .into_response()
}

/// The shell with this page's meta written into it. Split out from the response
/// so a test can read the html rather than reconstruct it.
fn page_html(shell: &str, page: &crate::pages::Page, canonical: Option<&str>) -> String {
    // The site origin, by removing this page's own path from its canonical URL.
    //
    // Splitting on the last slash instead looked right for a one segment path
    // and was wrong for every nested one: /developers/api yielded an origin of
    // https://peal.network/developers, so the structured data claimed the page
    // lived at /developers/developers/api, a URL that 404s and contradicts the
    // canonical tag beside it, and pointed isPartOf at a WebSite node that
    // does not exist.
    let origin = canonical
        .map(|c| {
            let trimmed = c.trim_end_matches('/');
            match trimmed
                .strip_suffix(page.path)
                .map(|o| o.trim_end_matches('/'))
            {
                Some(o) if !o.is_empty() => o.to_string(),
                _ => trimmed.to_string(),
            }
        })
        .unwrap_or_else(|| "https://peal.network".to_string());
    let url = canonical.map(str::to_owned).unwrap_or_else(|| {
        if page.path.is_empty() {
            origin.clone()
        } else {
            format!("{origin}/{}", page.path)
        }
    });

    // <title> and the plain description are what a search result shows. og: is
    // what a pasted link shows. They are allowed to differ, and on the docs
    // they do: see Page::share.
    let (card_title, card_desc) = page.share.unwrap_or((page.title, page.description));

    let mut html = replace_title(shell, &esc(page.title));
    html = replace_meta(&html, "description", &esc(page.description));
    html = replace_meta(&html, "og:title", &esc(card_title));
    html = replace_meta(&html, "og:description", &esc(card_desc));

    // A canonical and an og:url on every page. Without one, a page reachable at
    // both /developers and /developers/ is two documents competing with each
    // other for the same words.
    // A card only where the page table asks for one. The shell ships with a
    // twitter:card of "summary", so a page carrying an image has to be upgraded
    // to summary_large_image or the card renders as a thumbnail beside text
    // rather than the banner it was cropped to be.
    let card = match page.image {
        Some(path) => {
            let src = format!("{origin}{path}");
            html = html.replace(
                "<meta name=\"twitter:card\" content=\"summary\" />",
                "<meta name=\"twitter:card\" content=\"summary_large_image\" />",
            );
            format!(
                "<meta property=\"og:image\" content=\"{s}\" />\n    \
                 <meta property=\"og:image:width\" content=\"1200\" />\n    \
                 <meta property=\"og:image:height\" content=\"630\" />\n    \
                 <meta property=\"og:image:alt\" content=\"{t}\" />\n    \
                 <meta name=\"twitter:image\" content=\"{s}\" />\n    ",
                s = esc(&src),
                // The card's own title, not the document's: the alt describes
                // the image somebody is looking at, which is the card.
                t = esc(card_title),
            )
        }
        None => String::new(),
    };

    let head = format!(
        "<link rel=\"canonical\" href=\"{u}\" />\n    \
         <meta property=\"og:url\" content=\"{u}\" />\n    {card}{ld}\n    ",
        u = esc(&url),
        ld = crate::pages::json_ld(page, &origin),
    );
    html = match html.find("</head>") {
        Some(at) => format!("{}{head}{}", &html[..at], &html[at..]),
        None => html,
    };

    html
}

/// The app shell with no preview written into it: what every failure path here
/// serves, because the auction opening matters and the preview does not.
pub fn plain_shell() -> Response {
    match read_shell() {
        Some(html) => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
            html,
        )
            .into_response(),
        None => (StatusCode::NOT_FOUND, "explorer shell not found").into_response(),
    }
}

/// The address a person would type, not the one the rewrite produced.
///
/// Caddy proxies `/{name}` to `/link/{name}` internally, so the path this
/// handler sees is not the one anyone shares. Without og:url a crawler treats
/// whatever it fetched as canonical, and clients that key their preview cache
/// on it can end up holding the card under the wrong address.
pub(crate) fn canonical_url(headers: &axum::http::HeaderMap, name: &str) -> Option<String> {
    let host = headers.get(header::HOST).and_then(|v| v.to_str().ok())?;
    // Rejected rather than escaped: a Host header is client controlled, and the
    // only safe thing to build a canonical URL from is one that looks like a
    // hostname.
    if host.is_empty()
        || host.len() > 255
        || !host
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'-' | b':'))
    {
        return None;
    }
    // A public host is https; only a local one may be http.
    //
    // x-forwarded-proto is deliberately NOT trusted to downgrade a public host.
    // Railway terminates TLS at its edge and forwards the internal leg as
    // http, so taking that header at face value published every canonical URL
    // and every og:url as http://peal.network, declaring the insecure address
    // the authoritative one. The header only gets a say for a local host, where
    // it can legitimately be either.
    let local = host.starts_with("localhost") || host.starts_with("127.0.0.1");
    let scheme = if local {
        headers
            .get("x-forwarded-proto")
            .and_then(|v| v.to_str().ok())
            .filter(|s| *s == "http" || *s == "https")
            .unwrap_or("http")
    } else {
        "https"
    };
    Some(format!("{scheme}://{host}/{name}"))
}

/// Where the explorer's index.html lives; the prerendered pages sit beside it.
fn shell_path() -> String {
    std::env::var("BTE_EXPLORER_INDEX").unwrap_or_else(|_| "/srv/explorer/index.html".to_string())
}

/// The file the explorer build wrote for a page, if the build wrote one.
///
/// `packages/explorer/scripts/prerender-docs.mjs` renders every developer page
/// into `<dist>/<path>/index.html`: the shell with the article already inside
/// `<main>`, so a reader that runs no JavaScript, which is most agents and
/// every crawler, gets the words rather than a header and a script tag. When
/// that file exists it is the shell to write this page's meta into; when it
/// does not, the plain shell is what the app has always booted from.
fn prerendered_path(index: &str, page_path: &str) -> Option<std::path::PathBuf> {
    // Page paths come from the static table in pages.rs, never from a request,
    // so this is belt and braces rather than a defence. Still: a path with a
    // parent segment or an absolute root would leave the explorer directory.
    if page_path.is_empty()
        || page_path.starts_with('/')
        || page_path
            .split('/')
            .any(|seg| seg.is_empty() || seg == "." || seg == "..")
    {
        return None;
    }
    let dir = std::path::Path::new(index).parent()?;
    Some(dir.join(page_path).join("index.html"))
}

fn read_prerendered(page_path: &str) -> Option<String> {
    let path = prerendered_path(&shell_path(), page_path)?;
    std::fs::read_to_string(path).ok()
}

fn read_shell() -> Option<String> {
    let path = shell_path();
    match std::fs::read_to_string(&path) {
        Ok(s) => Some(s),
        Err(e) => {
            warn!(path, error = %e, "cannot read the explorer shell");
            None
        }
    }
}

async fn preview_for(app: &App, name: &str) -> Option<Preview> {
    if !is_valid_name(name) {
        return None;
    }
    let now = crate::db::now_ms();
    if let Some(cached) = app.0.previews.get(name, now) {
        return cached;
    }

    let url = app
        .0
        .cfg
        .rpc_urls
        .get(&TEMPO_CHAIN_ID)
        .cloned()
        .unwrap_or_else(|| TEMPO_RPC_FALLBACK.to_string());

    let found = match resolve(&app.0.http, &url, name).await {
        Ok(bytes) => bytes.and_then(|b| decode_terms(&b)),
        Err(e) => {
            // Not cached: an RPC that was down for one request should not make
            // the next minute of previews wrong.
            warn!(name, error = %e, "could not resolve a name for its preview");
            return None;
        }
    };
    app.0.previews.put(name, found.clone(), now);
    found
}

/// The same rule the contract enforces, so a name it would reject never becomes
/// an RPC call.
pub(crate) fn is_valid_name(name: &str) -> bool {
    let b = name.as_bytes();
    if b.len() < 3 || b.len() > 32 || b[0] == b'-' || b[b.len() - 1] == b'-' {
        return false;
    }
    b.iter()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

/// `PealNames.resolve(name)`, as an `eth_call`. Empty bytes means unclaimed,
/// which the contract returns rather than reverting.
pub(crate) async fn resolve(
    http: &reqwest::Client,
    rpc_url: &str,
    name: &str,
) -> anyhow::Result<Option<Vec<u8>>> {
    let mut data = Keccak256::digest(b"resolve(string)")[..4].to_vec();
    // One dynamic argument: the offset to it, its length, then its bytes padded
    // to a 32 byte boundary.
    data.extend_from_slice(&u256(32));
    data.extend_from_slice(&u256(name.len() as u64));
    let mut arg = name.as_bytes().to_vec();
    arg.resize(name.len().div_ceil(32) * 32, 0);
    data.extend_from_slice(&arg);

    let res: serde_json::Value = http
        .post(rpc_url)
        .json(&json!({
            "jsonrpc": "2.0", "id": 1, "method": "eth_call",
            "params": [{ "to": PEAL_NAMES, "data": format!("0x{}", hex::encode(&data)) }, "latest"],
        }))
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await?
        .json()
        .await?;

    let raw = res
        .get("result")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("eth_call returned no result"))?;
    let bytes = hex::decode(raw.trim_start_matches("0x"))?;

    // A dynamic `bytes` return: offset, length, then the payload.
    if bytes.len() < 64 {
        return Ok(None);
    }
    let len = u64::from_be_bytes(bytes[56..64].try_into().unwrap()) as usize;
    if len == 0 || 64 + len > bytes.len() {
        return Ok(None);
    }
    Ok(Some(bytes[64..64 + len].to_vec()))
}

fn u256(n: u64) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[24..].copy_from_slice(&n.to_be_bytes());
    out
}

/// Read a registry entry in any shape it has ever been stored in.
///
/// Deliberately mirrors `fromRegistryBytes` in packages/live: a leading 1 means
/// the canonical bytes were deflated, otherwise they are the canonical bytes
/// themselves, and the oldest entries hold the base64 TEXT of those. This is
/// the only duplicated logic in the feature, and it is duplicated because the
/// alternative is asking a browser for a preview a crawler is asking us for.
fn decode_terms(bytes: &[u8]) -> Option<Preview> {
    if bytes.first() == Some(&1) {
        if let Some(raw) = inflate(&bytes[1..]) {
            if let Some(p) = from_canonical(&raw) {
                return Some(p);
            }
        }
    }
    if let Some(p) = from_canonical(bytes) {
        return Some(p);
    }
    // Base64 text of the canonical bytes.
    let text = std::str::from_utf8(bytes).ok()?;
    let decoded = b64url(text)?;
    from_canonical(&decoded)
}

fn inflate(bytes: &[u8]) -> Option<Vec<u8>> {
    use flate2::read::DeflateDecoder;
    use std::io::Read;
    let mut out = Vec::new();
    // Bounded: a registry entry is at most 512 bytes and the terms it holds are
    // bounded by the caps in packTerms, so anything claiming to inflate to
    // megabytes is hostile rather than an auction.
    DeflateDecoder::new(bytes)
        .take(64 * 1024)
        .read_to_end(&mut out)
        .ok()?;
    Some(out)
}

fn b64url(text: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(text.trim_end_matches('='))
        .ok()
}

/// The canonical terms are a positional JSON tuple. Index 2 is the item name,
/// 8 the picture and 9 the description; see `canonicalTerms` in
/// packages/live/src/terms.ts, which writes them.
fn from_canonical(bytes: &[u8]) -> Option<Preview> {
    let wire: Vec<serde_json::Value> = serde_json::from_slice(bytes).ok()?;
    if wire.len() < 10 {
        return None;
    }
    let text = |i: usize| -> Option<String> {
        wire.get(i)
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    };
    Some(Preview {
        title: text(2)?,
        image: text(8).filter(|s| s.starts_with("https://")),
        description: text(9),
    })
}

/// Write the preview into the shell.
///
/// Every value here was written by a stranger who claimed a name, so all of it
/// is escaped before it goes anywhere near an attribute. The picture is also
/// held to https, the same rule the auction page applies, so a claim cannot
/// point a preview at an http or javascript URL.
fn inject(shell: &str, p: &Preview, canonical: Option<&str>) -> String {
    let title = esc(&p.title);
    let description = p
        .description
        .as_deref()
        .map(esc)
        .unwrap_or_else(|| "A sealed bid auction on Peal. Every bid stays encrypted until it closes, then they all open at once.".to_string());

    let mut html = shell.to_string();
    html = replace_title(&html, &title);
    html = replace_meta(&html, "og:title", &title);
    html = replace_meta(&html, "og:description", &description);
    html = replace_meta(&html, "description", &description);

    let mut extra = String::new();
    if let Some(url) = canonical {
        extra.push_str(&format!(
            "<meta property=\"og:url\" content=\"{}\" />\n    ",
            esc(url)
        ));
    }
    if !extra.is_empty() {
        html = match html.find("</head>") {
            Some(at) => format!("{}{extra}{}", &html[..at], &html[at..]),
            None => html,
        };
    }

    if let Some(image) = &p.image {
        let image = esc(image);
        let tags = format!(
            "<meta property=\"og:image\" content=\"{image}\" />\n    \
             <meta property=\"og:image:alt\" content=\"{title}\" />\n    \
             <meta name=\"twitter:image\" content=\"{image}\" />\n    "
        );
        // summary_large_image only when there IS an image; the card degrades
        // badly if it promises one and none loads.
        html = html.replace(
            "<meta name=\"twitter:card\" content=\"summary\" />",
            "<meta name=\"twitter:card\" content=\"summary_large_image\" />",
        );
        html = match html.find("</head>") {
            Some(at) => format!("{}{tags}{}", &html[..at], &html[at..]),
            None => html,
        };
    }
    html
}

fn replace_title(html: &str, title: &str) -> String {
    let (Some(open), Some(close)) = (html.find("<title>"), html.find("</title>")) else {
        return html.to_string();
    };
    if close < open {
        return html.to_string();
    }
    format!("{}<title>{title}{}", &html[..open], &html[close..])
}

/// Replace one meta tag's content, found by its property rather than by the
/// exact line, so editing the copy in index.html cannot silently stop this
/// working.
fn replace_meta(html: &str, key: &str, content: &str) -> String {
    for attr in [
        format!("property=\"{key}\" content=\""),
        format!("name=\"{key}\" content=\""),
    ] {
        if let Some(at) = html.find(&attr) {
            let from = at + attr.len();
            if let Some(end) = html[from..].find('"') {
                return format!("{}{content}{}", &html[..from], &html[from + end..]);
            }
        }
    }
    html.to_string()
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prerendered_pages_sit_beside_the_shell_and_never_above_it() {
        let at = |p: &str| prerendered_path("/srv/explorer/index.html", p);
        assert_eq!(
            at("developers/quickstart"),
            Some(std::path::PathBuf::from(
                "/srv/explorer/developers/quickstart/index.html"
            ))
        );
        assert_eq!(
            at("developers"),
            Some(std::path::PathBuf::from(
                "/srv/explorer/developers/index.html"
            ))
        );
        // The home page has no directory of its own; it is the shell.
        assert_eq!(at(""), None);
        assert_eq!(at("../etc"), None);
        assert_eq!(at("/etc"), None);
        assert_eq!(at("developers//api"), None);
    }

    fn inject_for_test(shell: &str, p: &Preview) -> String {
        inject(shell, p, Some("https://peal.network/nepal"))
    }

    const SHELL: &str = r#"<!doctype html><html><head>
    <title>Peal Network. Sealed now, opened at the time you set.</title>
    <meta name="description" content="old" />
    <meta property="og:title" content="old" />
    <meta property="og:description" content="old" />
    <meta name="twitter:card" content="summary" />
    </head><body></body></html>"#;

    /// The three shapes a registry entry has ever had, all read by the same
    /// function, because names claimed under any of them are permanent.
    #[test]
    fn reads_every_stored_shape() {
        let canonical = br#"[5,"cond_1","Nepal Relief","USD",2,1788000000,null,null,"https://e.com/a.jpg","seven spots",null]"#;
        let want = Preview {
            title: "Nepal Relief".into(),
            description: Some("seven spots".into()),
            image: Some("https://e.com/a.jpg".into()),
        };

        // Uncompressed canonical bytes.
        assert_eq!(decode_terms(canonical).as_ref(), Some(&want));

        // Deflated, with the format byte in front: what is stored now.
        use flate2::write::DeflateEncoder;
        use std::io::Write;
        let mut enc = DeflateEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all(canonical).unwrap();
        let mut deflated = vec![1u8];
        deflated.extend(enc.finish().unwrap());
        assert_eq!(decode_terms(&deflated).as_ref(), Some(&want));

        // The oldest shape: the base64url TEXT of the canonical bytes.
        use base64::Engine;
        let text = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(canonical);
        assert_eq!(decode_terms(text.as_bytes()).as_ref(), Some(&want));
    }

    #[test]
    fn refuses_junk_rather_than_previewing_it() {
        for bytes in [
            b"".as_slice(),
            b"not terms",
            &[1, 2, 3, 4],
            // Valid JSON, wrong shape: too few fields to be terms.
            br#"[5,"cond_1","title"]"#,
            // A tuple with no title is not an auction anyone can show.
            br#"[5,"cond_1","","USD",2,1,null,null,null,null,null]"#,
        ] {
            assert_eq!(decode_terms(bytes), None, "accepted {bytes:?}");
        }
    }

    /// A picture address comes out of a link a stranger claimed. http, or
    /// worse a javascript: URL, must never reach the page.
    #[test]
    fn only_https_pictures_are_shown() {
        let with = |img: &str| {
            let json = format!(
                r#"[5,"cond_1","t","USD",2,1,null,null,{},"d",null]"#,
                serde_json::to_string(img).unwrap()
            );
            decode_terms(json.as_bytes()).unwrap().image
        };
        assert_eq!(
            with("https://e.com/a.jpg"),
            Some("https://e.com/a.jpg".into())
        );
        assert_eq!(with("http://e.com/a.jpg"), None);
        assert_eq!(with("javascript:alert(1)"), None);
        assert_eq!(with("data:image/png;base64,AAAA"), None);
    }

    /// Everything injected was written by whoever claimed the name, so it is
    /// escaped before it goes into an attribute. A title that closes the tag
    /// and opens a script must come out as text.
    #[test]
    fn escapes_what_a_stranger_wrote() {
        let html = inject_for_test(
            SHELL,
            &Preview {
                title: r#""><script>alert(1)</script>"#.into(),
                description: Some("a & b < c".into()),
                image: Some(r#"https://e.com/a.jpg" onerror="alert(1)"#.into()),
            },
        );
        assert!(
            !html.contains("<script>alert(1)"),
            "script survived: {html}"
        );
        assert!(!html.contains(r#"onerror="alert(1)"#));
        assert!(html.contains("&quot;&gt;&lt;script&gt;"));
        assert!(html.contains("a &amp; b &lt; c"));
    }

    #[test]
    fn nested_pages_keep_the_site_origin() {
        // A nested page must describe itself with the same origin as the home
        // page, or its structured data claims a URL that does not exist and
        // joins a website node nobody else is in.
        let nested = crate::pages::PAGES
            .iter()
            .find(|p| p.path == "developers/api")
            .expect("developers/api page");
        let html = page_html(SHELL, nested, Some("https://peal.network/developers/api"));
        assert!(
            html.contains(r#""url":"https://peal.network/developers/api""#),
            "structured data must name the real url"
        );
        assert!(
            !html.contains("developers/developers"),
            "origin leaked a path segment"
        );
        assert!(html.contains(r#""@id":"https://peal.network#website""#));
        assert!(html.contains(
            r#"<meta property="og:image" content="https://peal.network/developers.jpg""#
        ));
    }

    #[test]
    fn the_docs_card_reads_differently_from_the_title() {
        let dev = crate::pages::PAGES
            .iter()
            .find(|p| p.path == "developers")
            .expect("developers page");
        let html = page_html(SHELL, dev, Some("https://peal.network/developers"));

        // The card says what this is.
        assert!(html
            .contains(r#"property="og:title" content="The privacy layer for onchain markets.""#));
        assert!(html.contains(r#"property="og:description" content="One API to collect"#));

        // The document title stays its own, so it does not compete with the
        // home page, which already carries that same sentence.
        assert!(
            html.contains("<title>Peal API."),
            "the <title> must stay distinct"
        );
        let home = crate::pages::PAGES
            .iter()
            .find(|p| p.path.is_empty())
            .unwrap();
        assert_ne!(dev.title, home.title, "two pages must not share a title");
    }

    #[test]
    fn developer_pages_carry_a_card_and_other_pages_do_not() {
        // The card is the exception, not the default. A regression here would
        // put branding on every shared link, which is very hard to withdraw
        // once the links are out.
        let dev = crate::pages::PAGES
            .iter()
            .find(|p| p.path == "developers")
            .expect("developers page");
        let html = page_html(SHELL, dev, Some("https://peal.network/developers"));
        assert!(
            html.contains(r#"property="og:image" content="https://peal.network/developers.jpg""#)
        );
        assert!(html.contains(r#"content="summary_large_image""#));
        assert!(!html.contains(r#"content="summary" "#));

        let home = crate::pages::PAGES
            .iter()
            .find(|p| p.path.is_empty())
            .expect("home page");
        let plain = page_html(SHELL, home, Some("https://peal.network"));
        assert!(
            !plain.contains("og:image"),
            "the home page must stay imageless"
        );
        assert!(plain.contains(r#"content="summary""#));
    }

    /// The landing's FAQ markup has to describe the landing's FAQ section.
    ///
    /// The questions are written twice on purpose: once in `faqs_for("")` here,
    /// which becomes the FAQPage structured data, and once in the `Faq` section
    /// of packages/explorer/src/pages/landing.tsx, which is what a person
    /// actually sees. Structured data is only allowed to describe content that
    /// is on the page, so an edit to one side without the other turns this
    /// markup into a claim about a page nobody is being served. Reading the TSX
    /// is the only way to notice that from here.
    #[test]
    fn the_landing_faq_markup_matches_the_landing() {
        const LANDING_TSX: &str = include_str!("../../../packages/explorer/src/pages/landing.tsx");

        let home = crate::pages::PAGES
            .iter()
            .find(|p| p.path.is_empty())
            .expect("home page");
        let html = page_html(SHELL, home, Some("https://peal.network"));
        assert!(html.contains("FAQPage"), "the landing must emit FAQPage");

        let faqs = crate::pages::faqs_for("").expect("the landing has FAQs");
        assert!(
            faqs.len() >= 8,
            "a landing FAQ of {} is too thin",
            faqs.len()
        );

        for (question, answer) in faqs {
            assert!(
                html.contains(&crate::pages::escaped(question)),
                "question missing from the markup: {question}"
            );
            assert!(
                LANDING_TSX.contains(question),
                "the markup asks a question the landing does not: {question}"
            );
            // The answers are wrapped across lines by the formatter in the TSX,
            // so a whole-string match would fail on whitespace alone. The first
            // clause is enough to catch an answer that was rewritten on one side.
            let opening: String = answer
                .split(&['.', ','][..])
                .next()
                .unwrap_or(answer)
                .into();
            assert!(
                LANDING_TSX.contains(opening.trim()),
                "the markup answers differently from the landing: {opening}"
            );
        }
    }

    /// A seal's share key must never reach a calendar.
    ///
    /// A private seal link is `#/s/<id>/<hash>/<key>`, and the key is the only
    /// thing that decrypts the payload. It rides in the FRAGMENT precisely
    /// because a fragment is never sent to a server, a promise this product
    /// makes in the auction docs and in the skill. The two calendar buttons on
    /// the seal page were the one place it was broken: `gcalUrl` puts its
    /// argument in a query parameter on calendar.google.com, and the .ics from
    /// `icsHref` is written into whatever calendar the reader syncs.
    ///
    /// Nothing in Rust can observe that, and the explorer has no test runner in
    /// CI, so this reads the two files. It is a coarse check for one specific
    /// regression: writing the caller's raw url into the event body again.
    #[test]
    fn the_calendar_helpers_never_write_down_a_share_key() {
        const ATTENTION_TS: &str = include_str!("../../../packages/explorer/src/attention.ts");
        const SEAL_VIEW_TS: &str =
            include_str!("../../../packages/explorer/src/pages/seal-view.ts");

        // The stripper exists and both helpers accept the key so they can drop it.
        assert!(
            ATTENTION_TS.contains("export function withoutShareKey("),
            "withoutShareKey is gone; the calendar helpers have nothing to strip with"
        );
        assert_eq!(
            ATTENTION_TS.matches("shareKey?: string;").count(),
            2,
            "icsHref and gcalUrl must each take the share key, so each can drop it"
        );

        // The regression itself: the raw url interpolated into the event body.
        // Both helpers must read through withoutShareKey instead.
        for leak in ["${opts.url}", "opts.url}`,"] {
            assert!(
                !ATTENTION_TS.contains(leak),
                "a calendar helper writes the caller's url verbatim ({leak}); \
                 it must go through withoutShareKey"
            );
        }
        assert_eq!(
            ATTENTION_TS
                .matches("withoutShareKey(opts.url, opts.shareKey)")
                .count(),
            2,
            "both calendar helpers must strip the key before writing the link"
        );

        // And the seal page has to hand the key over for that to do anything.
        for call in [
            "icsHref({ conditionId, firesAt, url, shareKey })",
            "gcalUrl({ firesAt, url, shareKey })",
        ] {
            assert!(
                SEAL_VIEW_TS.contains(call),
                "the seal page stopped passing shareKey: {call}"
            );
        }
    }

    #[test]
    fn writes_the_auction_into_the_shell() {
        let html = inject_for_test(
            SHELL,
            &Preview {
                title: "Nepal Relief".into(),
                description: Some("seven spots".into()),
                image: Some("https://e.com/a.jpg".into()),
            },
        );
        assert!(html.contains("<title>Nepal Relief</title>"));
        assert!(html.contains(r#"property="og:title" content="Nepal Relief""#));
        assert!(html.contains(r#"property="og:description" content="seven spots""#));
        assert!(html.contains(r#"name="description" content="seven spots""#));
        assert!(html.contains(r#"property="og:image" content="https://e.com/a.jpg""#));
        assert!(html.contains(r#"content="summary_large_image""#));
        // The default copy must be gone, not merely joined by a second tag: a
        // crawler picking the first of two would show the wrong one.
        assert_eq!(html.matches("og:title").count(), 1);
        assert!(!html.contains(r#"content="old""#));
    }

    /// An auction with no picture keeps the small card. Promising a large image
    /// and delivering none is a worse preview than not promising one.
    #[test]
    fn no_picture_means_no_image_card() {
        let html = inject_for_test(
            SHELL,
            &Preview {
                title: "t".into(),
                description: None,
                image: None,
            },
        );
        assert!(!html.contains("og:image"));
        assert!(html.contains(r#"content="summary""#));
        // A missing description still says something true about the auction.
        assert!(html.contains("stays encrypted until it closes"));
    }

    /// The same rule PealNames enforces, applied before any RPC call, so junk
    /// names cost a string check rather than a round trip to the chain.
    #[test]
    fn only_names_the_contract_would_accept() {
        for ok in ["shoonya", "abc", "a-b-c", "a1", "x".repeat(32).as_str()] {
            if ok.len() >= 3 {
                assert!(is_valid_name(ok), "rejected {ok}");
            }
        }
        for bad in [
            "ab",
            "-abc",
            "abc-",
            "ABC",
            "a b",
            "a_b",
            &"x".repeat(33),
            "café",
        ] {
            assert!(!is_valid_name(bad), "accepted {bad}");
        }
    }

    /// The address a person shares, not the internal one the rewrite produced.
    #[test]
    fn names_the_url_a_person_would_type() {
        let head = |pairs: &[(&str, &str)]| {
            let mut h = axum::http::HeaderMap::new();
            for (k, v) in pairs {
                h.insert(
                    axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                    v.parse().unwrap(),
                );
            }
            h
        };

        assert_eq!(
            canonical_url(&head(&[("host", "peal.network")]), "nepal").as_deref(),
            Some("https://peal.network/nepal"),
        );
        // Local development is http, and says so.
        assert_eq!(
            canonical_url(&head(&[("host", "localhost:9911")]), "nepal").as_deref(),
            Some("http://localhost:9911/nepal"),
        );
        // A proxy reporting http for a public host is describing its own
        // internal leg, not what the visitor used. Trusting it published every
        // canonical URL as http://peal.network.
        assert_eq!(
            canonical_url(
                &head(&[("host", "peal.network"), ("x-forwarded-proto", "http")]),
                "n"
            )
            .as_deref(),
            Some("https://peal.network/n"),
        );

        // A Host header is written by whoever made the request. Anything that
        // is not shaped like a hostname produces no canonical URL at all,
        // rather than one with someone else's markup in it.
        assert_eq!(canonical_url(&head(&[]), "nepal"), None);
        for hostile in ["a\"><script>", "peal.network/evil", "peal network"] {
            let mut h = axum::http::HeaderMap::new();
            if let Ok(v) = hostile.parse() {
                h.insert(header::HOST, v);
                assert_eq!(canonical_url(&h, "nepal"), None, "accepted {hostile}");
            }
        }
    }

    /// A claim is permanent, so a hit never expires. A miss must, or a name
    /// claimed a minute from now would preview as nothing for the life of the
    /// process.
    #[test]
    fn caches_a_claim_forever_and_a_miss_briefly() {
        let cache = PreviewCache::default();
        let hit = Preview {
            title: "t".into(),
            description: None,
            image: None,
        };
        cache.put("taken", Some(hit.clone()), 0);
        cache.put("free", None, 0);

        assert_eq!(cache.get("taken", MISS_TTL_MS * 100), Some(Some(hit)));
        assert_eq!(cache.get("free", MISS_TTL_MS - 1), Some(None));
        assert_eq!(
            cache.get("free", MISS_TTL_MS + 1),
            None,
            "a miss must expire"
        );
        assert_eq!(cache.get("never-seen", 0), None);
    }
}
