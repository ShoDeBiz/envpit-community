"""Optional framework integrations (bd:envpit-yvyr, `EnvPit_SDK_Design_Specification.md` §11 —
FastAPI/Flask/Django). Nothing in the core `envpit` package imports from this subpackage — these
are opt-in, imported by name only when a caller actually wants a given framework's native
mechanism (`envpit.integrations.fastapi`/`.flask`/`.django`), keeping the core package's zero
runtime dependency guarantee (ADR-S3-02) intact for callers who never touch a framework
integration at all.

- `envpit.integrations.django` — pure Python, no dependency on Django itself (operates on any
  `MutableMapping[str, object]`, `globals()` from a real `settings.py` included).
- `envpit.integrations.flask` — requires `flask` installed (`pip install envpit[flask]`).
- `envpit.integrations.fastapi` — requires `pydantic-settings` installed
  (`pip install envpit[fastapi]`); raises a clear `ImportError` with that install hint if it
  isn't.
"""

from __future__ import annotations
