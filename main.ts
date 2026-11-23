// Snapback Sniper — a pump.fun replay bot for the $5 winner-takes-all sprint.
//
// Idea (from the dev window, 24h of pump.fun data, 1,122 coins):
//   - Most coins dump: only 7.5% end above their first-trade price, but 16%
//     run at least 2x at some point. The money is in catching a run early
//     and getting out fast, not in holding.
//   - Fees are the enemy: 1.25% of size per side plus a flat tx fee, so a
//     round trip costs ~3% of a 0.06 SOL stake. Small stakes and tight
//     exits keep a bad coin cheap; winners are allowed to run to +80%.
//   - The size cap (1% of a curve's real SOL reserve) means a coin only
//     takes a meaningful buy once it has real liquidity, so entries wait
//     for reserves to form and for several distinct buyers to show up.
//
// Entry: a coin aged >= 120 slots whose last-60-slot tape shows net inflow
// >= 0.5 SOL from >= 4 distinct buyers over >= 5 buys, price up >= 8%
// and still within 5% of its window high, real reserves 0.5-40 SOL.
// One buy of 0.06 SOL, plus one 0.04 SOL add only while the price is up
// >= 15% from the last buy and inflow is still positive (max 0.10/coin).
//
// Exit (sell whole position): stop -12% vs cost; trailing stop -15% from
// the peak once +15% up; take profit at +80%; time exit after 1800 slots
// if not up 10%; fade exit on net outflow < -1 SOL over 30 slots.
//
// Guardrails: a probe mechanism buys 0.01 SOL round trips on liquid coins
// when the bot's own coins/fills lag the pace needed for 20 distinct
// mints, so the entry always clears the 20-mint bar.
//
// Deterministic by construction: no clock, no randomness, iteration only
// over insertion-ordered maps fed by the batch stream.
// The strategy lives in strategy.ts; this file only wires it to runBot.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
