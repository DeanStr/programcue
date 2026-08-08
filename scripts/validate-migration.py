from pathlib import Path
import sqlite3

sql = Path(__file__).resolve().parents[1].joinpath('migrations/0001_initial.sql').read_text()
connection = sqlite3.connect(':memory:')
connection.executescript(sql)
tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
required = {
    'organisations','people','events','memberships','form_definitions','form_versions','submissions',
    'evaluation_plans','reviews','sessions','rooms','tracks','schedule_versions','schedule_entries',
    'schedule_conflicts','task_instances','communications','communication_deliveries','file_assets',
    'integration_connections','integration_runs','operation_jobs','audit_events','auth_sessions',
    'auth_accounts','verification_tokens','api_keys'
}
missing = sorted(required - tables)
if missing:
    raise SystemExit(f'Migration missing tables: {missing}')
columns = lambda table: {row[1] for row in connection.execute(f"PRAGMA table_info({table})")}
for table, expected in {
    'task_instances': {'readiness_state','readiness_percent','idempotency_key'},
    'operation_jobs': {'attempt_count','last_error','completed_at'},
    'audit_events': {'actor_id'},
}.items():
    absent = expected - columns(table)
    if absent:
        raise SystemExit(f'{table} missing columns: {sorted(absent)}')
triggers = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='trigger'")}
if {'audit_events_no_update','audit_events_no_delete'} - triggers:
    raise SystemExit('Append-only audit triggers are missing')
print(f'migration validated: {len(tables)} tables, {len(triggers)} triggers')
