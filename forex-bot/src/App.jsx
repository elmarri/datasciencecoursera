import React, { useState, useEffect, useRef, useCallback } from "react";

// ─── PAIRS ────────────────────────────────────────────────────────────────
// spread: in price units (not pips), used for realistic demo P&L
// fh: Finnhub OANDA symbol for WebSocket
// av: [from, to] for Alpha Vantage FX_INTRADAY history
const PAIRS = [
  { sym:"EUR/USD", pip:0.0001, d:4, base:1.0850, atr:0.0008, spread:0.00010, fh:"OANDA:EUR_USD", av:["EUR","USD"] },
  { sym:"GBP/USD", pip:0.0001, d:4, base:1.2700, atr:0.0012, spread:0.00015, fh:"OANDA:GBP_USD", av:["GBP","USD"] },
  { sym:"USD/JPY", pip:0.01,   d:2, base:149.50, atr:0.12,   spread:0.015,   fh:"OANDA:USD_JPY", av:["USD","JPY"] },
  { sym:"USD/CHF", pip:0.0001, d:4, base:0.9050, atr:0.0007, spread:0.00018, fh:"OANDA:USD_CHF", av:["USD","CHF"] },
  { sym:"AUD/USD", pip:0.0001, d:4, base:0.6530, atr:0.0007, spread:0.00015, fh:"OANDA:AUD_USD", av:["AUD","USD"] },
  { sym:"USD/CAD", pip:0.0001, d:4, base:1.3650, atr:0.0008, spread:0.00020, fh:"OANDA:USD_CAD", av:["USD","CAD"] },
  { sym:"NZD/USD", pip:0.0001, d:4, base:0.5980, atr:0.0006, spread:0.00020, fh:"OANDA:NZD_USD", av:["NZD","USD"] },
  { sym:"EUR/GBP", pip:0.0001, d:4, base:0.8540, atr:0.0005, spread:0.00015, fh:"OANDA:EUR_GBP", av:["EUR","GBP"] },
  { sym:"EUR/JPY", pip:0.01,   d:2, base:162.20, atr:0.15,   spread:0.020,   fh:"OANDA:EUR_JPY", av:["EUR","JPY"] },
  { sym:"GBP/JPY", pip:0.01,   d:2, base:189.90, atr:0.18,   spread:0.025,   fh:"OANDA:GBP_JPY", av:["GBP","JPY"] },
];
const SYMS = PAIRS.map(p => p.sym);
const PM   = Object.fromEntries(PAIRS.map(p => [p.sym, p]));

// ─── ACCOUNT CONFIG ───────────────────────────────────────────────────────
const START_BAL  = 10000;  // Demo account starting balance
const MAX_OPEN   = 3;      // Max concurrent open positions
const VAULT_AT   = 2000;   // Bank $2k of profit and reset to START_BAL
const CIRCUIT_AT = 7000;   // Halt all trading if balance drops below this
const SKEY          = "beast_fx_v2";
const DEFAULT_FH_KEY = "d8gu0d1r01qhjpmpn5bgd8gu0d1r01qhjpmpn5c0";

// ─── HELPERS ──────────────────────────────────────────────────────────────
const fmt = (sym, v) => (v ?? 0).toFixed(PM[sym]?.d ?? 4);

// Signed pip count: positive = profit direction
const pipCount = (sym, entry, exit, action) => {
  const raw = (exit - entry) / (PM[sym]?.pip ?? 0.0001);
  return action === "BUY" ? Math.round(raw) : Math.round(-raw);
};

// Dollar P&L for N pips on a given lot size and current price
// Correct for USD-quote, USD-base, and JPY-cross pairs
const pipUSD = (sym, nPips, lots, refPrice) => {
  const m = PM[sym];
  if (!m) return 0;
  const contractSize = 100000;
  const pipVal = m.pip * contractSize * lots; // raw pip value in quote currency
  if (sym.endsWith("/USD")) return nPips * pipVal;          // EUR/USD, GBP/USD …
  if (sym.startsWith("USD/")) return nPips * pipVal / (refPrice || m.base); // USD/JPY …
  // Cross pairs (EUR/GBP, EUR/JPY, GBP/JPY)
  if (sym.includes("JPY")) return nPips * pipVal / (refPrice || m.base);
  return nPips * pipVal / (refPrice || 1);
};

// ─── SESSION FILTER ───────────────────────────────────────────────────────
// Avoids dead-market periods (late NY close / Asian only)
const getSession = () => {
  const h = new Date().getUTCHours();
  if (h >= 8  && h < 13) return { name:"London",       active:true,  vol:1.0, col:"#00d4aa" };
  if (h >= 13 && h < 20) return { name:"New York",     active:true,  vol:1.1, col:"#818cf8" };
  if (h >= 20 && h < 22) return { name:"NY Close",     active:false, vol:0.3, col:"#445"    };
  return                         { name:"Sydney/Tokyo", active:true,  vol:0.7, col:"#f59e0b" };
};

// ─── STORAGE ─────────────────────────────────────────────────────────────
// Tries window.storage (Claude Artifacts) then falls back to localStorage
const sload = async () => {
  try { const r = await window.storage?.get(SKEY); if (r?.value) return JSON.parse(r.value); } catch {}
  try { return JSON.parse(localStorage.getItem(SKEY) || "null"); } catch { return null; }
};
const ssave = async (d) => {
  const str = JSON.stringify(d);
  try { await window.storage?.set(SKEY, str); return; } catch {}
  try { localStorage.setItem(SKEY, str); } catch {}
};

// ─── SIMULATION (fallback when no API key) ───────────────────────────────
// Realistic Brownian motion with trend persistence and mean reversion
const MarketState = {};
PAIRS.forEach((p, i) => {
  MarketState[p.sym] = {
    trend:     [1,-1,1,-1,0,1,-1,1,0,-1][i] || 1,
    trendStr:  0.4 + Math.random() * 0.4,
    trendAge:  Math.floor(Math.random() * 20),
    trendLife: Math.floor(40 + Math.random() * 80),
    vol:       0.8 + Math.random() * 0.6,
    volAge:    0,
  };
});

const simCandle = (prev, sym, anchor) => {
  const m = PM[sym], ms = MarketState[sym];
  ms.trendAge++;
  if (ms.trendAge >= ms.trendLife) {
    ms.trend    = Math.random() < 0.55 ? ms.trend : (-ms.trend || 1);
    ms.trendStr = 0.3 + Math.random() * 0.7;
    ms.trendLife= 30 + Math.floor(Math.random() * 100);
    ms.trendAge = 0;
  }
  ms.trendStr = Math.max(0.1, Math.min(1, ms.trendStr + (Math.random() - 0.5) * 0.05));
  ms.volAge++;
  if (ms.volAge > 20 + Math.random() * 40) {
    ms.vol = Math.random() < 0.3 ? 0.3 + Math.random() * 0.4 : 0.7 + Math.random() * 1.8;
    ms.volAge = 0;
  }
  const atr    = m.atr * ms.vol;
  const base   = prev?.close ?? (anchor ?? m.base);
  const anc    = anchor ?? m.base;
  const revert = (base - anc) / anc * -0.15;
  const chg    = ms.trend * ms.trendStr * atr * 0.6
               + (Math.random() - 0.5) * atr * 0.8
               + revert * atr;
  const open   = base, close = Math.max(0.0001, open + chg);
  const wick   = atr * (0.2 + Math.random() * 0.5);
  return { open, close, high: Math.max(open, close) + wick, low: Math.min(open, close) - wick,
           range: Math.abs(close - open), bullish: close >= open, pip: m.pip, sym, real: false };
};

// ─── CANDLE BUILDER (converts Finnhub ticks → OHLC 1-min candles) ────────
const makeCandleBuilder = () => {
  const acc = {};
  PAIRS.forEach(p => {
    acc[p.sym] = { open: p.base, high: p.base, low: p.base, close: p.base, minStart: 0, ticks: 0 };
  });
  return {
    feed(sym, price, tsMs) {
      const a = acc[sym], minStart = Math.floor(tsMs / 60000) * 60000;
      let done = null;
      if (a.minStart && minStart > a.minStart && a.ticks > 0) {
        done = { open: a.open, close: a.close, high: a.high, low: a.low,
                 range: Math.abs(a.close - a.open), bullish: a.close >= a.open,
                 pip: PM[sym].pip, sym, real: true, ticks: a.ticks };
        a.open = price; a.high = price; a.low = price; a.close = price;
        a.minStart = minStart; a.ticks = 1;
      } else {
        if (!a.minStart) { a.minStart = minStart; a.open = price; }
        a.high  = Math.max(a.high, price);
        a.low   = Math.min(a.low,  price);
        a.close = price;
        a.ticks++;
      }
      return done;
    },
    getPrice: (sym) => acc[sym]?.close ?? PM[sym].base,
    getCurrent: (sym) => {
      const a = acc[sym];
      return { open: a.open, close: a.close, high: a.high, low: a.low,
               range: Math.abs(a.close - a.open), bullish: a.close >= a.open,
               pip: PM[sym].pip, sym, real: true };
    },
  };
};

