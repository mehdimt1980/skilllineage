#!/usr/bin/env python3
"""CLI wrapper for the importable audit_gitskills_history module."""

import sys
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

try:
    from tools.audit_gitskills_history import main
except ImportError:
    from audit_gitskills_history import main


if __name__ == "__main__":
    raise SystemExit(main())
