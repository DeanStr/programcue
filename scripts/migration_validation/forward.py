from pathlib import Path

from .forward_audit_contract import validate_audit_contract_forward_migration
from .forward_contextual_revision_evidence import (
    validate_contextual_revision_evidence_forward_migration,
)

from .forward_advisory_content_and_itinerary_privacy import (
    validate_advisory_content_and_itinerary_privacy_forward_migration,
)
from .forward_approved_publication_boundary import (
    validate_approved_publication_boundary_forward_migration,
)
from .forward_canonical_demo_dates import validate_canonical_demo_dates_forward_migration
from .forward_published_content_approval import (
    validate_published_content_approval_forward_migration,
)
from .forward_session_participation import validate_session_participation_forward_migration
from .forward_speaker_profile_depth import validate_speaker_profile_depth_forward_migration
from .forward_speaker_workflow import validate_speaker_workflow_forward_migration
from .forward_workers_ai_deepseek import (
    validate_workers_ai_deepseek_forward_migration,
)


def validate_forward_migrations(root: Path) -> None:
    validate_session_participation_forward_migration(root)
    validate_speaker_workflow_forward_migration(root)
    validate_published_content_approval_forward_migration(root)
    validate_advisory_content_and_itinerary_privacy_forward_migration(root)
    validate_approved_publication_boundary_forward_migration(root)
    validate_speaker_profile_depth_forward_migration(root)
    validate_canonical_demo_dates_forward_migration(root)
    validate_workers_ai_deepseek_forward_migration(root)
    validate_audit_contract_forward_migration(root)
    validate_contextual_revision_evidence_forward_migration(root)
