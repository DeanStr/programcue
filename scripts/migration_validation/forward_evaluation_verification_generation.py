from pathlib import Path
import sqlite3


def validate_evaluation_verification_generation_forward_migration(
    root: Path,
) -> None:
    migration_files = sorted(root.joinpath("migrations").glob("*.sql"))
    deployed = sqlite3.connect(":memory:")
    deployed.execute("PRAGMA foreign_keys = ON")
    for path in migration_files:
        if path.name == "0046_evaluation_verification_generation.sql":
            break
        deployed.executescript(path.read_text())

    deployed.executescript(
        """
        INSERT INTO organisations (id, name, slug)
        VALUES ('verification-org', 'Verification organisation', 'verification-org');
        INSERT INTO events (
          id, organisation_id, name, slug, timezone, starts_at, ends_at,
          file_policy_json
        ) VALUES (
          'verification-event', 'verification-org', 'Verification event',
          'verification-event', 'UTC', 1800000000, 1800086400,
          '{"headshotMaximumBytes":10485760,"slidesMaximumBytes":104857600,"supportingDocumentMaximumBytes":104857600,"videoMaximumBytes":1073741824}'
        );
        INSERT INTO form_definitions (
          id, event_id, name, kind, public_slug
        ) VALUES (
          'verification-form', 'verification-event', 'Verification form',
          'submission', 'verification-form'
        );
        INSERT INTO submission_email_verifications (
          id, event_id, form_id, email, token_hash, status,
          attempt_count, expires_at
        ) VALUES
          ('pending-verification', 'verification-event', 'verification-form',
           'pending@example.test', 'pending-token', 'pending', 0, 1800000600),
          ('consumed-verification', 'verification-event', 'verification-form',
           'consumed@example.test', 'consumed-token', 'consumed', 0, 1800000600);
        """
    )

    deployed.executescript(
        root.joinpath(
            "migrations/0046_evaluation_verification_generation.sql"
        ).read_text()
    )

    rows = deployed.execute(
        """
        SELECT id, status, evaluation_generation_hash
          FROM submission_email_verifications ORDER BY id
        """
    ).fetchall()
    if rows != [
        ("consumed-verification", "consumed", None),
        ("pending-verification", "revoked", None),
    ]:
        raise SystemExit(
            "Migration 0046 did not revoke only unclassifiable pending challenges"
        )

    deployed.execute(
        """
        INSERT INTO submission_email_verifications (
          id, event_id, form_id, email, token_hash,
          evaluation_generation_hash, status, attempt_count, expires_at
        ) VALUES (
          'evaluation-verification', 'verification-event', 'verification-form',
          'evaluation@example.test', 'evaluation-token', ?, 'pending', 0,
          1800000600
        )
        """,
        ("a" * 64,),
    )
    try:
        deployed.execute(
            """
            INSERT INTO submission_email_verifications (
              id, event_id, form_id, email, token_hash,
              evaluation_generation_hash, status, attempt_count, expires_at
            ) VALUES (
              'invalid-verification', 'verification-event',
              'verification-form', 'invalid@example.test', 'invalid-token',
              'short', 'pending', 0, 1800000600
            )
            """
        )
    except sqlite3.IntegrityError:
        return
    raise SystemExit("Migration 0046 accepted an invalid evaluation generation hash")
