// Swing bot for cbBTC/USDC on one-minute bars.
//
// The tape is mostly noise around a slow drift, so the bot trades rarely and
// only into strength. It buys one thing: a pullback that is already turning
// back up, confirmed at two horizons -- the low of the last 15 minutes and
// the low of the last 30 must both be real dips, and the close must have
// bounced off both. It buys in two slices: 70% on the signal, the rest once
// the close holds above the 30-minute low, so a false bounce only ever
// risks part of the stake and each fill walks a shallower pool.
//
// It sells one thing: a run that has started to give back. Once a position
// is up 2% over its first fill, a 1% pullback from the best close since
// entry banks the whole move; the bot then waits for a genuine discount --
// half a percent under the price it just sold at -- before it buys again,
// so it cannot chase its own exit straight back up. The only other ways out
// are a 2% trailing stop, and a time exit: a position that has not run 0.5%
// after 240 bars is closed rather than carried all day through a flat tape.
// Two stop-outs in one window means the tape is hostile, so the bot stands
// down and keeps its cash.
//
// Every comparison is exact integer (bigint) arithmetic on closes, so two
// runs over the same bars answer byte for byte the same. No clock, no files,
// no network, no randomness; the only state is the closes it has seen and
// the fill prices the harness reports back.

import { BPS, runBars, type BarsState, type BuyInput, type OrderInput, type SellInput } from './vendor/makefun-bars.ts';

// The bot's tuning, as exact ratios so every test stays in integers.
const RULES = {
  shortLook: 15, // bars defining the short-horizon pullback low
  longLook: 30, // bars defining the long-horizon pullback low
  bounceNum: 1001n, // entry: the close must sit 0.1% above each horizon's low
  bounceDen: 1000n,
  dipNum: 998n, // ... and each low must sit 0.2% under its own lookback close
  dipDen: 1000n,
  firstSliceNum: 70n, // first slice takes 70% of the cash; the rest tops up
  firstSliceDen: 100n,
  topUpNum: 1001n, // top-up once the close holds 0.1% above the long low
  topUpDen: 1000n,
  topUpBars: 30, // bars after the signal during which a top-up may still fill
  armNum: 102n, // take-profit arms once the close is 2% over the first fill
  armDen: 100n,
  trailNum: 99n, // ... and fires 1% under the best close since entry
  trailDen: 100n,
  stopNum: 98n, // hard trailing stop: 2% under the best close since entry
  stopDen: 100n,
  rebuyNum: 199n, // re-entry needs the close 0.5% under the last exit fill
  rebuyDen: 200n,
  timeExitBars: 240, // bars a position may sit before the time exit applies
  timeExitNum: 201n, // ... closed unless it is 0.5% over its first fill by then
  timeExitDen: 200n,
  maxStops: 2, // stop-outs before the bot stands down for the window
  tailBars: 5, // never open a position this close to the end
  windowBars: 1440, // bars in a window; entries stop tailBars before it ends
  maxSlippageBps: 100, // fills move ~13 bps on a full-size order; 100 is ample
};

// Everything the bot remembers between batches, in one place.
const desk = {
  closes: [] as bigint[], // closes seen, oldest first, capped at longLook + 1
  seen: 0, // batches that carried a bar for the symbol
  peak: 0n, // best close since the current fill; 0 while flat
  filledAt: 0n, // fill price of the position's first slice; 0 while flat
  entryBar: -1, // batch the first slice filled on; -1 while flat
  soldAt: 0n, // fill price of the last exit; 0 before the first exit
  stops: 0, // trailing-stop exits taken this window
  topped: false, // the top-up slice has already filled for this position
  topUntil: -1, // last batch a top-up may still fill on
};

// Lowest close of the last `n` entries of a closes array.
function recentLow(closes: readonly bigint[], n: number): bigint {
  let low = closes[closes.length - 1];
  for (let i = closes.length - n; i < closes.length; i++) {
    if (closes[i] < low) low = closes[i];
  }
  return low;
}

