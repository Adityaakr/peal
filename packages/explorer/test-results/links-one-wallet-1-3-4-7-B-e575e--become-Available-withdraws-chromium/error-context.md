# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: links-one-wallet.spec.ts >> 1, 3, 4, 7: Bob creates a link, receives while away, sees Incoming become Available, withdraws
- Location: e2e/links-one-wallet.spec.ts:70:1

# Error details

```
Test timeout of 600000ms exceeded.
```

# Page snapshot

```yaml
- main [ref=e2]:
  - generic [ref=e4]:
    - complementary [ref=e5]:
      - link "Peal Private Links" [ref=e6] [cursor=pointer]:
        - /url: "#/bonsai"
      - navigation "sections" [ref=e9]:
        - link "Overview" [ref=e10] [cursor=pointer]:
          - /url: "#/bonsai/app"
        - link "Payment links" [ref=e15] [cursor=pointer]:
          - /url: "#/bonsai/app/links"
        - link "Incoming" [ref=e20] [cursor=pointer]:
          - /url: "#/bonsai/app/incoming"
        - link "Activity" [ref=e25] [cursor=pointer]:
          - /url: "#/bonsai/app/activity"
        - link "Settings" [ref=e29] [cursor=pointer]:
          - /url: "#/bonsai/app/settings"
      - generic [ref=e34]:
        - generic [ref=e35]:
          - text: browser wallet
          - generic [ref=e36]: 0x7477bA…68c5
        - generic [ref=e37]: private payments on
        - generic [ref=e39]:
          - button "Lock" [ref=e40] [cursor=pointer]
          - button "Disconnect" [ref=e44] [cursor=pointer]
      - link "Peal Network" [ref=e48] [cursor=pointer]:
        - /url: "#/"
    - generic [ref=e51]:
      - generic [ref=e52]:
        - navigation "breadcrumb" [ref=e53]:
          - link "Peal Private Links" [ref=e54] [cursor=pointer]:
            - /url: "#/bonsai/app"
        - generic [ref=e55]:
          - combobox "network" [ref=e58] [cursor=pointer]:
            - option "local-a/tUSD" [selected]
            - option "local-b/tUSD"
          - link "how it works" [ref=e59] [cursor=pointer]:
            - /url: "#/bonsai"
          - link "0x7477ba…68c5 browser wallet · 0x7477bA…68c5" [ref=e63] [cursor=pointer]:
            - /url: "#/bonsai/app/settings"
            - generic [aria-hidden] [ref=e64]: "74"
            - generic [ref=e65]:
              - generic [ref=e66]: 0x7477ba…68c5
              - generic [ref=e67]: browser wallet · 0x7477bA…68c5
      - generic [ref=e68]:
        - generic [ref=e71]:
          - heading "Overview" [level=1] [ref=e72]
          - paragraph [ref=e73]: 0x7477ba…68c5 · your private balance and what happened lately.
        - generic [ref=e74]:
          - generic [ref=e75]:
            - generic [ref=e76]:
              - text: Private balance · tUSD on local chain A
              - generic [ref=e77]: local funds
            - generic [ref=e78]: 0.00tUSD
            - generic [ref=e79]: as of now · only you can see it
          - generic [ref=e80]:
            - generic [ref=e81]:
              - link "Send to an address" [ref=e82] [cursor=pointer]:
                - /url: "#/bonsai/app/send"
              - link "New payment link" [ref=e86] [cursor=pointer]:
                - /url: "#/bonsai/app/new-link"
              - link "Add funds" [ref=e89] [cursor=pointer]:
                - /url: "#/bonsai/app/fund"
              - link "Withdraw" [ref=e92] [cursor=pointer]:
                - /url: "#/bonsai/app/withdraw"
              - button "more" [ref=e96] [cursor=pointer]
            - generic [ref=e101]:
              - link "incoming 0.00 tUSD verified, not yet claimed" [ref=e102] [cursor=pointer]:
                - /url: "#/bonsai/app/incoming"
                - generic [ref=e103]: incoming
                - generic [ref=e104]: 0.00 tUSD
                - generic [ref=e105]: verified, not yet claimed
              - generic [ref=e106]:
                - generic [ref=e107]: wallet
                - generic [ref=e108]: 0.00 tUSD
                - generic [ref=e109]: public on local chain A
        - generic [ref=e110]:
          - generic [ref=e111]:
            - generic [ref=e112]:
              - heading "Recent activity" [level=2] [ref=e113]
              - link "View all" [ref=e114] [cursor=pointer]:
                - /url: "#/bonsai/app/activity"
            - generic [ref=e115]:
              - generic [ref=e119]: No activity yet
              - generic [ref=e120]: Deposits, payments sent and received, and withdrawals appear here.
          - generic [ref=e121]:
            - generic [ref=e122]:
              - heading "Payment links" [level=2] [ref=e123]
              - link "View all" [ref=e124] [cursor=pointer]:
                - /url: "#/bonsai/app/links"
            - generic [ref=e125]:
              - generic [ref=e130]: No payment links yet
              - generic [ref=e131]: A link is a fixed amount in tUSD that anyone can pay you privately, once.
        - paragraph [ref=e132]:
          - strong [ref=e133]: Local development setup.
          - text: proving keys generated locally (no ceremony), balances in local funds · ledger simplex-3-validators · height 257 · 0 receipts · circuit d308e51fe73d…
```