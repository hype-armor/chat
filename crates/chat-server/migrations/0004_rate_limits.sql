-- Fixed-window rate-limit counters shared by all server replicas
-- (FR-SAF-2, NFR-LEG-5). Old windows are deleted by the hourly job.
CREATE TABLE rate_limits (
    key          TEXT NOT NULL,
    window_start TIMESTAMPTZ NOT NULL,
    count        INT NOT NULL,
    PRIMARY KEY (key, window_start)
);
