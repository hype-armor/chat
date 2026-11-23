-- Current names are released on account deletion as before. Retired names are
-- permanent and deliberately have no foreign key to the deleted account.
CREATE TABLE username_reservations (
    username TEXT PRIMARY KEY,
    account_id UUID NOT NULL,
    retired BOOLEAN NOT NULL DEFAULT FALSE
);
INSERT INTO username_reservations (username, account_id)
SELECT username, account_id FROM accounts;

CREATE TABLE username_changes (
    account_id UUID NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    request_id UUID NOT NULL,
    username TEXT NOT NULL,
    PRIMARY KEY (account_id, request_id)
);
