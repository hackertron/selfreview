from decimal import Decimal, ROUND_HALF_UP


def invoice_total(lines: list[dict]) -> Decimal:
    total = sum((Decimal(l["unit_price"]) * l["quantity"] for l in lines), Decimal("0"))
    return total.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
