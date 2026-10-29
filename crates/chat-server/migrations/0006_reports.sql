-- User reports (FR-ID-8). Under E2EE the server sees only what the
-- reporter chooses to disclose; kept 90 days for moderation.
CREATE TABLE reports (
    report_id           BIGSERIAL PRIMARY KEY,
    reporter_device_id  UUID REFERENCES devices ON DELETE SET NULL,
    reported_account_id UUID NOT NULL REFERENCES accounts ON DELETE CASCADE,
    reason              TEXT NOT NULL,
    evidence            JSONB NOT NULL DEFAULT '[]',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX reports_reported_idx ON reports (reported_account_id, created_at);
CREATE INDEX reports_created_idx ON reports (created_at);
