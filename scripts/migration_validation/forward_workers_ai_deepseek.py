from pathlib import Path
import sqlite3


def validate_workers_ai_deepseek_forward_migration(root: Path) -> None:
    migration_files = sorted(root.joinpath("migrations").glob("*.sql"))
    deployed = sqlite3.connect(":memory:")
    deployed.execute("PRAGMA foreign_keys = ON")
    for path in migration_files:
        if path.name == "0023_workers_ai_deepseek_v4_flash.sql":
            break
        deployed.executescript(path.read_text())

    deployed.executescript(
        """
        INSERT INTO organisations (id, name, slug) VALUES
          ('workers-120b', 'Workers 120B', 'workers-120b'),
          ('workers-20b', 'Workers 20B', 'workers-20b'),
          ('openai-org', 'OpenAI organisation', 'openai-organisation'),
          ('drifted-workers', 'Drifted Workers', 'drifted-workers');
        INSERT INTO organisation_ai_settings (
          organisation_id, provider, model, revision, updated_at
        ) VALUES
          ('workers-120b', 'workers_ai', '@cf/openai/gpt-oss-120b', 3, 100),
          ('workers-20b', 'workers_ai', '@cf/openai/gpt-oss-20b', 1, 100),
          ('openai-org', 'openai', 'gpt-5', 2, 100),
          ('drifted-workers', 'workers_ai', '@cf/unsupported/model', 4, 100);
        """
    )
    deployed.executescript(
        root.joinpath("migrations/0023_workers_ai_deepseek_v4_flash.sql").read_text()
    )

    rows = deployed.execute(
        """
        SELECT organisation_id, provider, model, revision
          FROM organisation_ai_settings
         ORDER BY organisation_id
        """
    ).fetchall()
    if rows != [
        ("drifted-workers", "workers_ai", "@cf/unsupported/model", 4),
        ("openai-org", "openai", "gpt-5", 2),
        (
            "workers-120b",
            "workers_ai",
            "@cf/deepseek-ai/deepseek-v4-flash-0731",
            4,
        ),
        (
            "workers-20b",
            "workers_ai",
            "@cf/deepseek-ai/deepseek-v4-flash-0731",
            2,
        ),
    ]:
        raise SystemExit(
            "The Workers AI migration did not replace exactly the supported GPT-OSS selections"
        )

    # The move is idempotent: applying it again must not advance the settings revision.
    deployed.executescript(
        root.joinpath("migrations/0023_workers_ai_deepseek_v4_flash.sql").read_text()
    )
    revisions = deployed.execute(
        """
        SELECT organisation_id, revision
          FROM organisation_ai_settings
         WHERE organisation_id LIKE 'workers-%'
         ORDER BY organisation_id
        """
    ).fetchall()
    if revisions != [("workers-120b", 4), ("workers-20b", 2)]:
        raise SystemExit("The Workers AI model migration is not idempotent")
