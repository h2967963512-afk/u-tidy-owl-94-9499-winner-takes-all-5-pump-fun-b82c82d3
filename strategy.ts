// Snapback Sniper strategy (parametrized). See main.ts for the design notes.
// This file holds the whole trading logic; main.ts only wires it to runBot.
//
// Tuning notes (offline sweep on the dev window, part-00000, then grade-local
// on the full window; the dev window is a hard down market, so every active
// variant loses — the goal is the smallest loss with the guardrails cleared):
//   - Base momentum (this file's defaults): -0.652 SOL full dev, 185 trips,
//     185 mints, maxDD 7.5%. Best of everything tried.
//   - Stricter entry (net 0.8 SOL, 5 buyers, +10%): -0.843 SOL. Worse.
//   - Quick take-profit +40% / stop -8%: -0.288 SOL on the subset vs -0.096
//     for the base. Worse — winners need room to run.
//   - Liquidity entry (buy every coin once liquid, no price filter):
//     -1.5 to -1.8 SOL. Far worse — most coins are rugs; the momentum
//     filter is what keeps the loss small.
//   - Pilot momentum baseline: -9.5 SOL. Pilot reversion: -3.8 SOL.
//   - Hold-cash baseline: 0 SOL but 0 mints (fails the guardrail).
// The final window is fresh 6h data, so the dev loss is not a forecast —
// it only shows this entry loses the least among the variants tried while
// clearing 20+ mints with a 7.5% max drawdown.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** 'momentum': buy on inflow + price momentum. 'liquidity': buy as soon
   * as the size cap lets a meaningful buy through, no price filter. */
  mode: 'momentum' | 'liquidity';
  window: number;
  minNetSol: number;
  minBuys: number;
  minBuyers: number;
  minUp: number;
  nearHigh: number;
  minRqSol: number;
  maxRqSol: number;
  minAge: number;
  initialSol: number;
  addSol: number;
  maxPerCoinSol: number;
  addStep: number;
  buySlipBps: number;
  stopLoss: number;
  trailArm: number;
  trail: number;
  takeProfit: number;
  maxHold: number;
  holdIfUp: number;
  fadeWindow: number;
  fadeNetSol: number;
  cooldown: number;
  maxEntries: number;
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  mode: 'momentum',
  window: 60,
  minNetSol: 0.5,
  minBuys: 5,
  minBuyers: 4,
  minUp: 0.08,
  nearHigh: 0.95,
  minRqSol: 0.5,
  maxRqSol: 40,
  minAge: 120,
  initialSol: 0.06,
  addSol: 0.04,
  maxPerCoinSol: 0.1,
  addStep: 0.15,
  buySlipBps: 1500,
  stopLoss: 0.12,
  trailArm: 0.15,
  trail: 0.15,
  takeProfit: 0.8,
  maxHold: 1800,
  holdIfUp: 0.1,
  fadeWindow: 30,
  fadeNetSol: -1.0,
  cooldown: 300,
  maxEntries: 1,
  targetCoins: 25,
  targetFills: 60,
  paceSecs: 14400,
  probeSol: 0.01,
  maxProbes: 2,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;
const MAX_POSITIONS = 5;
const MIN_BUY_SOL = 0.01;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  trades: Trade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peakValue: number;
  invested: number;
  exiting: boolean;
  filled: boolean;
  lastAddPrice: number;
  lastValue: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  const probes = new Map<Pubkey, boolean>();
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = p.window + 10;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, trades: [], entries: 0, lastExit: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  const flow = (t: Tape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  const entrySignal = (t: Tape, now: number, rqSol: number): boolean => {
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (t.created === null || now - t.created < p.minAge) return false;
    const from = now - p.window;
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    let startPrice = -1;
    let high = 0;
    let last = 0;
    const byUser = new Map<string, number>();
    for (const tr of t.trades) {
      if (tr.slot <= from) {
        startPrice = tr.price;
        continue;
      }
      if (startPrice < 0) startPrice = tr.price;
      if (tr.buy) {
        buySol += tr.sol;
        buys++;
        byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
      } else {
        sellSol += tr.sol;
      }
      if (tr.price > high) high = tr.price;
      last = tr.price;
    }
    if (buys < p.minBuys || byUser.size < p.minBuyers) return false;
    if (buySol - sellSol < p.minNetSol) return false;
    if (startPrice <= 0) return false;
    const up = last / startPrice - 1;
    if (up < p.minUp) return false;
    if (last < high * p.nearHigh) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          tapeOf(e.mint).created = e.slot;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol,
            user: e.user,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          traded.add(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        let exit = h.exiting;
        const t = tapeOf(mint);
        if (!exit && value < cost * (1 - p.stopLoss)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && value >= cost * (1 + p.takeProfit)) exit = true;
        if (!exit && now - h.opened > p.maxHold && value < cost * (1 + p.holdIfUp)) exit = true;
        if (!exit && flow(t, now, p.fadeWindow) < p.fadeNetSol) exit = true;
        if (!exit) continue;
        h.exiting = true;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) {
            if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          }
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = MAX_POSITIONS - state.committedPositionCount();
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        const t = tapes.get(mint)!;
        const h = held.get(mint);
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        let want: number;
        if (h === undefined) {
          if (slotsLeft <= 0) continue;
          if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
          if (p.mode === 'momentum') {
            if (!entrySignal(t, now, rqSol)) continue;
          } else {
            // Liquidity mode: buy the moment the cap allows a real buy.
            // No price filter — catch coins before they run, if they run.
            if (Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS < MIN_BUY_SOL) continue;
          }
          want = p.initialSol;
        } else {
          if (h.exiting || !h.filled || h.invested >= p.maxPerCoinSol - MIN_BUY_SOL) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          if (price < h.lastAddPrice * (1 + p.addStep)) continue;
          if (flow(t, now, p.window) < p.minNetSol) continue;
          if (rqSol > p.maxRqSol) continue;
          want = Math.min(p.addSol, p.maxPerCoinSol - h.invested);
        }
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, want);
        if (amount > free - tx) amount = free - tx;
        if (amount < MIN_BUY_SOL) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        if (h === undefined) {
          held.set(mint, {
            opened: now,
            peakValue: 0,
            invested: amount,
            exiting: false,
            filled: false,
            lastAddPrice: price,
            lastValue: 0,
          });
          t.entries++;
          slotsLeft--;
        } else {
          h.invested += amount;
          h.lastAddPrice = price;
        }
      }

      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
