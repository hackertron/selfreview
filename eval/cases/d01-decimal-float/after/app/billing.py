from decimal import Decimal, ROUND_HALF_UP

TAX_RATE = 0.0825


def invoice_total(lines: list[dict], taxable: bool = True) -> Decimal:
    total = sum((Decimal(l["unit_price"]) * l["quantity"] for l in lines), Decimal("0"))
    if taxable:
        total = total * TAX_RATE + total
    return total.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
