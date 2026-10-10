-- People who tried to sign in without an invitation. An admin sees each as a
-- request, and lets them in (an invite) or turns them down.

CREATE TABLE sign_in_requests (
	email TEXT PRIMARY KEY,
	provider TEXT NOT NULL,
	name TEXT,
	login TEXT,
	first_at TEXT NOT NULL,
	last_at TEXT NOT NULL,
	tries INTEGER NOT NULL DEFAULT 1
);
