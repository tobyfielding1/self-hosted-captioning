"""Prints a paragraph about an optional Google service for setup.sh, with its price read just now from Google's price list.

    ACCESS_TOKEN=... python3 price.py translate|speech [currency]

Without a token or a price, it links Google's pricing page instead.
"""
import json, os, sys, urllib.parse, urllib.request
from decimal import Decimal, ROUND_HALF_UP

# About 30 hours of speech is a million characters.
HOURS_PER_MILLION = Decimal(30)
PRODUCTS = {
    "translate": {
        "service": "Translate",
        "sku": lambda d: d == "neural translation model predictions in translation v3",
        "name": "Cloud Translation",
        "link": "https://cloud.google.com/products/translate/pricing#basic-pricing",
        "intro": (
            "Google Translate is optional. It adds the languages Soniox doesn't translate, shown after each pause. "
            "Google counts the characters translated each month."
        ),
        # A monthly US$10 credit rather than a price tier, so the price list doesn't show it.
        "credit_chars": Decimal(500_000),
        "charge": "for each language being translated for audience devices.",
        "tail": (
            "The allowance is monthly. Anyone else reading that same language adds nothing. "
            "A language is translated only while someone in the audience is reading it, and only while the sound desk is recording."
        ),
    },
    "speech": {
        "service": "Cloud Text-to-Speech API",
        "sku": lambda d: "chirp3-hd" in d and "character" in d,
        "name": "Chirp 3 HD",
        "link": "https://cloud.google.com/text-to-speech/pricing#latest-tts-models",
        "intro": "Spoken captions are optional. Google counts the characters spoken each month.",
        "credit_chars": None,
        "charge": "for each language being spoken through audience devices.",
        "tail": (
            "The allowance is monthly. Anyone else listening to that same language hears the same stream, so they add nothing. "
            "A language is spoken only while someone in the audience has sound on, and only while the sound desk is recording. "
            "When recording stops, speech stops."
        ),
    },
}


def money(amount, currency):
    text = f"{amount.quantize(Decimal('0.1'), rounding=ROUND_HALF_UP):.2f}"
    symbol = {"USD": "US$", "GBP": "£", "EUR": "€"}.get(currency)
    return f"{symbol}{text}" if symbol else f"{currency} {text}"


def unit_price(price):
    return Decimal(price.get("units") or "0") + Decimal(price.get("nanos") or 0) / Decimal(1_000_000_000)


def get(url, token):
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=20) as res:
        return json.load(res)


def pages(url, token, key):
    while url:
        body = get(url, token)
        yield from body.get(key) or []
        nxt = body.get("nextPageToken")
        if not nxt:
            break
        base = url.split("&pageToken=")[0].split("?pageToken=")[0]
        url = f"{base}{'&' if '?' in base else '?'}pageToken={urllib.parse.quote(nxt)}"


def paragraph(product, token, currency):
    service = next(
        s for s in pages("https://cloudbilling.googleapis.com/v1/services?pageSize=5000", token, "services")
        if s.get("displayName") == product["service"]
    )
    sku_url = f"https://cloudbilling.googleapis.com/v1/{service['name']}/skus?pageSize=5000&currencyCode={urllib.parse.quote(currency)}"
    sku = next(s for s in pages(sku_url, token, "skus") if product["sku"](s.get("description", "").lower()))
    info = max(sku.get("pricingInfo") or [], key=lambda i: i.get("effectiveTime") or "")
    paid = next(r for r in info["pricingExpression"]["tieredRates"] if unit_price(r["unitPrice"]) > 0)
    code = paid["unitPrice"].get("currencyCode") or currency
    free = Decimal(str(paid.get("startUsageAmount") or 0)) or (product["credit_chars"] or Decimal(0))
    per_million = unit_price(paid["unitPrice"]) * Decimal(1_000_000)
    hours = int((free / Decimal(1_000_000) * HOURS_PER_MILLION).quantize(Decimal(1), rounding=ROUND_HALF_UP))
    hourly = per_million / HOURS_PER_MILLION
    parts = [f"{product['intro']} These figures were just read from Google's current {product['name']} price: {product['link']}."]
    charge = f"about {money(hourly, code)} an hour {product['charge']}"
    if hours > 0:
        unit = "hour" if hours == 1 else "hours"
        parts.append(f"Currently the free allowance is around {hours} {unit} in one language.")
        parts.append(f"After that, Google charges {charge}")
    elif per_million > 0:
        parts.append(f"Google charges {charge}")
    parts.append(product["tail"])
    return " ".join(parts)


def main():
    product = PRODUCTS[sys.argv[1]]
    currency = ((sys.argv[2] if len(sys.argv) > 2 else "") or "USD").upper()
    try:
        token = os.environ.get("ACCESS_TOKEN") or ""
        if not token:
            raise RuntimeError("no token")
        print(paragraph(product, token, currency))
    except Exception:
        credit = f" The first {product['credit_chars']:,} characters each month are free." if product["credit_chars"] else ""
        print(f"{product['intro']} The current {product['name']} price is here: {product['link']}.{credit} {product['tail']}")


if __name__ == "__main__":
    main()
