# Privacy policy — Peal: live reveal countdowns

Last updated: 23 August 2026

## The short version

This extension collects nothing, stores nothing about you, and sends nothing
anywhere except one read-only request to `peal.network` to ask when a seal
opens.

There is no account, no analytics, no telemetry, no advertising, no tracking,
and no third-party service of any kind.

## What the extension does

When you open a page, it looks for links to `peal.network` that point at a
sealed item. For each one it asks `peal.network` a single question — when does
this open? — and draws a countdown next to the link.

## What is sent, and to whom

Exactly two read-only requests, both to `https://peal.network`, and only when a
Peal link is actually present on the page you are looking at:

- `GET /v0/seals/<code>` — resolves a short share code to the item it names
- `GET /v0/conditions/<id>` — reads the public open time and status

Nothing else leaves your browser. No request is made to any other domain. No
request is made at all on pages with no Peal links.

## What is never sent

Some Peal links end in a decryption key. That key exists only in the part of
the URL after the `#`, which browsers never transmit to any server.

**The extension discards that key before doing anything else.** It is dropped
during link parsing, so it never reaches the extension's network code, is never
stored, and is never included in any request. The countdown does not need it:
the open time is public information about the item, not about its contents.

This is enforced in code and covered by automated tests that assert the key
cannot appear in the parsed result or in any outbound request.

## What is stored

Nothing persistent. Resolved open times are held in memory for up to five
minutes so that the same seal appearing in twenty posts costs one request
instead of twenty. That cache is discarded when the browser closes it.

No cookies are set. No `localStorage` is written. No browsing history, page
content, form data, keystrokes, or personal information is read, recorded, or
transmitted.

## Page access

The extension runs on pages you visit in order to find Peal links in them. It
reads link text and link targets for that purpose only. It does not read, copy,
or transmit page content, and it writes nothing to the page except the
countdown card it draws next to a Peal link.

Its network access is restricted, at the browser level, to `peal.network`. It
is technically unable to send data anywhere else.

## Data sharing and sale

None. There is no data to share or sell, and no third party receives anything.

## Children

The extension collects no data from anyone, including children.

## Changes

Any change to what is described here will be published in an updated version of
this policy before the change ships.

## Source code

The extension is open source. Its behaviour can be verified by reading it:
https://github.com/Adityaakr/peal-network/tree/main/extension

## Contact

adityakrx7@gmail.com
