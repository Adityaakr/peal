# Chrome Web Store listing — copy and paste

Everything the submission form asks for. Assets live beside this file.

---

## Name (45 char max)

```
Peal — live reveal countdowns
```

## Short description (132 char max)

```
Turns Peal seal links into a live countdown, right in the timeline. See exactly when a sealed announcement opens.
```

## Category

Social & Communication

## Language

English

---

## Detailed description

```
Peal seals a message until a moment you choose. Nobody can read it early — not
the sender, not the operators running the network, nobody.

This extension makes that visible. Wherever a Peal link is posted, it draws a
live countdown next to it: how long until the seal opens, and the exact time it
will happen in your own timezone. When the moment arrives, the card flips open
in place, with no refresh.

WHY AN EXTENSION

Link previews on X are static images. They cannot tick, and they cannot update.
A countdown that is actually live has to be drawn in your browser, which is what
this does.

WHERE IT WORKS

- X (x.com and twitter.com)
- Farcaster clients
- Any other website where a Peal link appears

WHAT IT SENDS

Two read-only requests to peal.network, and only when a Peal link is on the page
you are looking at: one to resolve the link, one to read the public open time.

Nothing else. No account, no analytics, no telemetry, no tracking, no ads, no
third-party services, and nothing stored about you.

Some Peal links carry a decryption key in the part of the URL after the "#",
which browsers never send to any server. This extension discards that key while
parsing the link, before any network code sees it. It is never stored and never
transmitted. The countdown does not need it — an open time is public information
about a seal, not about its contents.

OPEN SOURCE

Read the code: github.com/Adityaakr/peal-network/tree/main/extension
```

---

## Permission justifications

The form asks for one per permission. Reviewers reject vague answers, so each of
these names the exact code path.

**`host_permission: https://peal.network/*`**

```
The extension reads two public, read-only endpoints on peal.network to learn
when a sealed item opens: GET /v0/seals/<code> and GET /v0/conditions/<id>.
These requests are made from the background service worker because the content
script inherits the host page's Content Security Policy, which blocks them on
sites such as x.com. This is the only host the extension can contact.
```

**Content scripts on `http://*/*` and `https://*/*`**

```
Peal links are shared anywhere people post links, so the extension cannot know
in advance which sites to run on. On each page it scans anchor elements for
links pointing at peal.network and, where it finds one, inserts a countdown next
to it.

It reads only the href and the visible text of anchor elements. It does not
read, collect, or transmit page content, form data, keystrokes, cookies, or
browsing history. It modifies the page only by inserting its own countdown card
next to a matching link. On a page with no Peal links it does nothing at all and
makes no network request.

The broad match is required for function, not for data collection: the
extension's network access is restricted by host_permissions to peal.network
alone, so it is technically incapable of sending anything elsewhere.
```

**Single purpose statement**

```
Display a live countdown to the reveal time of a Peal sealed link, wherever
that link appears.
```

**Are you using remote code?**

```
No. All code is contained in the uploaded package. Nothing is fetched and
evaluated at runtime.
```

**Data usage disclosures — tick these**

- Does NOT collect or use personally identifiable information
- Does NOT collect or use health information
- Does NOT collect or use financial information
- Does NOT collect or use authentication information
- Does NOT collect or use personal communications
- Does NOT collect or use location
- Does NOT collect or use web history
- Does NOT collect or use user activity
- Does NOT collect or use website content

Then certify all three: no sale to third parties, no use unrelated to the single
purpose, no use to determine creditworthiness or for lending.

---

## Assets

| asset | file | required |
|---|---|---|
| Store icon 128×128 | `../icons/icon128.png` | yes |
| Screenshot 1280×800 | `screenshot-1-countdown.png` | at least one |
| Screenshot 1280×800 | `screenshot-2-opened.png` | optional |
| Privacy policy | host `PRIVACY.md` at a public URL | yes |

The privacy policy has to be a reachable URL, not a file. Either publish it at
`peal.network/privacy-extension` or point at the GitHub file once the branch is
merged.

---

## Before you submit

The one thing likely to draw a review question is the broad content-script
match. Two options:

1. **Submit as is** with the justification above. It is accurate and the
   restricted `host_permissions` supports it. Expect a slower first review.
2. **Narrow to x.com, twitter.com, warpcast.com and farcaster.xyz** for v1, then
   widen in a later version once the listing has a track record. Faster review,
   but the extension stops working on blogs and Discord web.

The `storage` permission has already been removed — it was declared but never
used, and an unused permission is a free reason for a reviewer to ask why. The
extension now declares exactly one host permission and no API permissions.
