from app.models import Subscription


def active_subscriptions(subs: list[Subscription]) -> list[Subscription]:
    return [s for s in subs if s.status == "active"]