// ─── ALPHA VANTAGE — free 1-min forex history ─────────────────────────────
// Free tier: 25 req/day. "demo" key works for EUR/USD only.
// Get a free key at alphavantage.co — no credit card required.
const fetchAVCandles = async (sym, apiKey = "demo") => {
  const [from, to] = PM[sym].av;
  try {
    const url = `https://www.alphavantage.co/query?function=FX_INTRADAY&from_symbol=${from}&to_symbol=${to}&interval=1min&outputsize=compact&apikey=${apiKey}`;
    const res  = await fetch(url);
    const data = await res.json();
    if (data.Note || data.Information) return { error: "Rate limited — wait 60s or use your own AV key" };
    const ts = data["Time Series FX (1min)"];
    if (!ts) return { error: data["Error Message"] || "No data — pair may need AV premium" };
    const m = PM[sym];
    const candles = Object.entries(ts)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-100)
      .map(([, v]) => {
        const o = parseFloat(v["1. open"]), c = parseFloat(v["4. close"]);
        return { open: o, close: c, high: parseFloat(v["2. high"]), low: parseFloat(v["3. low"]),
                 range: Math.abs(c - o), bullish: c >= o, pip: m.pip, sym, real: true };
      });
    return { candles };
  } catch (e) { return { error: String(e) }; }
};

// ─── FINNHUB WEBSOCKET — real-time tick prices ────────────────────────────
// Free tier at finnhub.io supports forex via OANDA WebSocket symbols.
// Sign up free → Dashboard → API keys → copy key → paste in Data tab.
const buildFinnhubWS = (apiKey, onTick, onStatus) => {
  let pingId;
  const ws = new WebSocket(`wss://ws.finnhub.io?token=${apiKey}`);

  ws.onopen = () => {
    onStatus("connected");
    PAIRS.forEach(p => ws.send(JSON.stringify({ type: "subscribe", symbol: p.fh })));
    pingId = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
    }, 25000);
  };

  ws.onmessage = e => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === "trade" && msg.data) {
        msg.data.forEach(tick => {
          const pair = PAIRS.find(p => p.fh === tick.s);
          if (pair) onTick(pair.sym, tick.p, tick.t);
        });
      }
    } catch {}
  };

  ws.onerror = () => onStatus("error");
  ws.onclose = () => { clearInterval(pingId); onStatus("closed"); };

  return () => { clearInterval(pingId); ws.close(); };
};

// ─── TECHNICAL INDICATORS ────────────────────────────────────────────────
const ema = (arr, n) => {
  if (!arr.length) return 0;
  if (arr.length <= n) return arr[arr.length - 1];
  const k = 2 / (n + 1);
  return arr.reduce((e, v, i) => (i === 0 ? v : v * k + e * (1 - k)));
};

const calcATR = (hist, n = 14) => {
  if (hist.length < 2) return PM[hist[0]?.sym || "EUR/USD"]?.atr ?? 0.0008;
  const trs = hist.slice(-n).map((c, i, a) => {
    if (!i) return c.range;
    return Math.max(c.high - c.low, Math.abs(c.high - a[i-1].close), Math.abs(c.low - a[i-1].close));
  });
  return trs.reduce((s, v) => s + v, 0) / trs.length;
};

const calcRSI = (cls, n = 14) => {
  if (cls.length < n + 1) return 50;
  let g = 0, l = 0;
  for (let i = cls.length - n; i < cls.length; i++) {
    const d = cls[i] - cls[i - 1]; d > 0 ? g += d : l -= d;
  }
  return 100 - 100 / (1 + g / (l || 0.001));
};

// Returns MACD histogram and crossover signals
const calcMACD = (cls) => {
  if (cls.length < 26) return { histVal: 0, bull: false, bear: false, above: false };
  const e12  = ema(cls.slice(-12), 12);
  const e26  = ema(cls.slice(-26), 26);
  const mac  = e12 - e26;
  const e12p = ema(cls.slice(-13, -1), 12);
  const e26p = ema(cls.slice(-27, -1), 26);
  const macp = e12p - e26p;
  const sig  = mac * 0.15 + macp * 0.85; // approximate 9-period signal
  const sigp = macp * 0.15 + (e12p - e26p) * 0.85;
  return {
    histVal: mac - sig,
    bull: mac > 0 && macp <= 0,   // MACD line crossed above signal
    bear: mac < 0 && macp >= 0,   // MACD line crossed below signal
    above: mac > sig,
    below: mac < sig,
  };
};

// ─── SIGNAL ENGINE v2 ─────────────────────────────────────────────────────
// Dual EMA crossover + MACD confirmation + RSI filter + session filter
// Lot sizing scales with signal score (confidence)
const MIN_SCORE = 6;
const BASE_LOTS = 0.05;  // micro lots per unit (0.05 = $0.50/pip at 1:1)
const MAX_LOTS  = 0.50;

const signal = (hist, pairStats, session) => {
  if (hist.length < 35) return null;
  if (!session?.active)  return null;  // no trading in dead sessions

  const cls  = hist.map(c => c.close);
  const last  = cls.length - 1;
  const sym   = hist[last]?.sym;
  const m     = PM[sym];
  if (!m) return null;

  // EMA crossovers
  const e8    = ema(cls.slice(-8),   8);
  const e21   = ema(cls.slice(-21), 21);
  const e50   = hist.length >= 50 ? ema(cls.slice(-50), 50) : e21;
  const e8p   = ema(cls.slice(-9, -1),   8);
  const e21p  = ema(cls.slice(-22, -1), 21);
  const crossUp   = e8p < e21p && e8 > e21;
  const crossDown = e8p > e21p && e8 < e21;
  const abv21 = cls[last] > e21, bel21 = cls[last] < e21;

  // MACD
  const macd = calcMACD(cls);

  // RSI
  const rsi      = calcRSI(cls);
  const rsiBullOK = rsi > 40 && rsi < 68;
  const rsiBearOK = rsi > 32 && rsi < 60;

  // ATR
  const atr      = calcATR(hist);
  const atrPips  = Math.max(5, Math.round(atr / m.pip));
  const momOK    = hist[last].range / (atr || 0.0001) > 0.4;

  // Trend context
  const bull50 = cls[last] > e50, bear50 = cls[last] < e50;
  const last3  = hist.slice(-3);
  const bullRun = last3.filter(c => c.bullish).length >= 2;
  const bearRun = last3.filter(c => !c.bullish).length >= 2;

  // Per-pair suppression: skip pairs with <20% WR after 15 trades
  const ps = pairStats?.[sym];
  if (ps?.trades >= 15 && ps.trades > 0 && (ps.wins || 0) / ps.trades < 0.20) return null;

  // Spread filter: skip if spread is more than 30% of ATR
  const spreadPips = Math.round(m.spread / m.pip);
  if (spreadPips > atrPips * 0.3) return null;

  let bs = 0, ss = 0;

  if (crossUp)              bs += 3; else if (e8 > e21 && abv21) bs += 1;
  if (crossDown)            ss += 3; else if (e8 < e21 && bel21) ss += 1;
  if (macd.bull)            bs += 2; else if (macd.above) bs += 1;
  if (macd.bear)            ss += 2; else if (macd.below) ss += 1;
  if (rsiBullOK && abv21)   bs += 2;
  if (rsiBearOK && bel21)   ss += 2;
  if (bull50) bs += 2;
  if (bear50) ss += 2;
  if (momOK && bullRun) bs += 1;
  if (momOK && bearRun) ss += 1;
  if (session.vol >= 1.0) { if (e8 > e21) bs += 1; if (e8 < e21) ss += 1; }

  const mkSig = (action, score) => {
    const multiplier = score >= 10 ? 4 : score >= 9 ? 3 : score >= 8 ? 2 : score >= 7 ? 1.5 : 1;
    const lots = +Math.min(MAX_LOTS, BASE_LOTS * multiplier).toFixed(2);
    const tp   = Math.max(20, Math.min(60, Math.round(atrPips * 2.0)));
    const sl   = Math.max(8,  Math.min(20, Math.round(atrPips * 1.0)));
    return { action, score, conf: Math.min(95, 45 + score * 5), lots, tp, sl,
             rsi: +rsi.toFixed(0), atrPips, spreadPips };
  };

  if (bs >= MIN_SCORE && bs > ss) return mkSig("BUY",  bs);
  if (ss >= MIN_SCORE && ss > bs) return mkSig("SELL", ss);
  return null;
};

// ─── LOCAL ANALYTICS (replaces the broken Anthropic API browser call) ────
const localAnalytics = (trades, balance, pairStats) => {
  const closed = trades.filter(t => t.status === "CLOSED");
  const wins   = closed.filter(t => t.pnl > 0);
  const losses = closed.filter(t => t.pnl <= 0);
  const wr     = closed.length ? wins.length / closed.length : 0;
  const avgW   = wins.length   ? wins.reduce((s,t) => s + t.pnl, 0) / wins.length   : 0;
  const avgL   = losses.length ? Math.abs(losses.reduce((s,t) => s + t.pnl, 0) / losses.length) : 0;
  const exp    = wr * avgW - (1 - wr) * avgL;
  const pf     = avgL * losses.length > 0 ? (avgW * wins.length) / (avgL * losses.length) : 0;

  const byPair = Object.entries(pairStats)
    .filter(([, p]) => p.trades >= 3)
    .sort((a, b) => (b[1].pnl || 0) - (a[1].pnl || 0));
  const topPair   = byPair[0]?.[0] ?? "EUR/USD";
  const worstPair = byPair[byPair.length - 1]?.[0] ?? "GBP/JPY";

  const tpHits    = closed.filter(t => t.exitReason === "TP").length;
  const slHits    = closed.filter(t => t.exitReason === "SL").length;
  const trailHits = closed.filter(t => t.exitReason === "Trail").length;
  const tpRate    = closed.length ? tpHits / closed.length : 0;

  let edge    = "building";
  if (closed.length >= 20) edge = exp > 0 && wr >= 0.286 ? "positive" : "negative";

  let insight = "Accumulating data — need 10+ trades";
  if (closed.length >= 10) {
    if (tpRate > 0.5) insight = `TP hit ${Math.round(tpRate * 100)}% — trend-following working`;
    else if (slHits > tpHits) insight = `SL hits dominating (${slHits}/${closed.length}) — entries may be late`;
    else if (trailHits / closed.length > 0.25) insight = `Trail exits ${Math.round(trailHits / closed.length * 100)}% of trades — good`;
    else insight = `${Math.round(wr * 100)}% WR over ${closed.length} trades`;
  }
  let action = "Let it run 20+ trades before adjusting anything";
  if (closed.length >= 20) {
    if (wr < 0.25)                   action = "Win rate too low — signal engine may be counter-trend, check session";
    else if (exp < 0)                action = "Negative expectancy — reduce lot sizes by 50%";
    else if (balance < START_BAL * 0.85) action = "Drawdown >15% — halve lot sizes until recovery";
    else                             action = `Running well — $${exp.toFixed(2)}/trade edge, maintain settings`;
  }

  return {
    verdict: closed.length < 5
      ? "Warming up — need 10 trades for meaningful analysis"
      : `${Math.round(wr * 100)}% WR · $${exp.toFixed(2)}/trade · PF ${pf.toFixed(2)} over ${closed.length} trades`,
    edge, topPair, worstPair, insight, action, pf: pf.toFixed(2), wr: (wr * 100).toFixed(1),
    tpAdjust: tpRate > 0.6 ? "ok" : tpRate < 0.3 ? "narrower" : "ok",
    lotAdvice: exp < -1 ? "decrease" : exp > 5 ? "increase" : "ok",
  };
};

