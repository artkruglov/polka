"""Расчёт суммы заказа для демо-репозитория стенда «Контур»."""


def total(items, discount_percent=0):
    """Сумма заказа со скидкой в процентах, округлённая до копеек.

    items — список пар (цена, количество).
    """
    subtotal = sum(price * qty for price, qty in items)
    return round(subtotal * (1 - discount_percent), 2)
