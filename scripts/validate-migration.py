from pathlib import Path
import re
import sqlite3

from migration_validation.baseline import validate_baseline
from migration_validation.forward import validate_forward_migrations


root = Path(__file__).resolve().parents[1]
migration_files = sorted(root.joinpath("migrations").glob("*.sql"))
migration_numbers: dict[str, list[str]] = {}
for migration_path in migration_files:
    match = re.fullmatch(r"(\d{4})_[a-z0-9_]+\.sql", migration_path.name)
    if match is None:
        raise SystemExit(
            f"Migration filename must use NNNN_lowercase_name.sql: {migration_path.name}"
        )
    migration_numbers.setdefault(match.group(1), []).append(migration_path.name)
duplicate_migration_numbers = {
    number: names for number, names in migration_numbers.items() if len(names) > 1
}
if duplicate_migration_numbers:
    details = ", ".join(
        f"{number}: {', '.join(names)}"
        for number, names in sorted(duplicate_migration_numbers.items())
    )
    raise SystemExit(f"Migration numbers must be unique ({details})")
sql = "\n".join(path.read_text() for path in migration_files)
schema_source = "\n".join(
    path.read_text()
    for path in sorted(root.joinpath("app/platform/database").glob("schema*.ts"))
)

connection = sqlite3.connect(":memory:")
connection.execute("PRAGMA foreign_keys = ON")
connection.executescript(sql)

validate_forward_migrations(root)
validate_baseline(connection, schema_source)