// ─── CHART COMPONENTS ────────────────────────────────────────────────────
const Spark = ({ data, color, w = 160, h = 26 }) => {
  if (!data || data.length < 2) return null;
  const vs = data.map(d => d.close), mn = Math.min(...vs), mx = Math.max(...vs), rng = mx - mn || 0.001;
  const pts = vs.map((v, i) => `${(i / (vs.length - 1)) * w},${h - ((v - mn) / rng) * h}`).join(" ");
  return <svg width={w} height={h} style={{ display: "block" }}><polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" /></svg>;
};

const EqCurve = ({ hist, startBal }) => {
  if (!hist || hist.length < 2) return (
    <div style={{ height: 90, display: "flex", alignItems: "center", justifyContent: "center", color: "#334", fontSize: 11 }}>Building equity curve…</div>
  );
  const W = 440, H = 90, pd = 10;
  const vals = hist.map(h => h.bal), mn = Math.min(...vals, startBal * 0.92), mx = Math.max(...vals, startBal * 1.08), rng = mx - mn || 1;
  const X = i => pd + (i / (vals.length - 1)) * (W - pd * 2), Y = v => H - pd - ((v - mn) / rng) * (H - pd * 2);
  const pts = vals.map((v, i) => `${X(i)},${Y(v)}`).join(" ");
  const col = vals[vals.length - 1] >= startBal ? "#00d4aa" : "#ef4444";
  return (
    <svg width={W} height={H} style={{ display: "block", maxWidth: "100%" }}>
      <defs><linearGradient id="eq" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor={col} stopOpacity="0.3" /><stop offset="100%" stopColor={col} stopOpacity="0" />
      </linearGradient></defs>
      <line x1={pd} y1={Y(startBal)} x2={W - pd} y2={Y(startBal)} stroke="#1a2030" strokeWidth="1" strokeDasharray="4,3" />
      <polygon points={`${pd},${H - pd} ${pts} ${X(vals.length - 1)},${H - pd}`} fill="url(#eq)" />
      <polyline points={pts} fill="none" stroke={col} strokeWidth="2.2" strokeLinejoin="round" />
      <text x={W - pd} y={12} textAnchor="end" fill={col} fontSize="10" fontFamily="monospace" fontWeight="700">${vals[vals.length - 1]?.toFixed(0)}</text>
      <text x={pd} y={H - 2} fill="#334" fontSize="9" fontFamily="monospace">${startBal.toLocaleString()}</text>
    </svg>
  );
};

const PriceChart = ({ hist, sig, sym }) => {
  if (!hist || hist.length < 10) return (
    <div style={{ height: 90, display: "flex", alignItems: "center", justifyContent: "center", color: "#334", fontSize: 11 }}>Loading chart…</div>
  );
  const W = 440, H = 90, pd = 8;
  const cls = hist.map(c => c.close), mn = Math.min(...cls), mx = Math.max(...cls), rng = mx - mn || 0.001;
  const X = i => pd + (i / (cls.length - 1)) * (W - pd * 2), Y = v => H - pd - ((v - mn) / rng) * (H - pd * 2);
  const pts = cls.map((v, i) => `${X(i)},${Y(v)}`).join(" ");
  const e8  = cls.map((_, i) => i < 7  ? null : ema(cls.slice(Math.max(0, i - 7),  i + 1),  8));
  const e21 = cls.map((_, i) => i < 20 ? null : ema(cls.slice(Math.max(0, i - 20), i + 1), 21));
  const e8pts  = e8.map((v, i)  => v !== null ? `${X(i)},${Y(v)}`  : null).filter(Boolean).join(" ");
  const e21pts = e21.map((v, i) => v !== null ? `${X(i)},${Y(v)}`  : null).filter(Boolean).join(" ");
  return (
    <svg width={W} height={H} style={{ display: "block", maxWidth: "100%" }}>
      <defs><linearGradient id="pg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#818cf8" stopOpacity="0.15" /><stop offset="100%" stopColor="#818cf8" stopOpacity="0" />
      </linearGradient></defs>
      <polygon points={`${pd},${H - pd} ${pts} ${X(cls.length - 1)},${H - pd}`} fill="url(#pg)" />
      <polyline points={pts} fill="none" stroke="#818cf8" strokeWidth="1.8" strokeLinejoin="round" />
      {e8pts  && <polyline points={e8pts}  fill="none" stroke="#00d4aa" strokeWidth="1.2" strokeDasharray="3,2" />}
      {e21pts && <polyline points={e21pts} fill="none" stroke="#f59e0b" strokeWidth="1.2" strokeDasharray="3,2" />}
      {sig && <circle cx={X(cls.length - 1)} cy={Y(cls[cls.length - 1])} r={5}
                      fill={sig.action === "BUY" ? "#00d4aa" : "#ef4444"} stroke="#07090e" strokeWidth={2} />}
    </svg>
  );
};

