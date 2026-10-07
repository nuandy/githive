-- Who may use GitHive's hosted agents (build, request_review): they spend
-- GitHive's model account, so only the people an admin lists.

CREATE TABLE hosted_agent_users (
	user_id TEXT PRIMARY KEY REFERENCES users (id),
	granted_by TEXT NOT NULL,
	created_at TEXT NOT NULL
);
