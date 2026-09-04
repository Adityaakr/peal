# Building the interface

Read this before you write any markup. An integration that works and looks
foreign is a bad integration: the person you are building for has to either
accept a page that does not match their product or rewrite everything you did.

## The rule

**Match their app. Do not bring ours.**

Peal has a design of its own, on peal.network. None of it belongs in somebody
else's product. What belongs there is their button, their card, their spacing,
their type, with a sealed bid behind it.

## Finding their design system

Three reads, in this order. Stop as soon as you can answer "what do I build a
button out of here". Do not grep the repository for hex codes, and do not open
twenty components to average them.

### 1. `package.json`

One file, and it decides most of it.

| What you find | What it means |
| --- | --- |
| `tailwindcss` | Tailwind. Their config has the palette. |
| `@mui/material` | MUI. Use its components and its theme. |
| `@chakra-ui/react` | Chakra. |
| `@mantine/core` | Mantine. |
| `antd` | Ant Design. |
| `styled-components`, `@emotion/styled` | CSS in JS. Find their theme object. |
| `bootstrap` | Bootstrap classes. |
| none of these | Plain CSS or CSS modules. Look for a global stylesheet. |

### 2. The config for whatever it named

- **`components.json`** means shadcn/ui. This is the best case: they already
  have `components/ui/button.tsx`, `card.tsx`, `input.tsx`. Import those. Do
  not write a button.
- **`tailwind.config.{js,ts}`** or an `@theme` block in the css: read
  `colors`, `borderRadius`, `fontFamily`. Use the names you find there
  (`bg-primary`, not `bg-blue-600`).
- **`theme.ts`, `createTheme(`, `extendTheme(`**: the MUI or Chakra theme.
  Palette keys and spacing units come from here.
- **`:root {` in a global stylesheet**: CSS custom properties. Use the
  variables, never the literal values behind them, or dark mode breaks.

### 3. One component next to where you are adding

Open the existing form or card nearest the place your UI is going. Usually the
checkout form, the contact form, or the listing card. Copy its conventions:

- how a label sits relative to its input
- the class order and spacing scale it uses
- how it shows a validation error
- whether buttons are sentence case or title case
- whether it uses a loading spinner or a disabled button with changed text

That component is the specification. Matching it is worth more than any palette.

## Say what you found

Before writing markup, say it in one line, so a wrong guess is caught before it
becomes fifteen files:

> Tailwind with shadcn/ui, `--primary` is a dark green, radius `lg`, forms use
> `<Label>` above `<Input>` with errors in `text-destructive` under the field.
> I will build the bid form the same way.

## When there is nothing to match

A new repository with no styles yet. Two honest options, and asking costs less
than guessing:

> This repo has no styling set up yet. Do you want me to add Tailwind, or
> plain CSS matching what is already here?

If they do not want to decide, use these. They are Peal's, they are plain CSS
custom properties, and they are easy to replace later because nothing hardcodes
a colour:

```css
:root {
  --peal-fg: #111827;
  --peal-muted: #6b7280;
  --peal-border: #e5e7eb;
  --peal-surface: #ffffff;
  --peal-accent: #2563eb;
  --peal-accent-weak: #eff6ff;
  --peal-danger: #dc2626;
  --peal-radius: 12px;
  --peal-mono: ui-monospace, SFMono-Regular, Menlo, monospace;
}
```

## The four surfaces

An auction needs these. Build the ones the product actually reaches.

### 1. The bid form

Lives wherever the buy button lives. Needs: an amount field, a submit, and one
line saying what sealing means. Nothing else.

The single most important thing is that **it says the bid is unreadable until
the close**, because that is the whole product and it is not obvious from a
form that looks like every other form.

### 2. The sealed confirmation

What replaces the form after a successful bid. It must be reassuring and
specific: the bid is sealed, it opens at a stated time, nobody can read it
before then including the seller.

If you have the check code, show it here.

### 3. The countdown

Anywhere the auction is visible. Show the deadline as a real time in the
viewer's timezone, with the zone named, not only "in 3 hours". A relative
countdown alone makes people miss deadlines across timezones.

### 4. The result

After the close: the winner, the ranked board if the product wants it, and the
proof link. Before the close this endpoint returns `bids: null`, which is not
an error and must not render as "no bids". See below.

## The states people forget

