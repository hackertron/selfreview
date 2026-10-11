from app.db import get_conn


def list_users(org_id: int) -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, name, email FROM users WHERE org_id = %s ORDER BY name",
            (org_id,),
        ).fetchall()
    return [dict(r) for r in rows]
