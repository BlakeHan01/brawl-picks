# How Brawl Picks scores brawlers

This is the full method behind the tier and the "points" on the site, with the formulas, the
evidence that they work, and what they don't do. Code: `scripts/fetch-data.mjs` (`brawlerRows`,
`fitModel`, `scoreRows`), validation: `scripts/score-lab.mjs`.

## 1. What a "point" is

A **point** is one percentage point of win rate. The site's number for a brawler on a map is our
estimate of how often good players win with it there, compared with an average brawler (50%):

> **+5.9 points** = good players win about 55.9% of games with it on this map, where an average
> brawler would win 50%. Out of 100 games, roughly 6 more wins than average.

The tiers are fixed cut-offs on that number, the same on every map:

| Tier | Points above average | Share of listed brawlers (top 40 per map, Ranked maps, Nov 22 2026) |
|---|---|---|
| S | +5.5 or more | 5% (0 to 7 per map, usually 1-2) |
| A | +3.5 to +5.5 | 11% |
| B | +1.5 to +3.5 | 27% |
| C | 0 to +1.5 | 37% |
| D | below 0 | 19% |

Only each map's top 40 are listed; across *all* brawlers most of the long tail is D.

## 2. The games

Ranked games from the official Brawl Stars API in which **every one of the six players is
Legendary or higher** (rank 16+), from the last 14 days. We find them by reading the battle logs of
the top players in 8 regions and crawling up to 3,000 Legendary+ players met in their games.
Special-event maps without Ranked use games where every brawler has 750+ trophies. Draws,
friendly games and Showdown are excluded (bot-filled lobbies can't meet the all-Legendary bar); each game is counted once.

## 3. Correcting for skill (selection bias)

The players whose logs we read are strong: their side wins about 52% of Legendary+ games (median map, Nov 22 2026). A raw win rate
would flatter whatever they pick. So each appearance is compared with **how often its side usually
wins on that map**:

```
p  = share of games won by the sampled player's side on this map (about 0.52)
excess wins = (wins on the sampled side - games on that side * p)
            + (wins on the other side - games on that side * (1 - p))
```

This is a coarse skill correction: it removes the average advantage of the sampled side, not each
individual player's skill (see Limitations).

## 4. Correcting for luck (small samples): empirical Bayes

A brawler with 30 games and 20 wins hasn't proven a 67% win rate. We use **empirical-Bayes
shrinkage** (Efron & Morris 1975; Brown 2008), the standard way to estimate many rates from
unequal sample sizes: each estimate is pulled toward a starting value, more strongly when there are
fewer games.

```
x      = log(pick share + ban share) - that map's median, capped at +/-2
prior  = 0.5 + intercept + slope * x
score  = (0.5 * g + excess + K * prior) / (g + K)
points = 100 * (score - 0.5)
```

- `g` = the brawler's games on the map.
- `prior` = the starting value. Good players pick or ban strong brawlers more, so presence carries a
  little information. `slope` and `intercept` come from a game-weighted line through every
  brawler-map pair (Ranked maps and trophy maps fitted separately, refitted on every update). The
  intercept is needed: most games are on popular brawlers, and the game-weighted average brawler
  is exactly 50%, so the line crosses 50% above x = 0 (Nov 22 2026: slope 1.7 points per e-fold,
  intercept -2.6 points). Trophy maps have no bans and fit slope 0: plain shrinkage toward 50%.
- `K` = how many games the starting value is "worth": `K = 0.25 / tau^2` (method of moments),
  where `tau^2` is how much true strength varies around the line after removing coin-flip noise
  (`0.25 / g` per brawler). Capped to 40-600. Nov 22 2026: about 200 games on Ranked maps.

Reading it (K = 200): with 1,000 games the prior has 17% weight and the brawler's own results
dominate; with 50 games the prior has 80% weight. Brawlers under 10 games are not shown, and the
site flags under 200 games as a rough guide.

## 5. Evidence that it works (held-out test, reviewed)

`scripts/score-lab.mjs` runs the **production code** (`brawlerRows`, `fitModel`, `scoreRows`)
**forward in time**: for each day D, fit on the days before D only, then test on D. Legendary+
Ranked maps with 40+ training games and 100+ test games. Two measures:

- **Miss**: typical distance, in points, between the estimate and the brawler's true win rate on
  the test day. Coin-flip noise is the same for every method and is removed (unbiased: subtract
  `y(1-y) g/(g-1)` per brawler from the squared error). Lower is better.
- **Top 5**: skill-adjusted win rate (section 3) on the test day of each map's top 5. Higher is better.

Days are weighted by test games; differences are paired against the site, +/- one standard error
across days.

Real data, Nov 14-22 2026, test days Nov 18-22 (5 days, 24 maps, 224,551 test games):

| Method | Miss (points) | vs site | Top 5 | vs site |
|---|---|---|---|---|
| **Site: fitted, presence prior** | **2.89** | | 53.8% | |
| Fitted, shrink toward 50% | 3.01 | +0.12 +/- 0.01 | 53.9% | +0.1 +/- 0.1 |
| Site before the review fix (no intercept) | 2.98 | +0.09 +/- 0.03 | 53.9% | +0.1 +/- 0.1 |
| Fixed: 40 games toward 50% | 3.46 | +0.57 +/- 0.23 | 54.6% | +0.8 +/- 0.5 |
| Raw win rate (10+ games) | 5.08 | +2.19 +/- 1.13 | 53.7% | -0.1 +/- 1.2 |
| Teammate-adjusted (RAPM, ridge 50) | n/a | | 54.6% | +0.8 +/- 0.5 |
| Most picked | n/a | | 51.4% | -2.4 +/- 0.6 |

What this shows:

- **Points**: the site's estimate misses a brawler's true win rate by about 2.9 points, against
  5.1 for raw win rates (43% smaller), and is the most accurate method tested on every comparison.
  The presence prior helps a little but consistently (0.12 +/- 0.01).
- **Top 5**: all shrinkage methods are within about 1.5 standard errors of each other. Weaker
  pulling (fixed 40 games, or a quarter of the fitted K: +0.5 +/- 0.3) picks slightly better top 5s
  but misstates the points more. The difference isn't statistically clear with 5 test days; the
  site keeps the fitted K because its points are what we show, and we re-test as days accumulate.
- **Teammate adjustment** (RAPM: each team's skill-adjusted result split across its three members
  by ridge regression, as in basketball plus-minus; Sill 2010) is no clear gain on the top-5 test
  and gives no calibrated rate, so we keep the simpler model.
- **Trophy-game maps** (special events, 50 of 76 maps; `node scripts/score-lab.mjs t`): miss 2.33
  for the site vs 4.73 raw, on 29,594 test games. Top 5 differences are within noise.

Review: an independent statistical review (Nov 22 2026) found that the earlier version dropped the
fitted line's intercept (priors were ~2.7 points too high, worst for brawlers with few games), that
the lab didn't run the production code, and that the earlier table pooled splits that trained on a
single day. All three are fixed; the table above is the corrected test.

## 6. Limitations (what this does not do)

- **Individual skill**: we remove the sampled side's average edge, not each player's skill. Players
  who are better with a particular brawler pick it more (a known confounder, e.g. in Dota 2
  studies); our estimate can still credit some of that to the brawler. The held-out test can't
  detect this, because training and test days share the same players.
- **Opponents and matchups** are averaged over, not modelled.
- **Uncertainty**: the site shows the game count as the confidence signal. As a rough guide the
  standard error of a score is `50 / sqrt(g + K)` points (+/-1.4 at 1,000 games with K = 200,
  +/-2.9 at 100). That ignores uncertainty in K and the prior, and the same players repeat a
  brawler: results on odd vs even days vary 1.22x as much as coin flips alone would (an upper
  bound, as real day-to-day change adds to it), so true uncertainty is somewhat larger.
- **Time**: the 14-day window treats every day the same; balance changes reset a brawler's games
  to after the change, and with under 3 fresh days it is hidden (see README).

## References

- Efron, B. & Morris, C. (1975). Data analysis using Stein's estimator and its generalizations. JASA.
- Brown, L. D. (2008). In-season prediction of batting averages: a field test of empirical Bayes and
  Bayes methodologies. Annals of Applied Statistics. https://arxiv.org/abs/0803.3697
- Sill, J. (2010). Improved NBA adjusted +/- using regularization and out-of-sample testing.
  MIT Sloan Sports Analytics Conference.
- Rosenbaum, D. (2004). Measuring how NBA players help their teams win.
- Using logistic regression to analyze the balance of a game: the case of StarCraft II.
  https://arxiv.org/abs/1105.0755
