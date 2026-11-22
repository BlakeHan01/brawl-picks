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

| Tier | Points above average | Share of listed brawlers (top 40 per map, Ranked maps, Nov 14-22 games) |
|---|---|---|
| S | +5.5 or more | 3% (0 to 4 per map; about a third of maps have none) |
| A | +3.5 to +5.5 | 8% |
| B | +1.5 to +3.5 | 22% |
| C | 0 to +1.5 | 26% |
| D | below 0 | 40% |

The cut-offs are fixed so a tier means the same thing everywhere: a map with no S simply has no
standout pick.

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

## 4. Correcting for luck (small samples): two-level empirical Bayes

A brawler with 30 games and 20 wins hasn't proven a 67% win rate. We use **empirical-Bayes
shrinkage** (Efron & Morris 1975; Brown 2008), the standard way to estimate many rates from
unequal sample sizes: each estimate is pulled toward a starting value, more strongly when there are
fewer games. The starting value has two levels (partial pooling, as in Carpenter's Stan case
study): what we know about **this brawler on every map**, and its **presence on this map**.

```
x      = log(pick share + ban share) - that map's median, capped at +/-2
u      = the brawler's strength across all maps (its average result after the line, shrunk)
prior  = 0.5 + intercept + slope * x + u
score  = (0.5 * g + excess + K * prior) / (g + K)
points = 100 * (score - 0.5)
```

- `g` = the brawler's games on the map.
- `slope`, `intercept`: a game-weighted line through every brawler-map pair. Good players pick or
  ban strong brawlers more, so presence carries a little information. The intercept is needed:
  most games are on popular brawlers and the game-weighted average brawler is exactly 50%, so the
  line crosses 50% above x = 0. On trophy maps there are no bans and the fitted slope is clamped
  at 0 (it can't go negative).
- `u`: each brawler's results on all maps of the family, averaged with weights that favour maps with
  more games, then shrunk toward 0 by how much brawlers really differ (spread fitted from the data;
  about 2.6 points on Ranked maps). A brawler strong everywhere starts higher on a map where it has
  few games, instead of starting at the map average.
- `K` = how many games the starting value is "worth": `0.25 / tau^2`, where `tau^2` is how much a
  brawler's strength on one map varies around its starting value. With `u` in the starting value
  that's much less, so K is larger (about 380 games on Ranked maps, Nov 22 2026; capped 40-600).
- Both spreads are fitted by **maximum likelihood** (normal approximation, coin-flip noise `0.25/g`),
  alternating between the two levels until they settle. Everything is refitted on every update,
  separately for Ranked maps and trophy maps.

Reading it (K = 380): with 1,000 games the brawler's own results on the map have 72% of the say;
with 100 games the starting value has 79%. Brawlers under 10 games are not shown, and the site flags
under 200 games as a rough guide.

## 5. Evidence that it works (held-out test, reviewed)

`scripts/score-lab.mjs` runs the **production code** (`brawlerRows`, `fitModel`, `scoreRows`)
**forward in time**: for each day D, fit on the days before D only, then test on D. Legendary+
Ranked maps with 40+ training games and 100+ test games. Two measures:

- **Miss**: typical distance, in points, between the estimate and the brawler's true win rate on
  the test day. Coin-flip noise is the same for every method and is removed (subtract `y(1-y) g/(g-1)`
  per brawler from the squared error; unbiased if the noise is pure coin flips. It is a bit
  larger (dispersion 1.22, section 6), so absolute misses read slightly high; comparisons stay fair).
  Lower is better.
- **Top 5**: skill-adjusted win rate (section 3) on the test day of each map's top 5. Higher is better.

Days are weighted by test games; differences are paired against the site, +/- one standard error
across days. With uneven days that is only about 2.8 effective test days, and training days
overlap, so treat the standard errors as optimistic.

Real data, Nov 14-22 2026, test days Nov 18-22 (5 days, 13-24 maps a day, 224,551 test games):

| Method | Miss (points) | vs site | Top 5 | vs site |
|---|---|---|---|---|
| **Site: two-level, presence prior** | **2.65** | | 54.2% | |
| Two-level, no presence | 2.76 | +0.11 +/- 0.01 | 54.5% | +0.4 +/- 0.2 |
| One level (the site until Nov 22) | 2.87 | +0.22 +/- 0.03 | 53.8% | -0.3 +/- 0.1 |
| One level, a quarter of the fitted K | 3.11 | +0.46 +/- 0.23 | 54.5% | +0.3 +/- 0.3 |
| One level, shrink toward 50% | 2.99 | +0.34 +/- 0.04 | 53.9% | -0.2 +/- 0.2 |
| One level, before the intercept fix | 2.98 | +0.33 +/- 0.03 | 53.9% | -0.2 +/- 0.1 |
| Fixed: 40 games toward 50% | 3.46 | +0.81 +/- 0.27 | 54.6% | +0.4 +/- 0.5 |
| Raw win rate (10+ games) | 5.08 | +2.43 +/- 1.17 | 53.7% | -0.5 +/- 1.1 |
| Teammate-adjusted (RAPM, ridge 50) | n/a | | 54.6% | +0.4 +/- 0.5 |
| Most picked | n/a | | 51.4% | -2.8 +/- 0.6 |

What this shows:

- **Points**: the site's estimate misses a brawler's true win rate by about 2.7 points, against
  5.1 for raw win rates (48% smaller). It has the lowest miss of the methods tested and beats each
  one on at least 4 of 5 days (the one-level version on all 5).
- **Top 5**: the two-level model also picks better top 5s than the one-level site it replaced
  (+0.3 +/- 0.1). Dropping presence, pulling less, or teammate adjustment score a little higher on
  the top-5 test but within about 2 standard errors, and their points are less accurate; we keep the
  method whose points are most accurate and re-test as days accumulate.
- **Teammate adjustment** (RAPM: each team's skill-adjusted result split across its three members
  by ridge regression, as in basketball plus-minus; Sill 2010) gives no calibrated rate and no clear
  gain, so it isn't used.
- **Trophy-game maps** (50 of 76 maps; `TEST_MIN=40 node scripts/score-lab.mjs t`): special events
  rotate, so only 1-21 of them have enough games on a given test day (30,563 test games): miss 1.73
  for the site vs 1.83 one-level and 4.62 raw. Rarely played event maps can't be tested yet. (No map
  currently uses the mixed Ranked + trophy basis.)

