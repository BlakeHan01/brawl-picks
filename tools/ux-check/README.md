# UX check

Walks every user flow of the site in a real browser (phone, 320 px and desktop) and fails on:

- accessibility issues (axe-core, WCAG 2.2 AA and best practices) on every view and dialog
- touch targets smaller than 24 × 24 px (WCAG 2.5.8; text links inside sentences are exempt)
- controls without an accessible name
- dialogs that don't follow the WAI-ARIA dialog pattern (focus moves in, Tab stays inside,
  Escape closes, focus returns to what opened it)
- broken navigation: "back" must return to the screen you came from, at the same spot
- horizontal scrolling at 320 px, JavaScript errors

Run it after any UI change:

```sh
npm run pull-data            # once: real data into site/ (from the data branch)
cd tools/ux-check && npm install
npm run check                # starts the local site itself; exit code 1 on any failure
```

A seeded example player (not a real account) is generated from the data for the linked-tag flows.
