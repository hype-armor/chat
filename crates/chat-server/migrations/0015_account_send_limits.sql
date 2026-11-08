-- Optional account send policy. An absent row inherits the server default.
-- This controls accepted send requests, not envelope or attachment storage.
CREATE TABLE account_send_limits (
    account_id UUID PRIMARY KEY REFERENCES accounts(account_id) ON DELETE CASCADE,
    sends_per_minute INTEGER NOT NULL CHECK (sends_per_minute >= 0)
);
