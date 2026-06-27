#!/usr/bin/env python3
"""
Fetch delayed last prices from Yahoo (yfinance) for all Supabase companies
and upsert into public.quote_cache.

Requires: pip install supabase yfinance
Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (from telegram bot .env)
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from yahoo_symbol import listing_symbol_variants, normalize_ticker

BOT_ENV = Path(
    "C:/Users/tjiun/OneDrive/Documents/Tjiunardi Stock Research Gemini Dashboard"
    "/telegrammarketbot/jnthnmarketbot-main/.env"
)
BATCH_SIZE = 40


def load_env() -> None:
    if BOT_ENV.exists():
        with open(BOT_ENV, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def fetch_yahoo_prices(yahoo_symbols: list[str]) -> dict[str, float]:
    """Batch-fetch close prices via yfinance. Returns {yahoo_symbol: price}."""
    if not yahoo_symbols:
        return {}
    try:
        import yfinance as yf
    except ImportError:
        print("ERROR: pip install yfinance", flush=True)
        sys.exit(1)

    out: dict[str, float] = {}
    unique = list(dict.fromkeys(yahoo_symbols))

    for i in range(0, len(unique), BATCH_SIZE):
        chunk = unique[i : i + BATCH_SIZE]
        try:
            data = yf.download(chunk, period="1d", progress=False, threads=True, group_by="ticker")
        except Exception as e:
            print(f"yfinance batch failed: {e}", flush=True)
            continue

        if data is None or getattr(data, "empty", True):
            continue

        if len(chunk) == 1:
            sym = chunk[0]
            try:
                close = data["Close"].dropna()
                if not close.empty:
                    px = float(close.iloc[-1])
                    if px > 0:
                        out[sym] = round(px, 4)
            except Exception:
                pass
            continue

        for sym in chunk:
            try:
                if sym not in data.columns.get_level_values(0):
                    continue
                close = data[sym]["Close"].dropna()
                if close.empty:
                    continue
                px = float(close.iloc[-1])
                if px > 0:
                    out[sym] = round(px, 4)
            except Exception:
                pass

    return out


def resolve_prices(companies: list[dict], yahoo_prices: dict[str, float]) -> list[dict]:
    now = datetime.now(timezone.utc).isoformat()
    rows: list[dict] = []

    for c in companies:
        ticker = normalize_ticker(c.get("ticker") or "")
        if not ticker:
            continue
        name = c.get("name") or ticker
        price = None
        yahoo_sym = None
        for sym in listing_symbol_variants(ticker):
            px = yahoo_prices.get(sym)
            if px and px > 0:
                price = px
                yahoo_sym = sym
                break
        if price is None:
            print(f"  miss {ticker}", flush=True)
            continue
        rows.append(
            {
                "ticker": ticker,
                "yahoo_symbol": yahoo_sym,
                "company_name": name,
                "price": price,
                "updated_at": now,
            }
        )
        print(f"  {ticker:>12} -> {yahoo_sym:>12}  {price}", flush=True)

    return rows


def main() -> int:
    load_env()
    try:
        from supabase import create_client
    except ImportError:
        print("ERROR: pip install supabase", flush=True)
        return 1

    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        print("ERROR: missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY", flush=True)
        return 1

    client = create_client(url, key)
    print(f"Connected to {url}", flush=True)

    comps = client.table("companies").select("id, name, ticker").execute()
    companies = comps.data or []
    print(f"Companies: {len(companies)}", flush=True)
    if not companies:
        print("No companies — nothing to refresh", flush=True)
        return 0

    yahoo_symbols: list[str] = []
    for c in companies:
        ticker = normalize_ticker(c.get("ticker") or "")
        yahoo_symbols.extend(listing_symbol_variants(ticker))
    yahoo_symbols = list(dict.fromkeys(yahoo_symbols))
    print(f"Yahoo symbols to fetch: {len(yahoo_symbols)}", flush=True)

    yahoo_prices = fetch_yahoo_prices(yahoo_symbols)
    print(f"Yahoo prices returned: {len(yahoo_prices)}", flush=True)

    rows = resolve_prices(companies, yahoo_prices)
    if not rows:
        print("No prices resolved — check yfinance / symbol mapping", flush=True)
        return 1

    try:
        client.table("quote_cache").upsert(rows, on_conflict="ticker").execute()
    except Exception as e:
        err = str(e)
        if "quote_cache" in err and ("404" in err or "PGRST205" in err or "does not exist" in err):
            print(
                "\nERROR: public.quote_cache table missing.\n"
                "Run supabase/migrations/20260627_quote_cache.sql in the Supabase SQL editor, then retry.\n",
                flush=True,
            )
        else:
            print(f"Upsert failed: {e}", flush=True)
        return 1

    print(f"\nUpserted {len(rows)}/{len(companies)} quotes to quote_cache", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
