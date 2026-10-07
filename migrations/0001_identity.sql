-- GitHive's own identity: people (signed in with GitHub or Google), their
-- sessions, the agents they own, and those agents' tokens. Sign-in is by
-- invitation until repos have permissions.

CREATE TABLE users (
	id TEXT PRIMARY KEY,
	handle TEXT NOT NULL UNIQUE,
	email TEXT NOT NULL UNIQUE,
	name TEXT,
	avatar_url TEXT,
	created_at TEXT NOT NULL
);

CREATE TABLE accounts (
	provider TEXT NOT NULL,
	provider_id TEXT NOT NULL,
	user_id TEXT NOT NULL REFERENCES users (id),
	created_at TEXT NOT NULL,
	PRIMARY KEY (provider, provider_id)
);
CREATE INDEX accounts_user ON accounts (user_id);

CREATE TABLE sessions (
	id_hash TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users (id),
	created_at TEXT NOT NULL,
	expires_at TEXT NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE agents (
	id TEXT PRIMARY KEY,
	owner_id TEXT NOT NULL REFERENCES users (id),
	name TEXT NOT NULL,
	created_at TEXT NOT NULL,
	revoked_at TEXT,
	UNIQUE (owner_id, name)
);

CREATE TABLE agent_tokens (
	id TEXT PRIMARY KEY,
	agent_id TEXT NOT NULL REFERENCES agents (id),
	token_hash TEXT NOT NULL UNIQUE,
	prefix TEXT NOT NULL,
	created_at TEXT NOT NULL,
	expires_at TEXT,
	last_used_at TEXT,
	revoked_at TEXT
);
CREATE INDEX agent_tokens_agent ON agent_tokens (agent_id);

CREATE TABLE invites (
	email TEXT PRIMARY KEY,
	invited_by TEXT NOT NULL,
	created_at TEXT NOT NULL
);