// ═══════════════════════════════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════════════════════════════
export default function App() {
  const [hists,     setHists]    = useState(() => Object.fromEntries(SYMS.map(s => [s, []])));
  const [prices,    setPrices]   = useState(() => Object.fromEntries(SYMS.map(s => [s, { close: PM[s].base, open: PM[s].base, high: PM[s].base, low: PM[s].base }])));
  const [trades,    setTrades]   = useState([]);
  const [balance,   setBalance]  = useState(START_BAL);
  const [vault,     setVault]    = useState([]);
  const [sigs,      setSigs]     = useState({});
  const [log,       setLog]      = useState([]);
  const [active,    setActive]   = useState("EUR/USD");
  const [tab,       setTab]      = useState("dash");
  const [loaded,    setLoaded]   = useState(false);
  const [pairStats, setPairStats]= useState(() => Object.fromEntries(SYMS.map(s => [s, { trades: 0, wins: 0, pnl: 0 }])));
  const [eqHist,    setEqHist]   = useState([]);
  const [session,   setSession]  = useState(getSession());
  const [aiReport,  setAiReport] = useState(null);

  // Finnhub WebSocket
  const [fhKey,     setFhKey]    = useState("");
  const [fhInput,   setFhInput]  = useState("");
  const [fhStatus,  setFhStatus] = useState("disconnected"); // disconnected | connecting | connected | error | closed
  const [fhError,   setFhError]  = useState("");

  // Alpha Vantage history seeding
  const [avInput,   setAvInput]  = useState("");
  const [avStatus,  setAvStatus] = useState("idle");
  const [avLoading, setAvLoad]   = useState(false);

  // Mutable refs (avoid stale closures in tick/callbacks)
  const hiR = useRef(hists);       const prR = useRef(prices);
  const trR = useRef(trades);      const baR = useRef(balance);
  const vaR = useRef(vault);       const eqR = useRef(eqHist);
  const psR = useRef(pairStats);   const sessR = useRef(session);
  const cbRef  = useRef(false);    const tkR   = useRef(0);
  const tcR    = useRef(0);
  const fhCloseRef   = useRef(null);
  const ivRef        = useRef(null);
  const stRef        = useRef(null);
  const candleBuilder = useRef(makeCandleBuilder());

  useEffect(() => { hiR.current  = hists;     }, [hists]);
  useEffect(() => { prR.current  = prices;    }, [prices]);
  useEffect(() => { trR.current  = trades;    }, [trades]);
  useEffect(() => { baR.current  = balance;   }, [balance]);
  useEffect(() => { vaR.current  = vault;     }, [vault]);
  useEffect(() => { eqR.current  = eqHist;    }, [eqHist]);
  useEffect(() => { psR.current  = pairStats; }, [pairStats]);
  useEffect(() => { sessR.current = session;  }, [session]);

  const addLog = useCallback((msg, type = "info") => {
    setLog(p => [{ msg, type, t: new Date().toLocaleTimeString() }, ...p].slice(0, 400));
  }, []);

  const doSave = useCallback(() => {
    if (stRef.current) clearTimeout(stRef.current);
    stRef.current = setTimeout(() => {
      ssave({ trades: trR.current.filter(t => t.status === "CLOSED").slice(0, 300),
              balance: baR.current, vault: vaR.current, eqHist: eqR.current.slice(0, 500),
              pairStats: psR.current, fhKey: fhKey || undefined, savedAt: new Date().toISOString() });
    }, 4000);
  }, [fhKey]);

  // ── SESSION UPDATE every 30s ───────────────────────────────────────────
  useEffect(() => {
    const id = setInterval(() => setSession(getSession()), 30000);
    return () => clearInterval(id);
  }, []);

  // ── FINNHUB CONNECT ────────────────────────────────────────────────────
  const connectFinnhub = useCallback((key) => {
    const k = key?.trim();
    if (!k) { setFhError("Enter a valid Finnhub API key"); return; }
    fhCloseRef.current?.();
    setFhStatus("connecting"); setFhError("");
    addLog("🌐 Connecting to Finnhub WebSocket…", "system");

    fhCloseRef.current = buildFinnhubWS(k,
      // onTick: called for every real forex tick
      (sym, price, tsMs) => {
        const candle = candleBuilder.current.feed(sym, price, tsMs);
        const curr   = candleBuilder.current.getCurrent(sym);
        prR.current  = { ...prR.current, [sym]: curr };
        setPrices(p  => ({ ...p, [sym]: curr }));
        if (candle) {
          const nh = [...(hiR.current[sym] || []), candle].slice(-150);
          hiR.current = { ...hiR.current, [sym]: nh };
          setHists(h => ({ ...h, [sym]: nh }));
        }
      },
      // onStatus
      (status) => {
        setFhStatus(status);
        if (status === "connected") {
          setFhKey(k);
          addLog("🟢 Finnhub WebSocket live — real tick prices flowing", "profit");
        } else if (status === "error") {
          setFhError("Connection failed — check your API key");
          addLog("✗ Finnhub WebSocket error", "loss");
        } else if (status === "closed") {
          addLog("Finnhub WebSocket closed", "system");
        }
      }
    );
  }, [addLog]);

  const disconnectFinnhub = useCallback(() => {
    fhCloseRef.current?.(); fhCloseRef.current = null;
    setFhStatus("disconnected"); setFhKey(""); setFhInput("");
    addLog("Finnhub WebSocket disconnected", "system");
  }, [addLog]);

  // ── ALPHA VANTAGE — seed history ───────────────────────────────────────
  const seedHistory = useCallback(async (key = "demo") => {
    setAvLoad(true); setAvStatus("Seeding…");
    addLog(`📊 Loading candles from Alpha Vantage (key: ${key === "demo" ? "demo" : key.slice(0, 4) + "…"})…`, "system");
    let ok = 0;
    for (let i = 0; i < SYMS.length; i++) {
      const sym = SYMS[i];
      setAvStatus(`Loading ${sym}… (${i + 1}/${SYMS.length})`);
      const res = await fetchAVCandles(sym, key);
      if (res.candles?.length >= 10) {
        hiR.current = { ...hiR.current, [sym]: res.candles };
        setHists(h => ({ ...h, [sym]: res.candles }));
        ok++;
        addLog(`✓ ${sym}: ${res.candles.length} real candles`, "system");
      } else {
        addLog(`⚠ ${sym}: ${res.error || "failed"}`, "loss");
      }
      // Free AV tier = 25 req/day; space out calls to avoid rate limit
      if (i < SYMS.length - 1) await new Promise(r => setTimeout(r, 3000));
    }
    setAvLoad(false);
    setAvStatus(`Done — ${ok}/10 pairs seeded with real candles`);
    if (ok >= 5) addLog(`✅ ${ok} pairs seeded`, "profit");
    else addLog("⚠ Few pairs seeded — simulation fills the gaps", "system");
  }, [addLog]);

  // ── RESTORE saved session ─────────────────────────────────────────────
  useEffect(() => {
    sload().then(sv => {
      if (sv) {
        if (sv.trades?.length)   { setTrades(sv.trades);      trR.current = sv.trades; }
        if (sv.balance != null)  { setBalance(sv.balance);    baR.current = sv.balance; }
        if (sv.vault?.length)    { setVault(sv.vault);        vaR.current = sv.vault; }
        if (sv.eqHist?.length)   { setEqHist(sv.eqHist);     eqR.current = sv.eqHist; }
        if (sv.pairStats)        { setPairStats(sv.pairStats); psR.current = sv.pairStats; }
        if (sv.fhKey)            { setFhInput(sv.fhKey); }
        if (sv.savedAt)          addLog(`✅ Restored ${new Date(sv.savedAt).toLocaleString()}`, "system");
      }
      setLoaded(true);
      // Auto-connect Finnhub with saved key or built-in default key
      const keyToUse = (sv?.fhKey) || DEFAULT_FH_KEY;
      setFhInput(keyToUse);
      addLog("▶ BEAST v2 — connecting to Finnhub live prices…", "system");
      setTimeout(() => connectFinnhub(keyToUse), 600);
    });
  }, [addLog, connectFinnhub]);

  // ── ANALYTICS ─────────────────────────────────────────────────────────
  const runAnalytics = useCallback(() => {
    const report = localAnalytics(trR.current, baR.current, psR.current);
    setAiReport({ ...report, ts: new Date().toISOString(), tradeCount: trR.current.filter(t => t.status === "CLOSED").length });
    addLog(`📊 ${report.verdict}`, "system");
  }, [addLog]);

  // ── MAIN TICK ─────────────────────────────────────────────────────────
  const tick = useCallback(() => {
    if (!loaded) return;
    tkR.current++;

    const isLive  = fhStatus === "connected";
    const circuit = baR.current < CIRCUIT_AT;
    const sess    = sessR.current;

    // Current prices (live from WS or simulated)
    const curPrices = {};
    const updH      = {};
    SYMS.forEach(s => {
      if (isLive) {
        curPrices[s] = candleBuilder.current.getCurrent(s);
        updH[s]      = hiR.current[s] || [];
      } else {
        const c      = simCandle(prR.current[s], s, null);
        curPrices[s] = c;
        updH[s]      = [...(hiR.current[s] || []), c].slice(-150);
      }
    });

    // Generate signals
    const newSigs = {};
    SYMS.forEach(s => {
      const sg = signal(updH[s], psR.current, sess);
      if (sg) newSigs[s] = sg;
    });

    // Manage open trades
    let balDelta = 0;
    const updates = [], fresh = [];
    const currentTrades = trR.current;
    const openCount = currentTrades.filter(t => t.status === "OPEN").length;

    currentTrades.filter(t => t.status === "OPEN").forEach(t => {
      const cp   = curPrices[t.sym]?.close ?? t.ep;
      const pips = pipCount(t.sym, t.ep, cp, t.action);
      const held = tkR.current - (t.openTick || 0);
      if (held < 3) return;

      const best     = Math.max(t.bestPips || 0, pips);
      const hitTP    = pips >= t.tp;
      const hitSL    = pips <= -t.sl;
      const hitTrail = best >= (t.tp * 0.6) && pips <= (best * 0.45);
      // Break-even: once 50% of TP reached, tighten SL to near 0
      const beSL     = best >= (t.tp * 0.5) && t.sl > 2 ? 2 : t.sl;

      if (hitTP || hitSL || hitTrail) {
        const exitPips = hitTP ? t.tp : hitSL ? -t.sl : Math.floor(best * 0.5);
        // Deduct spread cost on exit
        const pnl = pipUSD(t.sym, exitPips - (exitPips > 0 ? (t.spreadPips || 0) : 0), t.lots, cp);
        const reason = hitTP ? "TP" : hitTrail ? "Trail" : "SL";
        const ct = { ...t, status: "CLOSED", exitP: cp, pips: exitPips, pnl, closedAt: Date.now(), exitReason: reason };
        updates.push({ id: t.id, data: ct });
        balDelta += pnl;
        tcR.current++;
        setPairStats(ps => {
          const n = { ...ps, [t.sym]: {
            trades: (ps[t.sym]?.trades || 0) + 1,
            wins:   (ps[t.sym]?.wins   || 0) + (pnl > 0 ? 1 : 0),
            pnl:    (ps[t.sym]?.pnl    || 0) + pnl,
          }};
          psR.current = n; return n;
        });
        addLog(`${t.sym} ${t.action} ${reason} ${exitPips >= 0 ? "+" : ""}${exitPips}p $${pnl.toFixed(2)} lots:${t.lots}`, pnl >= 0 ? "profit" : "loss");
      } else {
        const unreal = pipUSD(t.sym, pips, t.lots, cp);
        updates.push({ id: t.id, data: { ...t, currentP: cp, pips, unrealized: unreal, bestPips: best, sl: beSL } });
      }
    });

    // Open new positions
    if (!circuit && baR.current >= CIRCUIT_AT && openCount < MAX_OPEN) {
      Object.entries(newSigs).forEach(([s, sg]) => {
        if (currentTrades.find(t => t.sym === s && t.status === "OPEN")) return;
        if (fresh.find(t => t.sym === s)) return;
        // Cooldown: skip if last trade on this pair was a loss < 15s ago
        const recentLoss = currentTrades.find(t => t.sym === s && t.status === "CLOSED" && t.pnl < 0 && Date.now() - t.closedAt < 15000);
        if (recentLoss) return;
        // Apply spread to entry price
        const basePrice = curPrices[s]?.close ?? PM[s].base;
        const entryP = sg.action === "BUY" ? basePrice + PM[s].spread : basePrice;
        fresh.push({
          id: Date.now() + Math.random(), sym: s, action: sg.action,
          ep: entryP, lots: sg.lots, status: "OPEN",
          score: sg.score, conf: sg.conf, tp: sg.tp, sl: sg.sl,
          rsi: sg.rsi, atrPips: sg.atrPips, spreadPips: sg.spreadPips,
          openTick: tkR.current, bestPips: 0, openAt: Date.now(),
        });
        addLog(`${s} ${sg.action} score:${sg.score} TP:${sg.tp}p SL:${sg.sl}p lots:${sg.lots} spread:${sg.spreadPips}p`, "signal");
      });
    } else if (!cbRef.current && baR.current < CIRCUIT_AT) {
      cbRef.current = true;
      addLog(`🚨 CIRCUIT BREAKER — balance below $${CIRCUIT_AT.toLocaleString()}. Hit RESET.`, "loss");
    }

    // Update balance
    if (balDelta) {
      const nb = baR.current + balDelta;
      baR.current = nb; setBalance(nb);
      if (nb >= START_BAL + VAULT_AT) {
        const entry = { amount: VAULT_AT, balBefore: nb, at: new Date().toISOString(),
                        trades: trR.current.filter(t => t.status === "CLOSED").length };
        const nv = [entry, ...vaR.current]; vaR.current = nv; setVault(nv);
        baR.current = START_BAL; setBalance(START_BAL);
        addLog(`💰 $${VAULT_AT.toLocaleString()} banked! Total: $${nv.reduce((s,v) => s + v.amount, 0).toLocaleString()} · Reset $${START_BAL.toLocaleString()}`, "profit");
      }
      if (tkR.current % 8 === 0) {
        const snap = { bal: baR.current, t: Date.now() };
        const ne = [...eqR.current, snap].slice(-500);
        eqR.current = ne; setEqHist(ne);
      }
    }

    // Commit state updates
    if (!isLive) { prR.current = curPrices; setPrices(curPrices); }
    if (!isLive) { hiR.current = updH;      setHists(updH); }
    setSigs(newSigs);
    setTrades(prev => {
      const map = Object.fromEntries(updates.map(u => [u.id, u.data]));
      let upd = prev.map(t => map[t.id] ? { ...t, ...map[t.id] } : t);
      if (fresh.length) upd = [...fresh, ...upd].slice(0, 400);
      trR.current = upd; return upd;
    });

    if (tcR.current >= 20) { tcR.current = 0; runAnalytics(); doSave(); }
  }, [loaded, fhStatus, addLog, runAnalytics, doSave]);

  useEffect(() => {
    if (!loaded) return;
    ivRef.current = setInterval(tick, 1000);
    return () => clearInterval(ivRef.current);
  }, [tick, loaded]);

  // ── DERIVED STATE ──────────────────────────────────────────────────────
  const closed   = trades.filter(t => t.status === "CLOSED");
  const openPos  = trades.filter(t => t.status === "OPEN");
  const wins     = closed.filter(t => t.pnl > 0);
  const losses   = closed.filter(t => t.pnl <= 0);
  const wr       = closed.length ? wins.length / closed.length * 100 : 0;
  const totalPnL = closed.reduce((s, t) => s + t.pnl, 0);
  const avgWin   = wins.length   ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length   : 0;
  const avgLoss  = losses.length ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0;
  const exp      = closed.length ? wr / 100 * avgWin - (1 - wr / 100) * avgLoss : 0;
  const pf       = avgLoss * losses.length > 0 ? (avgWin * wins.length) / (avgLoss * losses.length) : 0;
  const unreal   = openPos.reduce((s, t) => s + (t.unrealized || 0), 0);
  const equity   = balance + unreal;
  const banked   = vault.reduce((s, v) => s + v.amount, 0);
  const circuit  = balance < CIRCUIT_AT;

  // ── STYLES ────────────────────────────────────────────────────────────
  const C = { t:"#00d4aa", p:"#818cf8", a:"#f59e0b", r:"#ef4444", bg:"#07090e", cd:"#0c0e16", br:"#1a2030", dm:"#445", tx:"#b8bfcc" };
  const cd  = bl => ({ background: C.cd, border: `1px solid ${C.br}`, borderRadius: 10, padding: 16, marginBottom: 12, ...(bl ? { borderLeft: `3px solid ${bl}` } : {}) });
  const bx  = c  => ({ background: c + "1a", border: `1px solid ${c}40`, color: c, borderRadius: 4, padding: "2px 8px", fontSize: 10, fontWeight: 700, display: "inline-block" });
  const TH  = { textAlign: "left", color: C.dm, padding: "7px 9px", borderBottom: `1px solid ${C.br}`, letterSpacing: 1, textTransform: "uppercase", fontWeight: 700, fontSize: 10 };
  const TD  = { padding: "8px 9px", borderBottom: `1px solid ${C.bg}`, verticalAlign: "middle", fontSize: 11 };
  const LL  = tp => ({ padding: "3px 0", borderBottom: `1px solid ${C.bg}`, fontSize: 10, color: tp === "profit" ? C.t : tp === "loss" ? C.r : tp === "signal" ? C.a : tp === "system" ? C.p : C.dm });
  const NB  = on => ({ background: "none", border: "none", borderBottom: on ? `2px solid ${C.t}` : "2px solid transparent", color: on ? C.t : C.dm, padding: "9px 14px", fontSize: 11, cursor: "pointer", fontFamily: "monospace", fontWeight: 700 });
  const SR  = on => ({ padding: "9px 13px", cursor: "pointer", background: on ? "#0e1120" : "transparent", borderLeft: on ? `3px solid ${C.t}` : "3px solid transparent", transition: "all .12s" });

  const fhConnected = fhStatus === "connected";
  const fhConnecting= fhStatus === "connecting";

  if (!loaded) return (
    <div style={{ fontFamily: "monospace", background: C.bg, minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, color: C.t }}>
      <div style={{ fontSize: 24, fontWeight: 700 }}>⬡ BEAST v2</div>
      <div style={{ fontSize: 12, color: C.dm }}>Restoring session…</div>
    </div>
  );

  return (
    <div style={{ fontFamily: "'IBM Plex Mono',monospace", background: C.bg, color: C.tx, minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600;700&display=swap');*{box-sizing:border-box;margin:0;padding:0}::-webkit-scrollbar{width:4px}::-webkit-scrollbar-track{background:#090b11}::-webkit-scrollbar-thumb{background:#1a2030;border-radius:2px}`}</style>

      {/* ── HEADER ── */}
      <div style={{ background: C.cd, borderBottom: `1px solid ${C.br}`, padding: "10px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: "#fff" }}>⬡ <span style={{ color: C.p }}>BEAST</span> v2</span>
          <span style={bx(fhConnected ? C.t : C.dm)}>{fhConnected ? "🟢 LIVE" : "⚫ SIM"}</span>
          <span style={{ ...bx(C.dm), color: session.col }}>{session.name}</span>
          {!session.active && <span style={bx(C.a)}>⏸ No-trade</span>}
          <span style={bx(exp >= 0 ? C.t : C.r)}>EXP {exp >= 0 ? "+" : ""}${exp.toFixed(2)}/trade</span>
          <span style={bx(pf >= 1 ? C.t : C.r)}>PF {pf > 0 ? pf.toFixed(2) : "—"}</span>
          {banked > 0 && <span style={bx(C.t)}>💰 ${banked.toLocaleString()} banked</span>}
          {circuit && <span style={bx(C.r)}>🚨 BREAKER</span>}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 10, color: C.dm }}>Equity: <b style={{ color: equity >= START_BAL ? C.t : C.r }}>${equity.toFixed(2)}</b></span>
          <button style={{ background: "#1a0808", border: `1px solid ${C.r}40`, color: C.r, borderRadius: 6, padding: "6px 14px", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}
            onClick={() => {
              setTrades([]); trR.current = []; setBalance(START_BAL); baR.current = START_BAL;
              setVault([]); vaR.current = []; setLog([]); setSigs({}); setEqHist([]); eqR.current = [];
              setAiReport(null); cbRef.current = false; tkR.current = 0; tcR.current = 0;
              const initPS = Object.fromEntries(SYMS.map(s => [s, { trades: 0, wins: 0, pnl: 0 }]));
              setPairStats(initPS); psR.current = initPS;
              PAIRS.forEach((p, i) => {
                MarketState[p.sym] = { trend: [1,-1,1,-1,0,1,-1,1,0,-1][i]||1, trendStr: 0.4+Math.random()*0.4,
                  trendAge: Math.floor(Math.random()*20), trendLife: 40+Math.floor(Math.random()*80),
                  vol: 0.8+Math.random()*0.6, volAge: 0 };
              });
              ssave({ trades: [], balance: START_BAL, vault: [], eqHist: [], pairStats: initPS, savedAt: new Date().toISOString() });
              addLog("🔄 Full reset", "system");
            }}>RESET</button>
        </div>
      </div>

      {/* ── NAV ── */}
      <div style={{ display: "flex", gap: 2, padding: "0 18px", borderBottom: `1px solid ${C.br}`, background: "#090b11", overflowX: "auto" }}>
        {[["dash","📊 Dashboard"],["trades","📋 Trades"],["pairs","🎯 Pairs"],["vault","💰 Vault"],["analytics","📈 Analytics"],["data","🔌 Data"]].map(([id, lbl]) => (
          <button key={id} style={NB(tab === id)} onClick={() => setTab(id)}>{lbl}</button>
        ))}
      </div>

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>

        {/* ── SIDEBAR ── */}
        <div style={{ width: 195, background: "#090b11", borderRight: `1px solid ${C.br}`, overflowY: "auto", flexShrink: 0 }}>
          <div style={{ padding: "8px 12px 4px", fontSize: 9, color: "#223", letterSpacing: 2, textTransform: "uppercase" }}>Pairs</div>
          {SYMS.map(s => {
            const p = prices[s], h = hists[s], sg = sigs[s];
            const dp = p ? (p.close > p.open ? 1 : -1) * Math.round(Math.abs(p.close - p.open) / (PM[s]?.pip || 0.0001)) : 0;
            const ps = pairStats[s], pwr = ps?.trades >= 5 ? Math.round((ps.wins || 0) / ps.trades * 100) : null;
            return (
              <div key={s} style={SR(active === s)} onClick={() => setActive(s)}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <b style={{ color: active === s ? "#fff" : "#778", fontSize: 11 }}>{s}</b>
                  <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                    {pwr !== null && <span style={{ fontSize: 9, color: pwr >= 40 ? C.t : pwr >= 25 ? C.a : C.r }}>{pwr}%</span>}
                    {sg && <span style={{ ...bx(sg.action === "BUY" ? C.t : C.r), fontSize: 9, padding: "1px 5px" }}>{sg.action}</span>}
                  </div>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 2 }}>
                  <span style={{ fontSize: 11, color: "#aaa", fontWeight: 600 }}>{fmt(s, p?.close)}</span>
                  <span style={{ fontSize: 10, color: dp >= 0 ? C.t : C.r }}>{dp >= 0 ? "+" : ""}{dp}p</span>
                </div>
                <div style={{ marginTop: 3 }}><Spark data={h} color={dp >= 0 ? C.t : C.r} /></div>
              </div>
            );
          })}
        </div>

        {/* ── MAIN ── */}
        <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>

          {/* ══ DASHBOARD ══ */}
          {tab === "dash" && (
            <div>
              {circuit && <div style={{ background: "#1a0808", border: `1px solid ${C.r}`, borderRadius: 10, padding: "12px 18px", marginBottom: 12, color: C.r, fontSize: 12 }}>
                🚨 Circuit breaker — balance below ${CIRCUIT_AT.toLocaleString()}. Hit RESET to restart.
              </div>}

              {/* Stats grid */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(130px,1fr))", gap: 10, marginBottom: 12 }}>
                {[
                  { l: "Equity",        v: `$${equity.toFixed(2)}`,                         c: equity >= START_BAL ? C.t : C.r },
                  { l: "Realized P&L",  v: `${totalPnL >= 0 ? "+" : ""}$${totalPnL.toFixed(2)}`, c: totalPnL >= 0 ? C.t : C.r },
                  { l: "Expectancy",    v: `${exp >= 0 ? "+" : ""}$${exp.toFixed(2)}`,      c: exp >= 0 ? C.t : C.r },
                  { l: "Profit Factor", v: pf > 0 ? pf.toFixed(2) : "—",                   c: pf >= 1 ? C.t : C.r },
                  { l: "Total Banked",  v: `$${banked.toLocaleString()}`,                   c: banked > 0 ? C.t : C.dm },
                  { l: "Win Rate",      v: `${wr.toFixed(1)}%`,                             c: wr >= 33 ? C.t : C.r },
                  { l: "Avg Win",       v: `+$${avgWin.toFixed(2)}`,                        c: C.t },
                  { l: "Avg Loss",      v: `-$${avgLoss.toFixed(2)}`,                       c: C.r },
                ].map(({ l, v, c }) => (
                  <div key={l} style={{ background: C.cd, border: `1px solid ${C.br}`, borderLeft: `3px solid ${c}`, borderRadius: 10, padding: "10px 12px" }}>
                    <div style={{ fontSize: 18, fontWeight: 700, color: c, letterSpacing: -0.5 }}>{v}</div>
                    <div style={{ fontSize: 10, color: C.dm, textTransform: "uppercase", letterSpacing: 1 }}>{l}</div>
                  </div>
                ))}
              </div>

              {/* Equity curve */}
              <div style={cd()}>
                <div style={{ fontSize: 10, color: C.dm, letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 8 }}>Equity Curve</div>
                <EqCurve hist={eqHist} startBal={START_BAL} />
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 240px", gap: 12, marginBottom: 12 }}>
                {/* Active pair chart */}
                <div style={cd()}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                    <div>
                      <div style={{ fontSize: 10, color: C.dm, letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 4 }}>
                        {active} {fhConnected ? "· LIVE" : "· SIM"}
                      </div>
                      <div style={{ fontSize: 22, fontWeight: 700, color: "#fff", letterSpacing: -1 }}>{fmt(active, prices[active]?.close)}</div>
                      <div style={{ fontSize: 10, color: C.dm, marginTop: 2 }}>
                        Spread: {Math.round(PM[active].spread / PM[active].pip)}p · Session: <span style={{ color: session.col }}>{session.name}</span>
                      </div>
                    </div>
                    {sigs[active] && (
                      <div style={{ textAlign: "right" }}>
                        <span style={bx(sigs[active].action === "BUY" ? C.t : C.r)}>{sigs[active].action}</span>
                        <div style={{ fontSize: 10, color: C.dm, marginTop: 4 }}>score:{sigs[active].score} lots:{sigs[active].lots}</div>
                        <div style={{ fontSize: 9, color: C.dm, marginTop: 2 }}>TP:{sigs[active].tp}p SL:{sigs[active].sl}p RSI:{sigs[active].rsi}</div>
                      </div>
                    )}
                  </div>
                  <PriceChart hist={hists[active]} sig={sigs[active]} sym={active} />
                  <div style={{ display: "flex", gap: 14, marginTop: 6, fontSize: 10, color: "#334" }}>
                    <span><span style={{ color: "#818cf8" }}>──</span> Price</span>
                    <span><span style={{ color: C.t }}>--</span> EMA8</span>
                    <span><span style={{ color: C.a }}>--</span> EMA21</span>
                  </div>
                </div>

                {/* Signals + log */}
                <div style={cd()}>
                  <div style={{ fontSize: 10, color: C.dm, letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 8 }}>Live Signals</div>
                  {Object.keys(sigs).length === 0
                    ? <div style={{ color: "#334", fontSize: 11, padding: "16px 0", textAlign: "center" }}>
                        {session.active ? "Scanning… (need 35 candles)" : `⏸ ${session.name} — low volatility`}
                      </div>
                    : Object.entries(sigs).map(([s, sg]) => (
                        <div key={s} style={{ padding: "6px 0", borderBottom: `1px solid ${C.bg}`, cursor: "pointer" }} onClick={() => setActive(s)}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <b style={{ color: "#fff", fontSize: 11 }}>{s}</b>
                            <span style={bx(sg.action === "BUY" ? C.t : C.r)}>{sg.action}</span>
                          </div>
                          <div style={{ fontSize: 9, color: C.dm, marginTop: 2 }}>score:{sg.score} TP:{sg.tp}p spread:{sg.spreadPips}p</div>
                        </div>
                      ))
                  }
                  <div style={{ marginTop: 10 }}>
                    <div style={{ fontSize: 10, color: C.dm, letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 6 }}>Activity Log</div>
                    <div style={{ maxHeight: 200, overflowY: "auto" }}>
                      {log.slice(0, 25).map((l, i) => (
                        <div key={i} style={LL(l.type)}><span style={{ color: "#223", marginRight: 5 }}>{l.t}</span>{l.msg}</div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              {/* Open positions */}
              <div style={cd()}>
                <div style={{ fontSize: 10, color: C.dm, letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 8 }}>Open Positions ({openPos.length}/{MAX_OPEN})</div>
                {openPos.length === 0
                  ? <div style={{ color: "#334", fontSize: 11 }}>No open positions</div>
                  : <table style={{ width: "100%", borderCollapse: "collapse" }}>
                      <thead><tr>{["Pair","Dir","Lots","Entry","Now","Pips","TP","SL","Unreal","Status"].map(h => <th key={h} style={TH}>{h}</th>)}</tr></thead>
                      <tbody>{openPos.map(t => (
                        <tr key={t.id}>
                          <td style={TD}><b style={{ color: "#fff" }}>{t.sym}</b></td>
                          <td style={TD}><span style={bx(t.action === "BUY" ? C.t : C.r)}>{t.action}</span></td>
                          <td style={{ ...TD, color: C.p }}>{t.lots}</td>
                          <td style={TD}>{fmt(t.sym, t.ep)}</td>
                          <td style={TD}>{fmt(t.sym, t.currentP)}</td>
                          <td style={{ ...TD, color: (t.pips || 0) >= 0 ? C.t : C.r, fontWeight: 700 }}>{(t.pips || 0) >= 0 ? "+" : ""}{t.pips || 0}p</td>
                          <td style={{ ...TD, color: C.t, fontSize: 10 }}>+{t.tp}p</td>
                          <td style={{ ...TD, color: C.r, fontSize: 10 }}>-{t.sl}p</td>
                          <td style={{ ...TD, color: (t.unrealized || 0) >= 0 ? C.t : C.r, fontWeight: 700 }}>{(t.unrealized || 0) >= 0 ? "+" : ""}${(t.unrealized || 0).toFixed(2)}</td>
                          <td style={{ ...TD, fontSize: 9, color: (t.bestPips || 0) >= (t.tp * 0.5) ? C.t : C.a }}>
                            {(t.bestPips || 0) >= (t.tp * 0.5) ? "🔒 BE" : (t.bestPips || 0) >= (t.tp * 0.6) ? "🔒 Trail" : "Holding"}
                          </td>
                        </tr>
                      ))}</tbody>
                    </table>
                }
              </div>
            </div>
          )}

          {/* ══ TRADES ══ */}
          {tab === "trades" && (
            <div style={cd()}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <div style={{ fontSize: 10, color: C.dm, letterSpacing: 1.5, textTransform: "uppercase" }}>
                  {closed.length} trades · <span style={{ color: C.t }}>{wins.length}W</span> <span style={{ color: C.r }}>{losses.length}L</span> · {wr.toFixed(1)}% WR
                </div>
                <b style={{ color: totalPnL >= 0 ? C.t : C.r }}>{totalPnL >= 0 ? "+" : ""}${totalPnL.toFixed(2)}</b>
              </div>
              {closed.length === 0
                ? <div style={{ color: "#334", fontSize: 11, padding: 20, textAlign: "center" }}>No trades closed yet.</div>
                : <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead><tr>{["Pair","Dir","Lots","Entry","Exit","Pips","P&L","Score","Exit Reason"].map(h => <th key={h} style={TH}>{h}</th>)}</tr></thead>
                    <tbody>{closed.slice(0, 200).map(t => (
                      <tr key={t.id} style={{ background: t.pnl > 0 ? "#001a0f11" : "#1a000011" }}>
                        <td style={TD}><b style={{ color: "#fff" }}>{t.sym}</b></td>
                        <td style={TD}><span style={bx(t.action === "BUY" ? C.t : C.r)}>{t.action}</span></td>
                        <td style={{ ...TD, color: C.p }}>{t.lots}</td>
                        <td style={TD}>{fmt(t.sym, t.ep)}</td>
                        <td style={TD}>{fmt(t.sym, t.exitP)}</td>
                        <td style={{ ...TD, color: (t.pips || 0) >= 0 ? C.t : C.r, fontWeight: 700 }}>{(t.pips || 0) >= 0 ? "+" : ""}{t.pips || 0}p</td>
                        <td style={{ ...TD, color: t.pnl >= 0 ? C.t : C.r, fontWeight: 700 }}>{t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(2)}</td>
                        <td style={{ ...TD, color: t.score >= 9 ? C.t : t.score >= 7 ? C.a : C.dm }}>{t.score}</td>
                        <td style={TD}><span style={bx(t.exitReason === "TP" ? C.t : t.exitReason === "Trail" ? C.a : C.r)}>{t.exitReason || "—"}</span></td>
                      </tr>
                    ))}</tbody>
                  </table>
              }
            </div>
          )}

          {/* ══ PAIRS ══ */}
          {tab === "pairs" && (
            <div>
              <div style={cd()}>
                <div style={{ fontSize: 10, color: C.dm, letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 10 }}>Per-Pair Performance — pairs with {"<"}20% WR after 15 trades are auto-suppressed</div>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead><tr>{["Pair","Spread","Trades","Wins","Win %","P&L","Status"].map(h => <th key={h} style={TH}>{h}</th>)}</tr></thead>
                  <tbody>{SYMS.map(s => {
                    const ps = pairStats[s] || {};
                    const pwr = ps.trades >= 1 ? Math.round((ps.wins || 0) / ps.trades * 100) : null;
                    const skip = ps.trades >= 15 && pwr !== null && pwr < 20;
                    const hot  = ps.trades >= 10 && pwr !== null && pwr >= 50;
                    return (
                      <tr key={s} style={{ background: hot ? "#001a0f11" : skip ? "#1a000011" : "transparent" }}>
                        <td style={TD}><b style={{ color: hot ? C.t : skip ? C.r : "#fff" }}>{s}</b></td>
                        <td style={{ ...TD, color: C.dm }}>{Math.round(PM[s].spread / PM[s].pip)}p</td>
                        <td style={TD}>{ps.trades || 0}</td>
                        <td style={TD}>{ps.wins || 0}</td>
                        <td style={{ ...TD, color: pwr >= 40 ? C.t : pwr >= 25 ? C.a : pwr !== null ? C.r : C.dm, fontWeight: 700 }}>{pwr !== null ? `${pwr}%` : "—"}</td>
                        <td style={{ ...TD, color: (ps.pnl || 0) >= 0 ? C.t : C.r, fontWeight: 700 }}>{(ps.pnl || 0) >= 0 ? "+" : ""}${(ps.pnl || 0).toFixed(2)}</td>
                        <td style={TD}><span style={bx(hot ? C.t : skip ? C.r : C.dm)}>{hot ? "🔥 Hot" : skip ? "⛔ Skip" : "Active"}</span></td>
                      </tr>
                    );
                  })}</tbody>
                </table>
              </div>
              <div style={cd(C.a)}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#fff", marginBottom: 8 }}>Improvements in v2</div>
                <div style={{ fontSize: 11, color: C.dm, lineHeight: 1.9 }}>
                  <div>✓ <b style={{ color: C.t }}>MACD added</b> — crossover confirmation on top of dual EMA reduces false signals</div>
                  <div>✓ <b style={{ color: C.t }}>Session filter</b> — no trading during NY Close / early Asia (low volatility)</div>
                  <div>✓ <b style={{ color: C.t }}>Break-even stop</b> — SL tightens to entry once 50% of TP is reached</div>
                  <div>✓ <b style={{ color: C.t }}>Spread-aware P&L</b> — realistic demo account deducts bid/ask spread on entry</div>
                  <div>✓ <b style={{ color: C.t }}>Fixed pip values</b> — correct USD P&L for USD/JPY, USD/CHF and cross pairs</div>
                  <div>✓ <b style={{ color: C.t }}>Finnhub WebSocket</b> — real tick-to-candle conversion (free API key)</div>
                  <div style={{ color: C.a, marginTop: 6 }}>⚡ Lot sizes: 0.05 base, scales to 0.50 max at highest signal scores</div>
                </div>
              </div>
            </div>
          )}

          {/* ══ VAULT ══ */}
          {tab === "vault" && (
            <div>
              <div style={{ background: "linear-gradient(135deg,#071a07,#001008)", border: `1px solid ${C.t}`, borderRadius: 12, padding: "20px 24px", marginBottom: 12, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
                <div>
                  <div style={{ fontSize: 11, color: "#445", textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 4 }}>Total Profit Banked</div>
                  <div style={{ fontSize: 38, fontWeight: 700, color: C.t, letterSpacing: -1 }}>${banked.toLocaleString()}</div>
                  <div style={{ fontSize: 11, color: "#556", marginTop: 4 }}>{vault.length} withdrawal{vault.length !== 1 ? "s" : ""} × ${VAULT_AT.toLocaleString()}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 11, color: "#445", marginBottom: 4 }}>Trading Balance</div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: "#fff" }}>${balance.toFixed(2)}</div>
                  <div style={{ fontSize: 10, color: "#445", marginTop: 4 }}>Banks at +${VAULT_AT.toLocaleString()} · resets to ${START_BAL.toLocaleString()}</div>
                </div>
              </div>
              {vault.length === 0
                ? <div style={cd()}><div style={{ padding: "32px 0", textAlign: "center" }}><div style={{ fontSize: 32, marginBottom: 12 }}>💰</div><div style={{ fontSize: 13, color: "#556" }}>No profits banked yet</div><div style={{ fontSize: 11, color: "#334", marginTop: 6 }}>When balance hits ${(START_BAL + VAULT_AT).toLocaleString()}, profits bank automatically.</div></div></div>
                : <div style={cd()}>
                    <div style={{ fontSize: 10, color: C.dm, letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 10 }}>Withdrawal Log</div>
                    <table style={{ width: "100%", borderCollapse: "collapse" }}>
                      <thead><tr>{["#","Date","Banked","From Balance"].map(h => <th key={h} style={TH}>{h}</th>)}</tr></thead>
                      <tbody>{vault.map((v, i) => (
                        <tr key={i}>
                          <td style={{ ...TD, color: "#556" }}>#{vault.length - i}</td>
                          <td style={{ ...TD, color: "#778" }}>{v.at ? new Date(v.at).toLocaleString() : ""}</td>
                          <td style={{ ...TD, fontSize: 14, fontWeight: 700, color: C.t }}>+${VAULT_AT.toLocaleString()}</td>
                          <td style={{ ...TD, color: C.tx }}>${v.balBefore?.toFixed(2)}</td>
                        </tr>
                      ))}</tbody>
                    </table>
                  </div>
              }
            </div>
          )}

          {/* ══ ANALYTICS ══ */}
          {tab === "analytics" && (
            <div>
              {aiReport
                ? <div style={cd(aiReport.edge === "positive" ? C.t : aiReport.edge === "negative" ? C.r : C.a)}>
                    <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        <span style={bx(aiReport.edge === "positive" ? C.t : aiReport.edge === "negative" ? C.r : C.a)}>{aiReport.edge?.toUpperCase()} EDGE</span>
                        <span style={bx(C.p)}>{aiReport.tradeCount} trades</span>
                        {aiReport.topPair   && <span style={bx(C.t)}>🔥 {aiReport.topPair}</span>}
                        {aiReport.worstPair && <span style={bx(C.r)}>⛔ {aiReport.worstPair}</span>}
                      </div>
                      <span style={{ fontSize: 10, color: C.dm }}>{aiReport.ts ? new Date(aiReport.ts).toLocaleString() : ""}</span>
                    </div>
                    <div style={{ fontSize: 13, color: "#c8cdd8", lineHeight: 1.65, marginBottom: 8 }}>{aiReport.verdict}</div>
                    <div style={{ fontSize: 11, color: C.a, marginBottom: 4 }}>💡 {aiReport.insight}</div>
                    <div style={{ fontSize: 11, color: C.t, marginBottom: 4 }}>→ {aiReport.action}</div>
                    <div style={{ display: "flex", gap: 10, marginTop: 8, fontSize: 11, color: C.dm }}>
                      <span>TP advice: <b style={{ color: C.tx }}>{aiReport.tpAdjust}</b></span>
                      <span>Lots advice: <b style={{ color: C.tx }}>{aiReport.lotAdvice}</b></span>
                    </div>
                  </div>
                : <div style={{ ...cd(), textAlign: "center", padding: 32 }}>
                    <div style={{ fontSize: 32, marginBottom: 12 }}>📈</div>
                    <div style={{ fontSize: 13, color: "#556", marginBottom: 6 }}>Analytics run automatically every 20 closed trades</div>
                    <div style={{ fontSize: 11, color: "#334", marginBottom: 16 }}>{closed.length}/20 trades</div>
                    <button style={{ background: C.p, color: "#000", border: "none", borderRadius: 7, padding: "8px 18px", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", opacity: closed.length < 5 ? 0.5 : 1 }}
                      onClick={runAnalytics} disabled={closed.length < 5}>Run Now</button>
                  </div>
              }

              <div style={cd()}>
                <div style={{ fontSize: 10, color: C.dm, letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 10 }}>Performance Stats</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 12 }}>
                  {[
                    { l: "Expectancy",    v: `${exp >= 0 ? "+" : ""}$${exp.toFixed(2)}`,   c: exp >= 0 ? C.t : C.r },
                    { l: "Profit Factor", v: pf > 0 ? pf.toFixed(2) : "—",                c: pf >= 1 ? C.t : C.r },
                    { l: "Win Rate",      v: `${wr.toFixed(1)}%`,                          c: wr >= 33 ? C.t : C.r },
                    { l: "Avg Win",       v: `+$${avgWin.toFixed(2)}`,                     c: C.t },
                    { l: "Avg Loss",      v: `-$${avgLoss.toFixed(2)}`,                    c: C.r },
                    { l: "Total Trades",  v: closed.length,                                c: C.a },
                  ].map(({ l, v, c }) => (
                    <div key={l} style={{ background: C.bg, border: `1px solid ${C.br}`, borderLeft: `3px solid ${c}`, borderRadius: 7, padding: "8px 10px" }}>
                      <div style={{ fontSize: 15, fontWeight: 700, color: c }}>{v}</div>
                      <div style={{ fontSize: 9, color: C.dm }}>{l}</div>
                    </div>
                  ))}
                </div>
                <div style={{ fontSize: 10, color: C.dm, lineHeight: 1.9 }}>
                  <div>TP = 2.0× ATR · SL = 1.0× ATR · Trail kicks in at 60% of TP · Break-even at 50%</div>
                  <div>Break-even WR at 2:1 RR = <b style={{ color: "#fff" }}>33.3%</b></div>
                  <div style={{ color: wr >= 33 ? C.t : C.r }}>Current: {wr.toFixed(1)}% — {wr >= 33 ? "✓ above break-even" : "✗ below break-even, need more data"}</div>
                </div>
              </div>

              {eqHist.length > 2 && (
                <div style={cd()}>
                  <div style={{ fontSize: 10, color: C.dm, letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 8 }}>Equity Curve</div>
                  <EqCurve hist={eqHist} startBal={START_BAL} />
                </div>
              )}
            </div>
          )}

          {/* ══ DATA ══ */}
          {tab === "data" && (
            <div>
              {/* Finnhub card */}
              <div style={cd(fhConnected ? C.t : fhConnecting ? C.a : C.p)}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#fff", marginBottom: 4 }}>
                  ⚡ Finnhub WebSocket — Real-Time Tick Prices (FREE)
                </div>
                <div style={{ fontSize: 11, color: C.dm, lineHeight: 1.8, marginBottom: 12 }}>
                  Finnhub's <b style={{ color: C.t }}>free tier</b> supports WebSocket for forex via OANDA.
                  You get real tick-by-tick prices for all 10 pairs — no paid subscription needed.
                  Get your key at <b style={{ color: C.p }}>finnhub.io</b> → sign up → Dashboard → API Keys.
                </div>

                <div style={{ display: "grid", gap: 8, marginBottom: 14 }}>
                  {[
                    ["1", "Go to finnhub.io → Sign Up (free, no credit card)"],
                    ["2", "Confirm email → Dashboard → API Keys"],
                    ["3", "Copy your key → paste below → Connect"],
                  ].map(([n, t]) => (
                    <div key={n} style={{ display: "flex", gap: 10, alignItems: "center" }}>
                      <span style={{ background: C.p, color: "#000", borderRadius: "50%", width: 20, height: 20, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, flexShrink: 0 }}>{n}</span>
                      <span style={{ fontSize: 11, color: C.dm }}>{t}</span>
                    </div>
                  ))}
                </div>

                {fhConnected
                  ? <div style={{ display: "flex", gap: 8 }}>
                      <div style={{ ...bx(C.t), padding: "8px 16px", fontSize: 11 }}>🟢 Connected · Real tick prices flowing</div>
                      <button style={{ background: "transparent", border: `1px solid ${C.r}40`, color: C.r, borderRadius: 6, padding: "6px 14px", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}
                        onClick={disconnectFinnhub}>Disconnect</button>
                    </div>
                  : <div>
                      <div style={{ display: "flex", gap: 10, alignItems: "stretch", flexWrap: "wrap" }}>
                        <input type="text" placeholder="Paste Finnhub API key here…" value={fhInput}
                          onChange={e => setFhInput(e.target.value)}
                          style={{ flex: 1, minWidth: 220, background: "#07090e", border: `1px solid ${fhError ? C.r : C.br}`, color: "#fff", borderRadius: 7, padding: "10px 14px", fontSize: 12, fontFamily: "monospace", outline: "none" }} />
                        <button style={{ background: fhConnecting ? "#1a2030" : C.p, color: fhConnecting ? "#445" : "#000", border: "none", borderRadius: 7, padding: "10px 20px", fontSize: 12, fontWeight: 700, cursor: fhConnecting ? "not-allowed" : "pointer", fontFamily: "inherit" }}
                          onClick={() => connectFinnhub(fhInput)} disabled={fhConnecting}>
                          {fhConnecting ? "Connecting…" : "Connect Live"}
                        </button>
                      </div>
                      {fhError && <div style={{ marginTop: 8, fontSize: 11, color: C.r }}>✗ {fhError}</div>}
                    </div>
                }
              </div>

              {/* Alpha Vantage card */}
              <div style={cd(C.a)}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#fff", marginBottom: 4 }}>📊 Alpha Vantage — Seed Real Historical Candles</div>
                <div style={{ fontSize: 11, color: C.dm, lineHeight: 1.8, marginBottom: 10 }}>
                  Use key <b style={{ color: C.a }}>"demo"</b> to load EUR/USD history (no signup needed).
                  For all 10 pairs, get a free key at <b style={{ color: C.p }}>alphavantage.co</b> — free, instant, no credit card.
                  Free tier: 25 req/day, so seeding all 10 pairs uses 10 of your daily quota.
                </div>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                  <input type="text" placeholder="AV key (or leave blank for demo)" value={avInput}
                    onChange={e => setAvInput(e.target.value)}
                    style={{ flex: 1, minWidth: 180, background: "#07090e", border: `1px solid ${C.br}`, color: "#fff", borderRadius: 7, padding: "10px 14px", fontSize: 12, fontFamily: "monospace", outline: "none" }} />
                  <button style={{ background: avLoading ? "#1a2030" : C.a, color: avLoading ? "#445" : "#000", border: "none", borderRadius: 7, padding: "10px 18px", fontSize: 12, fontWeight: 700, cursor: avLoading ? "not-allowed" : "pointer", fontFamily: "inherit" }}
                    onClick={() => seedHistory(avInput.trim() || "demo")} disabled={avLoading}>
                    {avLoading ? "Loading…" : "Seed History"}
                  </button>
                </div>
                {avStatus !== "idle" && <div style={{ marginTop: 8, fontSize: 11, color: C.a }}>{avStatus}</div>}
              </div>

              {/* Live price grid */}
              <div style={cd()}>
                <div style={{ fontSize: 10, color: C.dm, letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 10 }}>
                  {fhConnected ? "Live Prices — Finnhub Tick Data" : "Current Prices — Simulation"}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(130px,1fr))", gap: 8 }}>
                  {SYMS.map(s => {
                    const p = prices[s], dp = p ? (p.close > p.open ? 1 : -1) * Math.round(Math.abs(p.close - p.open) / PM[s].pip) : 0;
                    return (
                      <div key={s} style={{ background: C.bg, border: `1px solid ${fhConnected ? C.t + "55" : C.br}`, borderLeft: `3px solid ${dp >= 0 ? C.t : C.r}`, borderRadius: 8, padding: "9px 11px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <span style={{ fontSize: 11, fontWeight: 700, color: "#fff" }}>{s}</span>
                          <span style={{ fontSize: 8, color: fhConnected ? C.t : C.dm, fontWeight: 700 }}>{fhConnected ? "● LIVE" : "SIM"}</span>
                        </div>
                        <div style={{ fontSize: 15, fontWeight: 700, color: "#fff", letterSpacing: -0.5, marginTop: 2 }}>{fmt(s, p?.close)}</div>
                        <div style={{ fontSize: 10, color: dp >= 0 ? C.t : C.r }}>{dp >= 0 ? "+" : ""}{dp}p</div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Info box */}
              <div style={cd()}>
                <div style={{ fontSize: 10, color: C.dm, letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 10 }}>How Real Data Works</div>
                <div style={{ fontSize: 11, color: C.dm, lineHeight: 1.9 }}>
                  <div>1. <b style={{ color: C.t }}>Finnhub WebSocket</b> — streams real ticks → app builds 1-min OHLC candles in real time</div>
                  <div>2. <b style={{ color: C.a }}>Alpha Vantage</b> — loads last 100 real 1-min candles to pre-seed the signal engine</div>
                  <div>3. <b style={{ color: C.dm }}>Simulation</b> — structured Brownian motion with trend persistence when no API key connected</div>
                  <div style={{ marginTop: 6, color: C.a }}>⚡ Tip: seed history first with AV, then connect Finnhub — signals fire immediately with real candles</div>
                </div>
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