Build these or the integration breaks in front of a user.

| State | What the UI must show |
| --- | --- |
| open, not bid yet | the form |
| sealing | the button disabled, its label changed. This takes a moment: encryption happens in the browser |
| sealed | the confirmation, not the form again |
| closing | bids no longer accepted, not yet opened. `409` from the API |
| opened, they won | the result and what happens next |
| opened, they lost | the result, plainly. Do not hide it |
| reserve not met | say so. It is different from nobody bidding |
| before the deadline | `bids` is `null`. Show "opens at X", never "no bids yet" |
| the API is unreachable | say the seal did not go through. Never imply it did |

## Correctness that shows up in the interface

These are not style opinions. Get them wrong and the UI lies.

**Money is integers of minor units.** `12.50` is `1250`. Format for display
with the auction's own currency and decimals, never by assuming two:

```js
new Intl.NumberFormat(undefined, { style: 'currency', currency })
  .format(amountMinor / 10 ** decimals);
```

**A slot count is not a participant count.** Batches are padded to 64 with
decoys. Never render `slots_including_decoys` as "62 people bidding".

**The deadline is an instant.** Render it with the viewer's timezone and name
the zone. See `reference/time.md`.

**Never put the amount anywhere but the sealed payload.** No hidden input, no
analytics event, no console log, no error report. If a bid amount reaches your
own server before the close, the product is gone. This is the one rule where a
convenient UI decision breaks the guarantee.

**The seller's contact private key never leaves their machine.** If your UI
generates one, it goes in the seller's own storage and is shown once. There is
no recovery.

## A worked example, in two houses

The same form, built to match what was found. Neither is Peal's design.

### shadcn/ui, found via `components.json`

```tsx
'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function BidForm({ auctionId, currency }: { auctionId: string; currency: string }) {
  const [amount, setAmount] = useState('');
  const [state, setState] = useState<'idle' | 'sealing' | 'sealed'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setState('sealing');
    try {
      const { peal } = await import('https://peal.network/peal.js');
      const amountMinor = Math.round(parseFloat(amount) * 100);
      if (!Number.isInteger(amountMinor) || amountMinor <= 0) throw new Error('Enter an amount.');
      await peal.bid(auctionId, { amountMinor });
      setState('sealed');
    } catch (err) {
      setState('idle');
      setError(err instanceof Error ? err.message : 'That did not go through.');
    }
  }

  if (state === 'sealed') {
    return (
      <div className="rounded-lg border bg-muted/40 p-4 text-sm">
        <p className="font-medium">Your bid is sealed.</p>
        <p className="text-muted-foreground mt-1">
          Nobody can read it before the auction closes, including the seller.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="bid">Your bid ({currency})</Label>
        <Input id="bid" value={amount} onChange={(e) => setAmount(e.target.value)}
               inputMode="decimal" placeholder="0.00" aria-invalid={!!error} />
        {error && <p className="text-destructive text-sm" role="alert">{error}</p>}
      </div>
      <Button type="submit" disabled={state === 'sealing'} className="w-full">
        {state === 'sealing' ? 'Sealing…' : 'Place sealed bid'}
      </Button>
      <p className="text-muted-foreground text-xs">
        Encrypted in your browser. Unreadable until the auction closes.
      </p>
    </form>
  );
}
```

### Plain CSS, matching an existing stylesheet

Reuse their class names. If their buttons are `.btn .btn-primary`, use that.
Add no new stylesheet unless there is nothing to reuse.

```html
<form class="bid-form" id="bid">
  <label class="form-label" for="bid-amount">Your bid</label>
  <input class="form-input" id="bid-amount" inputmode="decimal" placeholder="0.00">
  <p class="form-error" role="alert" hidden></p>
  <button class="btn btn-primary" type="submit">Place sealed bid</button>
  <p class="form-hint">Encrypted in your browser. Unreadable until the auction closes.</p>
</form>
```

## Before you say it is done

- It uses their components, not new ones you invented.
- It uses their tokens, not literal colours.
- It looks right in dark mode if they have one.
- The form is usable by keyboard, the error has `role="alert"`, the field has a
  real `<label>`.
- Every state in the table above renders something sensible.
- No amount is anywhere except inside the sealed payload.

Then run the end to end check in `reference/verify.md`. A page that looks right
and does not seal is worse than one that looks wrong.
