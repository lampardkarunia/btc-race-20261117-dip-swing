// Dip-Swing cbBTC bot — btc-race-24h-20261117-0603, round 2.
// makefun anchor 969b6a0617171e6cc3058b5ecc8836d8916bb5d4 round 34031405
//
// Idea: cbBTC 1-minute bars are choppy and mean-reverting far more often than
// they trend, and every round trip costs ~26 bps (4 fee + 2 slippage + impact).
// So this bot only buys sharp, well-defined dips, in two flavours that share a
// single position slot, and it never chases momentum or holds through a grind:
//
//   CAP (crash dip): after a 6-hour fall of >= 300 bps that is still falling
//     fast (>= 80 bps in the last 15 minutes), buy 60% of equity. If it falls
//     another 100 bps from the fill, spend the rest of the cash (scale-in).
//     Exit at +150 bps, at -200 bps, or after 180 bars, whichever comes first.
//   SWING (range fade): when the close sits >= 1.8 standard deviations below
//     its 240-bar mean, arm; buy 55% of equity once it recovers to -1.0 sd,
//     but only when the 4-hour and 12-hour returns are no worse than -120 /
//     -100 bps (a day that fell hard is a trend, not a range). Exit at
//     +100 bps, at -90 bps, when the z-score reaches +1.2, or after 360 bars.
//   A CAP signal cuts a SWING position: the crash buyer owns the slot.
//   Safety: an equity drawdown of 9% from the peak flattens everything and
//   pauses entries for 360 bars. No trend-following, no trailing stop — both
//   lost money on every dev window tested (they sell the bounce too early and
//   re-enter the falling knife).
//
// Sizing uses integer quote units from the account the harness reports; all
// indicator math is plain float64 on closes (raw price / 1e5), deterministic
// across the two graded executions. No clock, no environment, no randomness.
//
// Tuned offline (own simulator, same fill economics as the harness) on three
// separate 24h dev windows — the round's window (+5.76), 2026-11-15 (+21.50)
// and 2026-11-13 (+7.99) USDC net, all positive at double fees too. The
// parameters below are the tuned set, chosen for the best worst-window PnL,
// not the best single-window score.

