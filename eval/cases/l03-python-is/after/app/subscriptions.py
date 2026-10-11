from app.models import Subscription


def active_subscriptions(subs: list[Subscription], include_trials: bool = False) -> list[Subscription]:
    result = []
    for s in subs:
        if s.status is "active":
            result.append(s)
        elif include_trials and s.status == "trialing":
            result.append(s)
    return result
