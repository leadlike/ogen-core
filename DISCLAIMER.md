# Disclaimer

This software is provided for education and engineering discussion. It is **not financial advice** and it does not guarantee
any result. Trading can lose money, including all of the capital you put at risk. No software can guarantee capital.

- The daemon is **paper-only by design**: it refuses accounts that do not start with `DU`, non-paper ports, and public bind addresses.
  Do not modify those checks to run it with real money unless you fully understand and accept the consequences.
- Most behaviour is tested against a scripted fake of the IBKR API, not the real one. The assumptions that only a real paper run can
  prove are listed in `docs/IBKR_PAPER.md`. Treat anything not listed as proven as unproven.
- No trading strategy is included, and nothing here claims an edge or any performance.
- You are responsible for your broker's terms, your market-data subscriptions, your local regulations and your taxes.