Reviews (Nov 22 2026). Both were done by AI reviewers working in this project, not by an outside
statistician; this document, the code and `score-lab.mjs` are public so anyone can check them.

1. A first review found that the fitted line's intercept was dropped (priors ~2.7 points too
   high, worst for brawlers with few games), that the lab didn't run the production code, and that
   the earlier table pooled splits that trained on a single day. All fixed; a second pass checked
   the numbers against the lab output. Effect on the live site (864 Ranked brawler-map pairs): 477
   kept their tier, 384 moved down, 3 moved up; brawlers under 200 games moved most.
2. A second, cold-start review compared the method with the literature (beta-binomial and
   hierarchical partial pooling, player-effect models, Dota 2 skill-confounding studies). It judged
   the method sound with caveats: player-effect and matchup models need per-player game data that
   the day files don't keep. It proposed the cross-map brawler level and maximum-likelihood
   variances, which won every test day and are now the site's method.

## 6. Limitations (what this does not do)

- **Individual skill**: we remove the sampled side's average edge, not each player's skill. Players
  who are better with a particular brawler pick it more (a known confounder, e.g. in Dota 2
  studies); our estimate can still credit some of that to the brawler. The held-out test can't
  detect this, because training and test days share the same players.
- **Opponents and matchups** are averaged over, not modelled.
- **Uncertainty**: the site shows the game count as the confidence signal. As a rough guide the
  standard error of a score is `50 / sqrt(g + K)` points (+/-1.3 at 1,000 games with K = 380,
  +/-2.3 at 100). That ignores uncertainty in K and the prior, and the same players repeat a
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
- Carpenter, B. Hierarchical partial pooling for repeated binary trials (Stan case study).
  https://mc-stan.org/users/documentation/case-studies/pool-binary-trials.html
- Validating Dota 2 hero win rates with instrumental variables (TU Delft, skill confounding).
  https://repository.tudelft.nl/record/uuid:c04d0f4b-14fc-4d65-9756-0cf3abec54c9