await runBars({
  onBatch(state: BarsState, batch) {
    // First, learn what the last batch's orders did: the fill price of a buy
    // is what the take-profit and the time exit measure from, and the fill
    // price of a sell is what a re-entry must sit 0.5% under.
    let bought = false;
    for (const fill of batch.fills) {
      if (fill.status !== 'filled') continue;
      if (fill.side === 'buy') {
        bought = true;
        if (desk.entryBar < 0) {
          desk.filledAt = BigInt(fill.price);
          desk.entryBar = state.seq;
        }
      } else {
        desk.soldAt = BigInt(fill.price);
      }
    }

    const symbol = state.hello.symbols[0].symbol;
    const close = state.close(symbol);
    if (close === null) return [];
    desk.seen += 1;
    desk.closes.push(close);
    if (desk.closes.length > RULES.longLook + 1) desk.closes.shift();

    const held = state.positions.get(symbol);
    if (held !== undefined) {
      // A fill bar's close is where the peak starts: the harness reports the
      // fill in this same batch, so the peak and the exit tests below both
      // read this bar, exactly as the fill model prices it. A top-up fill
      // re-anchors the peak the same way.
      if (bought) desk.peak = close;
      if (desk.peak === 0n) desk.peak = close;
      if (close > desk.peak) desk.peak = close;
      // Hard trailing stop: 2% under the best close since entry.
      if (close * RULES.stopDen <= desk.peak * RULES.stopNum) {
        desk.stops += 1;
        desk.peak = 0n;
        desk.filledAt = 0n;
        desk.entryBar = -1;
        desk.topped = false;
        desk.topUntil = -1;
        const sell: SellInput = { side: 'sell', symbol, qty: held.qty, max_slippage_bps: RULES.maxSlippageBps };
        return [sell];
      }
      // Trailing take-profit: armed at +2% over the first fill, fired 1%
      // under the peak. It banks the run instead of riding it back down,
      // and it is not a stop-out: it never counts toward standing down.
      const armed = desk.filledAt > 0n && close * RULES.armDen >= desk.filledAt * RULES.armNum;
      const pullingBack = close * RULES.trailDen <= desk.peak * RULES.trailNum;
      if (armed && pullingBack) {
        desk.peak = 0n;
        desk.filledAt = 0n;
        desk.entryBar = -1;
        desk.topped = false;
        desk.topUntil = -1;
        const sell: SellInput = { side: 'sell', symbol, qty: held.qty, max_slippage_bps: RULES.maxSlippageBps };
        return [sell];
      }
      // Time exit: a position that has not run 0.5% after 240 bars is
      // closed rather than carried all day through a flat tape.
      const stale =
        desk.entryBar >= 0 &&
        state.seq - desk.entryBar >= RULES.timeExitBars &&
        desk.filledAt > 0n &&
        close * RULES.timeExitDen < desk.filledAt * RULES.timeExitNum;
      if (stale) {
        desk.peak = 0n;
        desk.filledAt = 0n;
        desk.entryBar = -1;
        desk.topped = false;
        desk.topUntil = -1;
        const sell: SellInput = { side: 'sell', symbol, qty: held.qty, max_slippage_bps: RULES.maxSlippageBps };
        return [sell];
      }
      // Top-up slice: the rest of the cash, once the close holds 0.1%
      // above the long-horizon low. It never fires on the fill bar itself,
      // and it expires thirty bars after the signal.
      if (!desk.topped && state.seq <= desk.topUntil) {
        const low = recentLow(desk.closes, RULES.longLook);
        if (close * RULES.topUpDen >= low * RULES.topUpNum) {
          const room = state.weightRoom(symbol);
          const slice = state.cash < room ? state.cash : room;
          if (slice >= BigInt(state.hello.fees.min_notional_quote_units)) {
            desk.topped = true;
            const buy: BuyInput = { side: 'buy', symbol, notional_quote_units: slice, max_slippage_bps: RULES.maxSlippageBps };
            return [buy];
          }
        }
      }
      return [];
    }

    desk.peak = 0n;
    desk.filledAt = 0n;
    desk.entryBar = -1;
    if (state.warmingUp) return [];
    if (desk.stops >= RULES.maxStops) return [];
    if (desk.seen <= RULES.longLook) return [];
    // Batches, not bars seen: a window may skip a minute, and the tail is
    // about how much window is left, not how many closes arrived.
    if (state.seq >= RULES.windowBars - RULES.tailBars) return [];

    // Entry: the close has bounced 0.1% off the lowest close of the last
    // 30 minutes AND off the lowest close of the last 15, each low a real
    // dip (0.2% under the close its own lookback ago, so flat chop does not
    // count), and the latest print is an up-tick rather than a close still
    // falling into the low.
    const longLow = recentLow(desk.closes, RULES.longLook);
    const longAgo = desk.closes[0];
    const shortLow = recentLow(desk.closes, RULES.shortLook);
    const shortAgo = desk.closes[desk.closes.length - RULES.shortLook - 1];
    const bounced =
      close * RULES.bounceDen >= longLow * RULES.bounceNum &&
      close * RULES.bounceDen >= shortLow * RULES.bounceNum;
    const realDip =
      longLow * RULES.dipDen <= longAgo * RULES.dipNum &&
      shortLow * RULES.dipDen <= shortAgo * RULES.dipNum;
    const upTick = close > desk.closes[desk.closes.length - 2];
    if (!bounced || !realDip || !upTick) return [];
    // After an exit, only a genuine discount counts: the close must sit
    // 0.5% under the fill the bot just sold at. Before the first exit
    // there is nothing to be under, so the plain dip rule governs.
    if (desk.soldAt > 0n && close * RULES.rebuyDen > desk.soldAt * RULES.rebuyNum) return [];

    const { fees } = state.hello;
    const byWeight = state.weightRoom(symbol);
    const full = state.cash < byWeight ? state.cash : byWeight;
    const slice = (full * RULES.firstSliceNum) / RULES.firstSliceDen;
    if (slice < BigInt(fees.min_notional_quote_units)) return [];
    desk.topped = false;
    desk.topUntil = state.seq + RULES.topUpBars;
    const buy: BuyInput = { side: 'buy', symbol, notional_quote_units: slice, max_slippage_bps: RULES.maxSlippageBps };
    const orders: OrderInput[] = [buy];
    return orders;
  },
});
