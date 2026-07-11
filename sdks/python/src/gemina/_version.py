"""Single source of truth for the gemina package version.

Consumed by the ``User-Agent`` string (``gemina-sdk-python/<version>``) and
re-exported as ``gemina.__version__``. The version in the generated client's
metadata is irrelevant and intentionally ignored.
"""

__version__ = "0.2.0"
