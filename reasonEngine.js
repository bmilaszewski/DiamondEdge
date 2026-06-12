// reasonEngine.js — MLB pick reason generator.
// When rich stats are present (ERA, rdiff, OPS, etc.) it produces stat-driven
// prose. Falls back to seeded-template output for older DB rows that lack them.

function hashSeed(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) | 0;
    return (s >>> 0) / 4294967296;
  };
}

// ── Rich stat-driven reason (used when PREDSJSON stats are available) ────────
function generateRichReason(p, rnd) {
  const pick     = p.pick;
  const homeTeam = p.home_team || p.home;
  const awayTeam = p.away_team || p.away;
  const opp      = pick === homeTeam ? awayTeam : homeTeam;
  const isHome   = pick === homeTeam;

  const conf      = Number(p.confidence);
  const pickProb  = isHome ? Number(p.home_prob) : Number(p.away_prob);
  const vegaHome  = p.vegas_implied != null ? Number(p.vegas_implied) : null;
  const sameDir   = Boolean(p.same_side); // handles 1, true, 0, false, null
  const pickVegas = vegaHome != null ? (isHome ? vegaHome : 100 - vegaHome) : null;
  const modelEdge = p.edge != null ? Number(isHome ? p.edge : -p.edge) : null;

  const pickSP = isHome
    ? (p.home_sp && p.home_sp !== 'TBD' ? p.home_sp : null)
    : (p.away_sp && p.away_sp !== 'TBD' ? p.away_sp : null);
  const oppSP = isHome
    ? (p.away_sp && p.away_sp !== 'TBD' ? p.away_sp : null)
    : (p.home_sp && p.home_sp !== 'TBD' ? p.home_sp : null);

  // Rich stats oriented to the pick team
  const pickEraL5 = isHome ? p.home_sp_era_l5 : p.away_sp_era_l5;
  const oppEraL5  = isHome ? p.away_sp_era_l5 : p.home_sp_era_l5;
  const pickRdiff = isHome ? p.home_rdiff_30  : p.away_rdiff_30;
  const oppRdiff  = isHome ? p.away_rdiff_30  : p.home_rdiff_30;
  const pickWpct  = isHome ? p.home_wpct_30   : p.away_wpct_30;
  const oppWpct   = isHome ? p.away_wpct_30   : p.home_wpct_30;
  const pickOps   = isHome ? p.home_lineup_ops : p.away_lineup_ops;
  const oppOps    = isHome ? p.away_lineup_ops : p.home_lineup_ops;
  const pickWin   = isHome ? (p.home_win_streak  || 0) : (p.away_win_streak  || 0);
  const oppWin    = isHome ? (p.away_win_streak  || 0) : (p.home_win_streak  || 0);
  const pickLoss  = isHome ? (p.home_loss_streak || 0) : (p.away_loss_streak || 0);
  const oppLoss   = isHome ? (p.away_loss_streak || 0) : (p.home_loss_streak || 0);

  const shortLoc = isHome ? 'at home' : 'on the road';
  const sentences = [];

  // ── Sentence 1: Recent form / team momentum ──────────────────────────────
  const pRd = pickRdiff != null ? Number(pickRdiff) : null;
  const oRd = oppRdiff  != null ? Number(oppRdiff)  : null;
  const pWp = pickWpct  != null ? Number(pickWpct)  : null;
  const oWp = oppWpct   != null ? Number(oppWpct)   : null;

  if (pRd != null || pWp != null) {
    const pW = pWp != null ? Math.round(pWp * 15) : null;
    const oW = oWp != null ? Math.round(oWp * 15) : null;
    const rdStr  = pRd != null ? `${pRd >= 0 ? '+' : ''}${pRd.toFixed(2)}`  : null;
    const oRdStr = oRd != null ? `${oRd >= 0 ? '+' : ''}${oRd.toFixed(2)}`  : null;

    let streakCtx = '';
    if (pickWin >= 3)       streakCtx = `, winners of ${pickWin} straight`;
    else if (pickLoss >= 3) streakCtx = `, losers of their last ${pickLoss}`;
    else if (oppLoss >= 3)  streakCtx = `, catching ${opp} on a ${oppLoss}-game skid`;
    else if (oppWin >= 3)   streakCtx = ` (${opp} has also won ${oppWin} straight)`;

    const s1 = [];

    if (pW != null && oW != null && rdStr && oRdStr) {
      if (pWp >= oWp && pRd >= oRd) {
        s1.push(
          `Over the last 15 games, ${pick} leads on both fronts — ${pW}-${15-pW} (${(pWp*100).toFixed(0)}%) with a ${rdStr} run differential, compared to ${opp}'s ${oW}-${15-oW} record and ${oRdStr} rdiff${streakCtx}.`,
          `${pick} enters with the stronger recent résumé: ${pW}-${15-pW} and ${rdStr} run differential against ${opp}'s ${oW}-${15-oW} and ${oRdStr} over the last two weeks${streakCtx}.`,
          `The recent 15-game picture favors ${pick} across the board — ${(pWp*100).toFixed(0)}% winning rate and ${rdStr} run differential against ${opp}'s ${(oWp*100).toFixed(0)}% and ${oRdStr}${streakCtx}.`
        );
      } else if (pRd != null && oRd != null && pRd > oRd + 0.25) {
        s1.push(
          `${pick} holds the run differential edge over the last 15 games at ${rdStr} vs ${opp}'s ${oRdStr} — a scoring-efficiency gap the model treats as a primary indicator of current team health, even with records close (${pW}-${15-pW} vs ${oW}-${15-oW})${streakCtx}.`,
          `The run differential gap tells the story here: ${pick} at ${rdStr} vs ${opp} at ${oRdStr} over their last 15, outpacing them as a more efficient scoring team despite similar win totals${streakCtx}.`
        );
      } else {
        s1.push(
          `Recent form is fairly close — ${pick} ${pW}-${15-pW} (${rdStr} rdiff) vs ${opp} ${oW}-${15-oW} (${oRdStr}) over the last 15 — and the model breaks the near-even records using pitcher quality and lineup matchup inputs${streakCtx}.`,
          `Over the last 15 games: ${pick} ${pW}-${15-pW} (${rdStr} run diff) against ${opp}'s ${oW}-${15-oW} (${oRdStr}), with the model tilting toward ${pick} on the inputs that matter most in this specific matchup${streakCtx}.`
        );
      }
    } else if (pW != null && rdStr) {
      if (pRd > 0.5) {
        s1.push(
          `${pick} has been the more efficient team recently — ${pW}-${15-pW} over their last 15 with a ${rdStr} run differential, a combination the model weights heavily as a current-form indicator${streakCtx}.`,
          `Entering ${pW}-${15-pW} with a ${rdStr} run differential over their last 15 games, ${pick} brings the better recent form into this matchup${streakCtx}.`
        );
      } else {
        s1.push(
          `Over their last 15 games, ${pick} is ${pW}-${15-pW} with a ${rdStr} run differential — the short-window baseline the model uses as its primary current team-health signal${streakCtx}.`
        );
      }
    } else if (pRd != null) {
      if (pRd > 0.4) {
        s1.push(
          `${pick} has outscored opponents by ${rdStr} runs per game over their last 15 — a positive run-differential that the model treats as one of its strongest current-form signals${streakCtx}.`
        );
      } else if (pRd < -0.35) {
        s1.push(
          `Despite a ${rdStr} run differential recently, the model still grades ${pick} ahead in this matchup — the pitcher and lineup inputs in this specific contest override the recent team-level deficit${streakCtx}.`
        );
      } else {
        s1.push(
          `${pick} enters roughly neutral on recent run differential (${rdStr}), with the model's edge coming from the pitcher quality and lineup matchup components${streakCtx}.`
        );
      }
    }

    if (s1.length) sentences.push(rnd(s1));
  }

  // ── Sentence 2: Pitcher matchup ──────────────────────────────────────────
  const pEra = pickEraL5 != null ? Number(pickEraL5) : null;
  const oEra = oppEraL5  != null ? Number(oppEraL5)  : null;

  if (pickSP && oppSP && pEra != null && oEra != null) {
    const diff = oEra - pEra; // positive = pick's SP better (lower ERA)
    const s2 = [];

    if (diff >= 1.5) {
      s2.push(
        `On the mound, ${pickSP} comes in at a ${pEra.toFixed(2)} ERA over his last 5 starts — a decisive edge over ${oppSP}'s ${oEra.toFixed(2)}, and a gap of that size in recent starts is among the model's highest-weight pitching inputs.`,
        `${pickSP}'s ${pEra.toFixed(2)} ERA over his last 5 outings stands well above ${oppSP}'s ${oEra.toFixed(2)} — a ${diff.toFixed(2)}-run advantage in recent form that pushes the pitching component firmly toward ${pick}.`,
        `The starter matchup tilts sharply ${pick}'s way: ${pickSP} at ${pEra.toFixed(2)} ERA vs ${oppSP} at ${oEra.toFixed(2)} over 5 starts each — the kind of ERA gap that reflects a genuine recent-quality separation, not small-sample noise.`
      );
    } else if (diff >= 0.75) {
      s2.push(
        `${pickSP} (${pEra.toFixed(2)} ERA, last 5 starts) holds a real edge over ${oppSP} (${oEra.toFixed(2)}) in recent form — not a massive gap, but consistent and reliable enough that the model credits it in the pitching component.`,
        `The pitching edge leans ${pick}: ${pickSP} posts a ${pEra.toFixed(2)} ERA over his last 5 starts vs ${oppSP}'s ${oEra.toFixed(2)}, a ${diff.toFixed(2)}-run margin that weights into the model's matchup grade.`,
        `On the mound, ${pickSP} (${pEra.toFixed(2)} ERA last 5) has been sharper recently than ${oppSP} (${oEra.toFixed(2)}) — a consistent but not dominant starter edge the model factors in.`
      );
    } else if (diff >= 0.2) {
      s2.push(
        `${pickSP} (${pEra.toFixed(2)} ERA last 5) and ${oppSP} (${oEra.toFixed(2)}) are close, with ${pick}'s starter holding a slight recent-form advantage in what is otherwise a balanced pitching matchup.`,
        `The starter battle is nearly even — ${pickSP} at ${pEra.toFixed(2)} vs ${oppSP} at ${oEra.toFixed(2)} over their last 5 starts — but ${pick}'s marginal edge there reinforces the team-level lean.`
      );
    } else if (diff <= -1.5) {
      s2.push(
        `${oppSP} enters the sharper arm at ${oEra.toFixed(2)} ERA vs ${pickSP}'s ${pEra.toFixed(2)} over their last 5 starts, but the model backs ${pick} regardless — the run-differential and lineup inputs more than offset the starter disadvantage.`,
        `Despite ${oppSP}'s ${oEra.toFixed(2)}-to-${pEra.toFixed(2)} ERA edge in recent starts, the overall matchup grade still favors ${pick}: team-level momentum and lineup depth carry more weight in the model than the individual starter gap in this case.`
      );
    } else if (diff <= -0.3) {
      s2.push(
        `${oppSP} (${oEra.toFixed(2)} ERA last 5) has been marginally sharper than ${pickSP} (${pEra.toFixed(2)}) of late, but the gap is modest and the model's other inputs — run differential, lineup quality — still tilt the matchup grade toward ${pick}.`,
        `The pitching matchup slightly favors ${opp} — ${oppSP} at ${oEra.toFixed(2)} vs ${pickSP}'s ${pEra.toFixed(2)} over 5 starts — but the model rates ${pick} ahead overall once team-level factors are in the equation.`
      );
    } else {
      s2.push(
        `${pickSP} (${pEra.toFixed(2)} ERA last 5) and ${oppSP} (${oEra.toFixed(2)}) are essentially identical in recent form — with pitching a wash, the model leans on run differential and lineup quality to separate the teams.`,
        `It's a near-even pitching matchup: ${pickSP} at ${pEra.toFixed(2)} ERA vs ${oppSP} at ${oEra.toFixed(2)} over their last 5 starts each, and the model breaks the tie on the team-level components that have the larger variance.`
      );
    }
    sentences.push(rnd(s2));
  } else if (pickSP && pEra != null) {
    sentences.push(rnd([
      `${pick} sends ${pickSP} to the hill ${shortLoc}, carrying a ${pEra.toFixed(2)} ERA over his last 5 starts — recent form the model credits as a reliable pitching-quality signal.`,
      `${pickSP} gets the ball for ${pick} ${shortLoc} on the back of a ${pEra.toFixed(2)} ERA over his last 5 outings.`
    ]));
  } else if (pickSP && oppSP) {
    sentences.push(`${pickSP} takes the mound for ${pick} ${shortLoc} against ${oppSP}.`);
  }

  // ── Sentence 3: Model edge + lineup OPS ─────────────────────────────────
  const pOps = pickOps != null ? Number(pickOps) : null;
  const oOps = oppOps  != null ? Number(oppOps)  : null;
  const hasOps  = pOps != null && oOps != null;
  const hasEdge = pickVegas != null && modelEdge != null;

  if (hasEdge || hasOps) {
    const s3 = [];

    const edgeLabel = !sameDir
      ? `a ${Math.abs(modelEdge ?? 0).toFixed(1)}-point model-vs-market gap (${pickProb.toFixed(1)}% vs ${pickVegas?.toFixed(1)}% implied)`
      : (modelEdge ?? 0) >= 8
        ? `${pickProb.toFixed(1)}% model probability — ${(modelEdge ?? 0).toFixed(1)} points above the ${pickVegas?.toFixed(1)}% Vegas line`
        : `${pickProb.toFixed(1)}% model probability in line with the ${pickVegas?.toFixed(1)}% implied`;

    if (hasEdge && hasOps) {
      const opsDiff = pOps - oOps;
      if (opsDiff > 0.04) {
        s3.push(
          `The model backs ${pick} via ${edgeLabel}, with the lineup advantage reinforcing the case: a ${pOps.toFixed(3)} OPS against ${opp}'s ${oOps.toFixed(3)}.`,
          `Driving the quantitative case: ${edgeLabel}, supported by ${pick}'s ${pOps.toFixed(3)} lineup OPS edge over ${opp}'s ${oOps.toFixed(3)}.`,
          `${edgeLabel} — and ${pick}'s lineup comes in at ${pOps.toFixed(3)} OPS vs ${opp}'s ${oOps.toFixed(3)}, providing an additional layer the model doesn't ignore.`
        );
      } else if (opsDiff < -0.04) {
        s3.push(
          `The model still backs ${pick} at ${pickProb.toFixed(1)}% despite ${opp}'s ${oOps.toFixed(3)}-to-${pOps.toFixed(3)} lineup OPS advantage — the run-differential and pitching inputs outweigh the offense gap in this matchup.`,
          `${edgeLabel}: the lineup gap (${oOps.toFixed(3)} vs ${pOps.toFixed(3)} OPS) favors ${opp}, but the model's other inputs — recent form and pitcher quality — more than compensate in the overall grade.`
        );
      } else {
        s3.push(
          `${edgeLabel} — lineups closely matched at ${pOps.toFixed(3)} vs ${oOps.toFixed(3)} OPS, so the model's conviction rests on the run-differential and pitching components.`,
          `The model settles on ${pick} via ${edgeLabel}, with offense nearly a push at ${pOps.toFixed(3)} vs ${oOps.toFixed(3)} OPS — the team-level inputs carry the call.`
        );
      }
    } else if (hasEdge) {
      s3.push(
        `The model arrives at ${pickProb.toFixed(1)}% for ${pick}${pickVegas != null ? ` against a ${pickVegas.toFixed(1)}% Vegas-implied line — ${!sameDir ? `a contrarian ${Math.abs(modelEdge ?? 0).toFixed(1)}-point edge` : `${(modelEdge ?? 0) >= 5 ? `a ${(modelEdge ?? 0).toFixed(1)}-point premium over the market` : 'consensus direction confirmed by both systems'}`}` : ''}.`,
        `${pick} grades at ${pickProb.toFixed(1)}% confidence from the model${pickVegas != null ? `, with the market at ${pickVegas.toFixed(1)}% implied` : ''} — the quantitative case for the ${pick} lean ${shortLoc}.`
      );
    } else if (hasOps) {
      const opsDiff = pOps - oOps;
      if (opsDiff > 0.04) {
        s3.push(
          `On offense, ${pick}'s lineup posts a ${pOps.toFixed(3)} OPS against ${opp}'s ${oOps.toFixed(3)} — a depth advantage that backs up the model's ${pickProb.toFixed(1)}% grade.`
        );
      } else {
        s3.push(
          `The model's ${pickProb.toFixed(1)}% grade on ${pick} reflects a consistent edge across pitching, run differential, and lineup inputs — no single dominant factor, but convergence across all of them.`
        );
      }
    }

    if (s3.length) sentences.push(rnd(s3));
  }

  // Fallback if nothing generated
  if (!sentences.length) {
    sentences.push(
      `The model grades ${pick} at ${conf.toFixed(1)}% ${shortLoc}, backed by the team-level inputs the algorithm weights most heavily in this matchup environment.`
    );
  }

  return sentences.join(' ');
}