import { runBars, type BarsState, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const MAX_SLIPPAGE_BPS = 200;
const SCALE = 1e5; // raw price units per USDC

// --- tuned parameters (bps unless noted) ---
const CAP_R360 = -300; // 6h return that marks a crash dip
const CAP_R15 = -80; //   ...still falling fast over 15m
const CAP_FRAC_BPS = 6000; // buy 60% of equity on a CAP signal
const CAP_ADD_DROP = -100; // scale in the rest of the cash this far below entry
const CAP_TP = 150;
const CAP_SL = 200;
const CAP_TIME = 180; // bars
const SWING_ARM_Z = -1.8; // arm the range fade this far below the 240-bar mean
const SWING_BUY_Z = -1.0; // buy once it has recovered to here
const SWING_FRAC_BPS = 5500; // buy 55% of equity on a SWING signal
const SWING_R240 = -120; // regime gate: 4h return no worse than this
const SWING_R720 = -100; // regime gate: 12h return no worse than this
const SWING_TP = 100;
const SWING_SL = 90;
const SWING_Z_EXIT = 1.2; // exit when the close runs this far above the mean
const SWING_TIME = 360; // bars
const COOL_BARS = 30; // quiet bars after any filled sell
const DD_KILL_BPS = -900; // flatten + pause on a 9% equity drawdown
const DD_PAUSE_BARS = 360;

// --- rolling state (bar-indexed, so a missing minute never shifts a timer) ---
const closes: number[] = []; // USD closes, oldest first, at most 721 kept
let barIdx = -1; // index of the latest CBBTC bar
let myQty = 0n; // position size mirrored from fills (harness account is post-fill)
let entryPx = 0; // blended fill price of the open position, USD
let entryBar = -1;
let peakPx = 0;
let phase = 0; // 1 = first buy filled, 2 = scale-in filled
let owner: 'CAP' | 'SWING' | null = null;
let coolUntil = -1;
let pauseUntil = -1;
let armed = false; // SWING latch
let peakEquity = 1000; // USD, tracked from the harness account

function retBps(h: number): number {
  if (closes.length <= h) return 0;
  const now = closes[closes.length - 1];
  const then = closes[closes.length - 1 - h];
  return (now / then - 1) * 10000;
}

function z240(): number {
  if (closes.length < 240) return 0;
  const w = closes.slice(-240);
  let mean = 0;
  for (const x of w) mean += x;
  mean /= 240;
  let v = 0;
  for (const x of w) v += (x - mean) * (x - mean);
  const sd = Math.sqrt(v / 240);
  if (sd <= 0) return 0;
  return (closes[closes.length - 1] - mean) / sd;
}

function buyOrder(state: BarsState, fracBps: number): OrderInput | null {
  const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
  let notional = (state.equity * BigInt(fracBps)) / 10000n;
  if (notional > state.cash) notional = state.cash;
  if (notional < minNotional) return null;
  return { side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS };
}

function sellAllOrder(): OrderInput | null {
  if (myQty <= 0n) return null;
  return { side: 'sell', symbol: SYMBOL, qty: myQty, max_slippage_bps: MAX_SLIPPAGE_BPS };
}

await runBars({
  onBatch(state: BarsState, batch) {
    // Fold this batch's fills into the mirrored position first: the account
    // the harness reports is already post-fill, so fills are the only record
    // of what price each leg actually got.
    for (const f of batch.fills ?? []) {
      if (f.symbol !== SYMBOL || f.status !== 'filled') continue;
      const px = Number(f.price) / SCALE;
      const q = BigInt(f.qty);
      if (f.side === 'buy') {
        if (myQty === 0n) {
          entryPx = px;
          entryBar = barIdx + 1; // filled at this batch's bar open
          peakPx = px;
          phase = 1;
        } else {
          entryPx = (entryPx * Number(myQty) + px * Number(q)) / Number(myQty + q);
          // The scale-in counts only once its fill is seen: if this leg is
          // rejected the bot may still retry it on the next bar.
          phase = 2;
        }
        myQty += q;
      } else {
        myQty = 0n;
        owner = null;
        phase = 0;
        coolUntil = barIdx + 1 + COOL_BARS;
      }
    }

    const bar = (batch.bars ?? []).find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return []; // minute with no CBBTC bar: no new signal
    const close = Number(bar.c) / SCALE;
    barIdx += 1;
    closes.push(close);
    if (closes.length > 721) closes.shift();
    if (myQty > 0n) peakPx = Math.max(peakPx, close);

    const equity = Number(state.equity) / 1e6;
    peakEquity = Math.max(peakEquity, equity);

    if (state.warmingUp) return [];

    const z = z240();
    const r15 = retBps(15);
    const r240 = retBps(240);
    const r360 = retBps(360);
    const r720 = retBps(720);

    let orders: OrderInput[] = [];

    if (myQty > 0n) {
      const gain = (close / entryPx - 1) * 10000;
      const held = barIdx - entryBar;
      if (owner === 'CAP') {
        if (gain >= CAP_TP || gain <= -CAP_SL || held >= CAP_TIME) {
          orders = [sellAllOrder()].filter((o): o is OrderInput => o !== null);
        } else if (phase === 1 && gain <= CAP_ADD_DROP) {
          // Spend the rest of the cash. phase flips to 2 only when the fill
          // is reported (see the fills loop above), so a rejected leg retries.
          const add = buyOrder(state, 10000);
          if (add !== null) orders = [add];
        }
      } else {
        // SWING position
        if (gain >= SWING_TP || gain <= -SWING_SL || z >= SWING_Z_EXIT || held >= SWING_TIME) {
          orders = [sellAllOrder()].filter((o): o is OrderInput => o !== null);
        } else if (r360 <= CAP_R360 && r15 <= CAP_R15) {
          // A crash dip cuts the range trade: exit now, re-enter as CAP next bar.
          orders = [sellAllOrder()].filter((o): o is OrderInput => o !== null);
        }
      }
    } else if (barIdx >= coolUntil && barIdx >= pauseUntil) {
      if (z <= SWING_ARM_Z) armed = true;
      else if (z >= -0.5) armed = false;
      if (r360 <= CAP_R360 && r15 <= CAP_R15) {
        owner = 'CAP';
        const b = buyOrder(state, CAP_FRAC_BPS);
        if (b !== null) orders = [b];
      } else if (armed && z >= SWING_BUY_Z && r240 >= SWING_R240 && r720 >= SWING_R720) {
        owner = 'SWING';
        armed = false;
        const b = buyOrder(state, SWING_FRAC_BPS);
        if (b !== null) orders = [b];
      }
    }

    // Drawdown guard, applied after the strategy's own decision: flatten on a
    // 9% peak-to-current equity fall and stay out for a while.
    const dd = (equity / peakEquity - 1) * 10000;
    if (dd <= DD_KILL_BPS) {
      pauseUntil = barIdx + DD_PAUSE_BARS;
      if (myQty > 0n) {
        const s = sellAllOrder();
        orders = s !== null ? [s] : [];
      }
    }
    return orders;
  },
});
