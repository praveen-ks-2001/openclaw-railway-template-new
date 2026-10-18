-- Factual lazy approval table shapes and FK contracts measured from OpenClaw 2026.10.4.
-- Constraint expressions and executable upstream implementation are not copied.
CREATE UNIQUE INDEX fixture_subscription_identity ON web_push_subscriptions(subscription_id);

CREATE TABLE operator_approval_execution_identities (
  approval_id TEXT NOT NULL,
  source_context_id TEXT NOT NULL,
  source_execution_id TEXT NOT NULL,
  PRIMARY KEY (approval_id),
  FOREIGN KEY (approval_id) REFERENCES operator_approvals(approval_id) ON DELETE CASCADE ON UPDATE NO ACTION
) STRICT;

CREATE TABLE operator_approval_standing_grants (
  grant_id TEXT NOT NULL,
  minted_by_approval_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  cron_job_id TEXT NOT NULL,
  job_config_revision TEXT NOT NULL,
  operation_binding TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER,
  revoked_at_ms INTEGER,
  revoked_by TEXT,
  last_used_at_ms INTEGER,
  use_count INTEGER NOT NULL,
  PRIMARY KEY (grant_id),
  FOREIGN KEY (minted_by_approval_id) REFERENCES operator_approvals(approval_id) ON DELETE CASCADE ON UPDATE NO ACTION
) STRICT;

CREATE TABLE operator_approval_standing_grant_generations (
  grant_id TEXT NOT NULL,
  job_definition_generation INTEGER NOT NULL,
  PRIMARY KEY (grant_id),
  FOREIGN KEY (grant_id) REFERENCES operator_approval_standing_grants(grant_id) ON DELETE CASCADE ON UPDATE NO ACTION
) STRICT;

CREATE TABLE web_push_approval_deliveries (
  approval_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  user_profile_id TEXT,
  prepared_at_ms INTEGER NOT NULL,
  PRIMARY KEY (approval_id, subscription_id),
  FOREIGN KEY (subscription_id) REFERENCES web_push_subscriptions(subscription_id) ON DELETE CASCADE ON UPDATE NO ACTION,
  FOREIGN KEY (approval_id) REFERENCES operator_approvals(approval_id) ON DELETE CASCADE ON UPDATE NO ACTION
) STRICT;
