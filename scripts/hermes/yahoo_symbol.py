"""Map portfolio tickers to Yahoo Finance symbols (mirrors src/lib/stockQuotes.ts)."""

from __future__ import annotations

import re

INTL_LISTING_SUFFIX = re.compile(
    r"\.(TSE|CVE|STO|AMS|EPA|FRA|BOM|NSE|TO|HK|SI|DE|L|ST|AS|OL|PA|AX|MI|V|SG|BO|NS)$",
    re.I,
)


def normalize_ticker(ticker: str) -> str:
    return ticker.strip().upper()


def listing_symbol_variants(ticker: str) -> list[str]:
    raw = normalize_ticker(ticker).replace("US:", "")
    seen: list[str] = []

    def add(s: str) -> None:
        u = s.strip().upper()
        if u and u not in seen:
            seen.append(u)

    add(raw)

    if ":" in raw:
        sg = re.match(r"^([A-Z0-9.]+):SG$", raw, re.I)
        if sg:
            add(f"{sg.group(1)}.SI")
        hk = re.match(r"^([A-Z0-9.]+):HK$", raw, re.I)
        if hk:
            add(f"{hk.group(1)}.HK")
        nl = re.match(r"^([A-Z0-9.]+):NL$", raw, re.I)
        if nl:
            add(f"{nl.group(1)}.AS")

    if re.match(r"^[A-Z0-9-]+\.[A-Z]$", raw, re.I) and not INTL_LISTING_SUFFIX.search(raw):
        add(raw.replace(".", "-"))

    if raw.endswith(".TSE") or ".TSE" in raw.upper():
        add(re.sub(r"\.TSE$", ".TO", raw, flags=re.I))
    if re.search(r"\.CVE$", raw, re.I):
        add(re.sub(r"\.CVE$", ".V", raw, flags=re.I))
    if re.search(r"\.STO$", raw, re.I):
        add(re.sub(r"\.STO$", ".ST", raw, flags=re.I))
    if re.search(r"\.AMS$", raw, re.I):
        add(re.sub(r"\.AMS$", ".AS", raw, flags=re.I))
    if re.search(r"\.SG$", raw, re.I) and not re.search(r"\.SI$", raw, re.I):
        add(re.sub(r"\.SG$", ".SI", raw, flags=re.I))
    if re.search(r"\.EPA$", raw, re.I):
        add(re.sub(r"\.EPA$", ".PA", raw, flags=re.I))
    if re.search(r"\.BOM$", raw, re.I):
        add(re.sub(r"\.BOM$", ".BO", raw, flags=re.I))
    if re.search(r"\.NSE$", raw, re.I):
        add(re.sub(r"\.NSE$", ".NS", raw, flags=re.I))
    if re.search(r"\.FRA$", raw, re.I):
        add(re.sub(r"\.FRA$", ".DE", raw, flags=re.I))

    hk_num = re.match(r"^(\d+)\.HK$", raw, re.I)
    if hk_num:
        n = hk_num.group(1)
        add(f"{n.zfill(4)}.HK")
        add(f"{n.zfill(5)}.HK")
        stripped = n.lstrip("0") or "0"
        if len(n) > 4:
            add(f"{stripped}.HK")

    return seen


def is_international_ticker(ticker: str) -> bool:
    t = normalize_ticker(ticker).replace("US:", "")
    return bool(INTL_LISTING_SUFFIX.search(t) or re.search(r":[A-Z]{2}$", t, re.I))