// ── Template-based fallback (used when rich stats are absent) ────────────────
// p fields: game_date, game_number,
//   away_team (or away), home_team (or home), pick,
//   confidence, home_prob, away_prob,
//   proj_total, home_sp, away_sp,
//   edge, vegas_implied, model_prob, same_side
function generateReason(p) {
  const seed = hashSeed(
    `${p.game_date}|${p.away_team || p.away}|${p.home_team || p.home}|${p.game_number || 1}`
  );
  const rng = makeRng(seed);
  const rnd = arr => arr[Math.floor(rng() * arr.length)];

  // Use rich stat-driven reason when actual game stats are present
  const hasRichStats =
    p.home_rdiff_30    != null || p.away_rdiff_30    != null ||
    p.home_sp_era_l5   != null || p.away_sp_era_l5   != null ||
    p.home_lineup_ops  != null || p.away_lineup_ops  != null ||
    p.home_era         != null || p.away_era         != null;
  if (hasRichStats) {
    return generateRichReason(p, rnd);
  }

  // ── Template fallback below ──────────────────────────────────────────────
  const pick     = p.pick;
  const homeTeam = p.home_team || p.home;
  const awayTeam = p.away_team || p.away;
  const opp      = pick === homeTeam ? awayTeam : homeTeam;
  const isHome   = pick === homeTeam;

  const conf     = Number(p.confidence);
  const homePr   = Number(p.home_prob);
  const awayPr   = Number(p.away_prob);
  const vegaHome = p.vegas_implied != null ? Number(p.vegas_implied) : null;
  const edge     = p.edge != null ? Number(p.edge) : null;
  const sameDir  = Boolean(p.same_side);
  const total    = p.proj_total != null ? Number(p.proj_total) : null;
  const homeSP   = p.home_sp && p.home_sp !== 'TBD' ? p.home_sp : null;
  const awaySP   = p.away_sp && p.away_sp !== 'TBD' ? p.away_sp : null;

  const pickProb  = isHome ? homePr : awayPr;
  const pickVegas = vegaHome != null ? (isHome ? vegaHome : 100 - vegaHome) : null;
  const modelEdge = edge != null ? (isHome ? edge : -edge) : null;

  const pickSP = isHome ? homeSP : awaySP;
  const oppSP  = isHome ? awaySP : homeSP;

  // ── SENTENCE 1: Model conviction ─────────────────────────────────────────
  const tier = conf >= 70 ? 4 : conf >= 65 ? 3 : conf >= 60 ? 2 : conf >= 56 ? 1 : 0;

  const convPool = [
    [
      `The model surfaces a slim but real lean toward ${pick} at ${conf.toFixed(1)}% — in baseball's compressed probability landscape, a consistent ${conf.toFixed(1)}% across inputs is actionable signal, not noise`,
      `${pick} earns the nod at ${conf.toFixed(1)}%, a modest algorithmic lean that still clears the threshold where these picks hold long-run value`,
      `It's a close call on paper, but the model settles on ${pick} at ${conf.toFixed(1)}% — in a 162-game sport decided by one or two runs, a consistent edge like this compounds`,
      `The algorithm puts ${pick} at ${conf.toFixed(1)}%, which translates to a genuine positional advantage even if the raw gap looks narrow`,
      `${conf.toFixed(1)}% from the model isn't dominant, but it's a clear lean — the model isn't splitting hairs here, it sees ${pick} as the better side in a tight matchup`,
      `Slim conviction, but conviction nonetheless: the model's ${conf.toFixed(1)}% for ${pick} reflects a consistent edge across the input variables, not a random tiebreaker`,
      `At ${conf.toFixed(1)}%, ${pick} barely clears the coin-flip line, but the model sees something specific in the inputs that justifies the lean`,
      `The model is precise rather than dramatic at ${conf.toFixed(1)}% — ${pick} is the right side here, just not by a wide margin, and the algorithm is honest about that`,
    ],
    [
      `A solid model lean behind ${pick} at ${conf.toFixed(1)}% — well past the noise threshold and into the range where the underlying inputs are telling a clear story`,
      `The model grades ${pick} at ${conf.toFixed(1)}%, a meaningful number: in baseball, anything above 57-58% reflects a genuine and actionable algorithmic edge`,
      `${conf.toFixed(1)}% model probability on ${pick} is a clean, consistent read that crosses the betting-worthy threshold without relying on a single outlier input`,
      `The algorithm has a real preference here — ${conf.toFixed(1)}% for ${pick} is the kind of moderate conviction that holds up across dozens of similar matchup profiles`,
      `Solid lean toward ${pick} at ${conf.toFixed(1)}% — across the input variables, the data lines up in their direction without much ambiguity`,
      `At ${conf.toFixed(1)}%, ${pick} gets a meaningful push from the model — moderate conviction, but in baseball that's a legitimate edge worth acting on`,
      `The model sees ${pick} as the right side with ${conf.toFixed(1)}% — a comfortable lean that goes beyond coin-flip territory and into the range of disciplined picks`,
      `${conf.toFixed(1)}% for ${pick} reflects a clear algorithmic preference; the model isn't hedging here, it's being precise about an edge it identifies in the matchup`,
    ],
    [
      `Strong model conviction drives this one — ${pick} at ${conf.toFixed(1)}% is a decisive, well-supported lean backed by convergent data across the key input variables`,
      `The model doesn't hedge at ${conf.toFixed(1)}%: ${pick} is a firm lean, meaningfully above the noise and well past the margin where these picks hold real value historically`,
      `${conf.toFixed(1)}% model probability for ${pick} — that's a high-quality signal; across the season, this conviction level resolves in the picked team's favor at a strong rate`,
      `At ${conf.toFixed(1)}%, the algorithm is making a firm statement on ${pick} — not a marginal call where one variable tips the scale, but a broad-based advantage across multiple inputs`,
      `The data lined up cleanly for ${pick}: ${conf.toFixed(1)}% algorithmic conviction reflects an edge in the variables that most reliably drive MLB game outcomes`,
      `${pick} earns a strong model lean at ${conf.toFixed(1)}% — this isn't a situation where a few favorable inputs mask a messy overall picture; the signal is consistent`,
      `The algorithm clocks in at ${conf.toFixed(1)}% for ${pick}, placing this well into the upper tier of model conviction — a level where the signal is worth trusting`,
      `${conf.toFixed(1)}% from the model on ${pick} is a real statement: the input variables weren't close, and the output reflects a clear matchup advantage on the key metrics`,
    ],
    [
      `This is a high-conviction model call — ${pick} at ${conf.toFixed(1)}% sits near the top of what the algorithm typically generates, reflecting a decisive, multidimensional edge`,
      `The model is firing confidently on ${pick} at ${conf.toFixed(1)}% — this level of output shows up when the input variables align sharply on one side rather than splitting`,
      `At ${conf.toFixed(1)}%, ${pick} earns one of the model's stronger outputs — this isn't a read that could flip with a minor roster adjustment; it's a well-grounded lean`,
      `High-end model conviction on ${pick}: ${conf.toFixed(1)}% reflects a matchup where the data doesn't leave much room for the other side to stake a claim`,
      `${conf.toFixed(1)}% from the model is a decisive number — ${pick} grades out well above the median pick, with the input variables pointing clearly and consistently in their direction`,
      `The algorithm hits ${conf.toFixed(1)}% on ${pick}, putting this in the upper quartile of model conviction for the season — a standout signal that the inputs are unusually aligned`,
      `Strong read from the model: ${conf.toFixed(1)}% on ${pick} means the key variables — pitching, lineup trends, run differential, park context — all tilt meaningfully toward ${pick}`,
      `The model's ${conf.toFixed(1)}% conviction on ${pick} is a firm lean in every sense: not a borderline call that needs a perfect game, but a well-supported structural advantage`,
    ],
    [
      `The model is about as certain as it gets for a 162-game MLB slate — ${pick} at ${conf.toFixed(1)}% is one of the strongest outputs the algorithm produces, reflecting near-universal input alignment`,
      `${conf.toFixed(1)}% for ${pick} sits near the ceiling of what this model generates — a call this firm shows up when virtually every relevant variable points the same direction`,
      `Top-end conviction from the algorithm: ${pick} at ${conf.toFixed(1)}% is a dominant signal, rare in baseball where parity keeps most probabilities compressed near the 50-50 line`,
      `The model isn't hedging at ${conf.toFixed(1)}% — that's a decisive lean that puts ${pick} among the day's highest-confidence plays by a considerable margin`,
      `At ${conf.toFixed(1)}%, the model is making one of its firmest statements on ${pick} — the input variables didn't split; they converged sharply, and the output reflects that clarity`,
      `${conf.toFixed(1)}% algorithmic conviction on ${pick} is exceptional in baseball terms — when the model reaches this level, it's because the data is unusually consistent across all major features`,
      `This is the model at its most decisive: ${conf.toFixed(1)}% for ${pick} stands out dramatically in a sport where true structural edges are rare and quickly priced out`,
      `The algorithm hits ${conf.toFixed(1)}% on ${pick} — a number that would be unremarkable in other sports but represents genuine top-of-range conviction in MLB's compressed probability space`,
    ],
  ][tier];

  const s1 = rnd(convPool);

  // ── SENTENCE 2: Vegas relationship ───────────────────────────────────────
  let s2;

  if (vegaHome == null || modelEdge == null) {
    s2 = rnd([
      `No Vegas line was available for this game, so the pick rests purely on the model's internal assessment — pitching quality, lineup depth, run-differential trends, and park-factor inputs all pointing toward ${pick}.`,
      `Vegas odds weren't in the system here, leaving the model to work entirely from team-level inputs — which is sometimes where the clearest algorithmic edges live.`,
      `Without a market-implied probability to benchmark against, this is a pure model call based on the features that historically drive home/away outcome splits.`,
      `No market line available for comparison — the model backs ${pick} based solely on the underlying data, with no Vegas cross-check in either direction.`,
    ]);
  } else if (sameDir && modelEdge >= 12) {
    s2 = rnd([
      `Vegas also leans ${pick}, but the model finds considerably more value than the market does — ${pickProb.toFixed(1)}% model probability against ${pickVegas.toFixed(1)}% Vegas-implied is a ${modelEdge.toFixed(1)}-point gap worth exploiting even in a consensus direction.`,
      `The books are aligned on direction, but the model outpaces them by ${modelEdge.toFixed(1)} points — ${pickVegas.toFixed(1)}% implied vs ${pickProb.toFixed(1)}% algorithmic says ${pick} is underpriced even among the bettors who already like them.`,
      `Both model and market lean ${pick}, yet the algorithm is significantly more bullish: ${pickProb.toFixed(1)}% conviction vs ${pickVegas.toFixed(1)}% implied is a ${modelEdge.toFixed(1)}-point gap suggesting the line hasn't fully caught up to the data.`,
      `Consensus direction with a meaningful edge baked in — market and model agree on ${pick}, but at ${pickVegas.toFixed(1)}% implied versus ${pickProb.toFixed(1)}% model probability, the books are leaving ${modelEdge.toFixed(1)} points on the table.`,
      `Vegas likes ${pick} too, just not as much as the algorithm does — ${pickVegas.toFixed(1)}% implied vs ${pickProb.toFixed(1)}% model is a ${modelEdge.toFixed(1)}-point spread suggesting the market is slow to reflect what the data is showing.`,
    ]);
  } else if (sameDir && modelEdge >= 3) {
    s2 = rnd([
      `Market and model arrive at the same conclusion: ${pick} is the preferred side, with ${pickProb.toFixed(1)}% algorithmic probability tracking closely to the ${pickVegas.toFixed(1)}% Vegas-implied.`,
      `The betting market validates the model's call — ${pick} draws support from both systems, with ${pickVegas.toFixed(1)}% implied closely shadowing the model's ${pickProb.toFixed(1)}%.`,
      `Both the algorithm and the books point to ${pick}: ${pickProb.toFixed(1)}% model vs ${pickVegas.toFixed(1)}% implied is tight enough that there's real consensus here, not coincidence.`,
      `The model and market are aligned on ${pick} — when independent evaluation systems converge on the same side, it tends to mean the edge is real and not a modeling artifact.`,
      `Full agreement between algorithm and market: ${pick} at ${pickProb.toFixed(1)}% model probability and ${pickVegas.toFixed(1)}% Vegas-implied is the kind of convergence that shores up confidence.`,
    ]);
  } else if (sameDir) {
    s2 = rnd([
      `The market is essentially in lockstep with the model — ${pickVegas.toFixed(1)}% Vegas-implied nearly mirrors the algorithm's ${pickProb.toFixed(1)}%, which confirms ${pick} is the right direction even if there's no line value to exploit.`,
      `Almost identical reads from model and market: ${pickProb.toFixed(1)}% algorithmic vs ${pickVegas.toFixed(1)}% implied confirms the directional call on ${pick} is validated from both independent systems.`,
      `Vegas and the model land in nearly the same spot — ${pickVegas.toFixed(1)}% implied vs ${pickProb.toFixed(1)}% model confirms ${pick} is the right side, even with no gap to exploit against the price.`,
    ]);
  } else if (!sameDir && Math.abs(modelEdge) >= 18) {
    s2 = rnd([
      `This is where it gets interesting: model and Vegas are in direct opposition — the market implies just ${pickVegas.toFixed(1)}% for ${pick} while the algorithm sees ${pickProb.toFixed(1)}%, and a ${Math.abs(modelEdge).toFixed(1)}-point gap between systems is exactly the kind of divergence worth backing.`,
      `The model is going hard against the grain: ${pick} sits at just ${pickVegas.toFixed(1)}% Vegas-implied while the algorithm has them at ${pickProb.toFixed(1)}%, and a ${Math.abs(modelEdge).toFixed(1)}-point disconnect between independent systems is a rare signal, not random disagreement.`,
      `Sharp model-vs-market disagreement: Vegas prices ${pick} as the underdog at ${pickVegas.toFixed(1)}% implied, but the model's ${pickProb.toFixed(1)}% calls that valuation off by ${Math.abs(modelEdge).toFixed(1)} points — a real fade-the-market situation backed by input-level evidence.`,
      `The algorithm sees something the market doesn't: ${pick} at ${pickVegas.toFixed(1)}% implied looks like a significant mispricing against the model's ${pickProb.toFixed(1)}%, and ${Math.abs(modelEdge).toFixed(1)} points of separation is too large a gap to attribute to model noise.`,
    ]);
  } else if (!sameDir && Math.abs(modelEdge) >= 10) {
    s2 = rnd([
      `The model breaks from the consensus here — Vegas has ${pick} at ${pickVegas.toFixed(1)}% implied, but the algorithm's ${pickProb.toFixed(1)}% says the market is undervaluing them by ${Math.abs(modelEdge).toFixed(1)} points.`,
      `A contrarian lean driven by a real model-vs-market gap: ${pick} is priced at ${pickVegas.toFixed(1)}% implied while the model sees ${pickProb.toFixed(1)}% — ${Math.abs(modelEdge).toFixed(1)} points of separation means the algorithm is explicitly fading the public line.`,
      `Vegas and the model disagree on ${pick}: the books say ${pickVegas.toFixed(1)}%, the model says ${pickProb.toFixed(1)}%, and a ${Math.abs(modelEdge).toFixed(1)}-point gap makes this a meaningful bet against market consensus.`,
      `Significant model-vs-market divergence drives this pick: ${pick} is the underdog at ${pickVegas.toFixed(1)}% implied, yet the model's inputs yield ${pickProb.toFixed(1)}% — the ${Math.abs(modelEdge).toFixed(1)}-point disconnect is the core of the contrarian case.`,
    ]);
  } else {
    s2 = rnd([
      `The model and market lean opposite directions on the winner, though the gap is modest: ${pickProb.toFixed(1)}% model vs ${pickVegas.toFixed(1)}% implied is a disciplined lean against the consensus, not a dramatic fade.`,
      `Vegas and the algorithm disagree on who wins, with the model's ${pickProb.toFixed(1)}% standing against a ${pickVegas.toFixed(1)}% market-implied line — a smaller but real divergence that drives the contrarian call.`,
      `The model sides against the market on this one: ${pick} at ${pickVegas.toFixed(1)}% implied vs ${pickProb.toFixed(1)}% algorithmic is a modest but meaningful gap that the model uses to justify backing the underdog.`,
    ]);
  }

  // ── SENTENCE 3: Game context (pitching + total + home-away) ──────────────
  const homeAwayTag = isHome
    ? rnd(['at home', 'in a home spot', 'with home-field advantage', 'at their home ballpark', 'playing in front of their home crowd'])
    : rnd(['on the road', 'away from home', 'in an away spot', 'traveling for this contest', 'in a road environment']);

  let totalClause = '';
  if (total != null) {
    if (total <= 6.5) {
      totalClause = rnd([
        `A ${total.toFixed(1)}-run projected total frames this as a true pitcher's duel — in this kind of run-scarce environment, execution and bullpen management decide it`,
        `With just ${total.toFixed(1)} runs on the over/under, both starters are expected to dominate; the model's lean in a tight, low-scoring environment is worth more than usual`,
        `At ${total.toFixed(1)} projected runs, this is a shutdown game — runs are at a premium and the model's positional advantage shows up most clearly in these close, pitcher-heavy matchups`,
      ]);
    } else if (total <= 8.5) {
      totalClause = rnd([
        `The ${total.toFixed(1)}-run projected total sits in balanced territory — neither a shutdown game nor a high-scoring affair, putting a premium on both starting pitching and lineup inputs`,
        `At ${total.toFixed(1)} projected runs, this is a moderate-environment game where the model weighs pitching quality and lineup production roughly equally`,
        `A ${total.toFixed(1)}-run over/under keeps both starters in the equation and the game script open — the kind of neutral environment where model edges tend to play out cleanly`,
      ]);
    } else if (total <= 10.5) {
      totalClause = rnd([
        `The ${total.toFixed(1)}-run total signals an active offensive environment — in higher-scoring games, lineup quality and recent offensive production trends become the dominant model inputs`,
        `At ${total.toFixed(1)} projected runs, both offenses are expected to show up, and the model's positive assessment of ${pick}'s offensive positioning drives this in a run-forward game`,
        `High-scoring game anticipated at ${total.toFixed(1)} runs — this is the environment where run-differential trends and lineup depth become the primary separators in the model's assessment`,
      ]);
    } else {
      totalClause = rnd([
        `The ${total.toFixed(1)}-run total is massive — one of the higher offensive expectations on the slate, pointing toward a game where lineup depth and bullpen usage become the decisive variables`,
        `At ${total.toFixed(1)} projected runs, this is an offense-first environment; the model's lean on ${pick} in a high-scoring context reflects strong lineup-side inputs in their favor`,
      ]);
    }
  }

  let pitchClause = '';
  if (pickSP && oppSP) {
    pitchClause = rnd([
      `${pick} sends ${pickSP} to the mound ${homeAwayTag} against ${oppSP}`,
      `${pickSP} draws the start for ${pick} ${homeAwayTag} in a matchup against ${oppSP}`,
      `The pitching setup pits ${pickSP} (${pick}) against ${oppSP} (${opp}), with ${pick} getting the nod ${homeAwayTag}`,
      `On the mound for ${pick}: ${pickSP} ${homeAwayTag}, squaring off against ${opp}'s ${oppSP}`,
      `${pickSP} toes the rubber for ${pick} ${homeAwayTag} in a pitching matchup against ${oppSP}`,
    ]);
  } else if (pickSP) {
    pitchClause = rnd([
      `${pick} sends ${pickSP} to the mound ${homeAwayTag}`,
      `${pickSP} gets the ball for ${pick} ${homeAwayTag}`,
    ]);
  } else if (oppSP) {
    pitchClause = rnd([
      `${pick} plays ${homeAwayTag} against ${opp}'s ${oppSP}`,
      `${opp} counters with ${oppSP} as ${pick} takes the field ${homeAwayTag}`,
    ]);
  }

  const shortLoc = isHome ? 'at home' : 'on the road';

  let s3 = '';
  if (pitchClause && totalClause) {
    s3 = rnd([
      `${pitchClause}, and ${totalClause.charAt(0).toLowerCase() + totalClause.slice(1)}.`,
      `${totalClause}, with ${pick} rolling out ${pickSP || 'their starter'} ${shortLoc}.`,
      `${pitchClause}; ${totalClause.charAt(0).toLowerCase() + totalClause.slice(1)}.`,
    ]);
  } else if (pitchClause) {
    s3 = `${pitchClause}.`;
  } else if (totalClause) {
    s3 = `${totalClause}.`;
  } else {
    s3 = rnd([
      `${pick} plays ${homeAwayTag}, and the model's read on the underlying inputs points clearly in their favor.`,
      `Playing ${homeAwayTag}, ${pick} lines up as the model's pick based on the available matchup data.`,
      `The model sees ${pick} as the better-positioned team ${homeAwayTag} across the inputs it weights most heavily.`,
    ]);
  }

  return `${s1}. ${s2} ${s3}`;
}

module.exports = { generateReason };
