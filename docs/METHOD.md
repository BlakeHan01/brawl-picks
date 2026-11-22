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

| Tier | Points above average | Share of brawler-map pairs (Nov 2026) |
|---|---|---|
| S | +5.5 or more | 5% (0 to 7 per map, usually 1-2) |
| A | +3.5 to +5.5 | 11% |
| B | +1.5 to +3.5 | 27% |
| C | 0 to +1.5 | 37% |
| D | below 0 | 19% |

## 2. The games

Ranked games from the official Brawl Stars API in which **every one of the six players is
Legendary or higher** (rank 16+), from the last 14 days. We find them by reading the battle logs of
the top players in 8 regions and crawling up to 3,000 Legendary+ players met in their games.
Special-event maps without Ranked use games where every brawler has 750+ trophies. Draws,
friendly games and Showdown are excluded; each game is counted once.

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
score = (0.5 * g + excess + K * prior) / (g + K)
points = 100 * (score - 0.5)
```

- `g` = the brawler's games on the map.
- `K` = how many games the starting value is "worth". It is **fitted from the data on every run**
  (method of moments): `K = 0.25 / tau^2`, where `tau^2` is how much true strength varies between
  brawlers after removing coin-flip noise. On Nov 22 2026, K = 134 games for Ranked maps.
- `prior` = the starting value: `0.5 + slope * (log(pick share + ban share) - map median)`,
  capped at +/-2 e-folds. Good players pick or ban strong brawlers more, so presence carries a little
  information. The slope is fitted too (Nov 22 2026: 1.3 points per e-fold); if presence stopped
  predicting results it would fall to 0 and this becomes plain shrinkage toward 50%.

Reading it (K = 134): with 1,000 games the prior has 12% weight and the brawler's own results
dominate; with 50 games the prior has 73% weight. Brawlers under 10 games are not shown, and the site
flags under 200 games as a rough guide.

## 5. Evidence that it works (held-out test)

`scripts/score-lab.mjs` fits on some days and tests on the days it hasn't seen, for every map with
150+ Legendary+ games in both halves. Two measures:

- **Prediction error**: game-weighted squared difference between the estimate and the brawler's
  skill-adjusted win rate on unseen days (lower is better).
- **Top-5 test**: how often the method's top 5 brawlers actually won on unseen days.

Real data, Nov 14-22 2026, each of 4 days held out in turn, both directions (8 splits, 24 maps):

| Method | Mean prediction error | Top-5 actual win rate |
|---|---|---|
| Raw win rate (10+ games) | 34.6 | 52.9% |
| Shrink toward 50%, fixed 40 games | 23.8 | 54.1% |
| Fitted shrinkage toward 50% | **21.9** | 53.9% |
| **Fitted shrinkage + presence prior (site)** | **22.0** | 53.9% |
| Teammate-adjusted (RAPM, ridge 50) | n/a | 54.1% |
| Most picked | n/a | 51.3% |

- Shrinkage cuts prediction error by 36% versus raw win rates, in line with the literature (Brown
  2008 found the raw average to be the worst predictor).
- The site's method is (tied) most accurate. On the top-5 test all shrinkage methods land within
  ~0.25 points of each other, which is within noise for these sample sizes.
- **Teammate adjustment** (RAPM: each 3-brawler team's skill-adjusted result split across its members
  by ridge regression, as in basketball/soccer plus-minus; Sill 2010) gave no measurable gain, so we
  keep the simpler model.

## 6. Limitations (what this does not do)

- **Individual skill**: we remove the sampled side's average edge, not each player's skill. Players
  who are better with a particular brawler pick it more (a known confounder; e.g. TU Delft Dota 2
  studies); our estimate can still credit some of that to the brawler.
- **Opponents and matchups** are averaged over, not modelled.
- **Teammates**: tested (RAPM) and not used, see above.
- **Uncertainty**: the site shows the game count as the confidence signal. As a guide, the
  standard error of a score is about `50 / sqrt(g + K)` points: about +/-1.4 points at 1,000 games,
  +/-3 points at 100.
- **Balance changes** reset a brawler's games to after the change; with under 3 fresh days it is
  hidden (see README).

## References

- Efron, B. & Morris, C. (1975). Data analysis using Stein's estimator and its generalizations. JASA.
- Brown, L. D. (2008). In-season prediction of batting averages: a field test of empirical Bayes and
  Bayes methodologies. Annals of Applied Statistics. https://arxiv.org/abs/0803.3697
- Sill, J. (2010). Improved NBA adjusted +/- using regularization and out-of-sample testing.
  MIT Sloan Sports Analytics Conference.
- Rosenbaum, D. (2004). Measuring how NBA players help their teams win.
- Gibbs, Ramalingam et al. / TU Delft: causal effects of hero picks in Dota 2 (skill confounding).
- Using logistic regression to analyze the balance of a game: the case of StarCraft II.
  https://arxiv.org/abs/1105.0755
