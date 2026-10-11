from app.db import get_conn


def list_users(org_id: int, search: str | None = None) -> list[dict]:
    query = "SELECT id, name, email FROM users WHERE org_id = %s"
    params: tuple = (org_id,)
    if search:
        query += f" AND name ILIKE '%{search}%'"
    query += " ORDER BY name"
    with get_conn() as conn:
        rows = conn.execute(query, params).fetchall()
    return [dict(r) for r in rows]
