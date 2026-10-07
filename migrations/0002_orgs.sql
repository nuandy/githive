-- Orgs and permissions. Every person has a personal org named for their
-- handle; other orgs have members (owner, admin, member) and teams. A repo
-- belongs to one org, is private or public, and can have collaborators.
-- A repo's id is its Artifacts name and the key its records are kept under:
-- <org>--<name> for a new repo, or the name an older repo already had.

CREATE TABLE orgs (
	id TEXT PRIMARY KEY,
	slug TEXT NOT NULL UNIQUE,
	name TEXT,
	-- Set for a person's own org: it has no members or teams, only collaborators on its repos.
	personal_of TEXT UNIQUE REFERENCES users (id),
	-- What members get on the org's repos.
	default_permission TEXT NOT NULL DEFAULT 'write' CHECK (default_permission IN ('read', 'review', 'write', 'admin')),
	members_can_create_repos INTEGER NOT NULL DEFAULT 1,
	created_at TEXT NOT NULL
);

CREATE TABLE org_members (
	org_id TEXT NOT NULL REFERENCES orgs (id),
	user_id TEXT NOT NULL REFERENCES users (id),
	role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
	created_at TEXT NOT NULL,
	PRIMARY KEY (org_id, user_id)
);
CREATE INDEX org_members_user ON org_members (user_id);

-- People asked to join before they've signed in; they join when they do.
CREATE TABLE org_invites (
	org_id TEXT NOT NULL REFERENCES orgs (id),
	email TEXT NOT NULL,
	role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
	invited_by TEXT NOT NULL,
	created_at TEXT NOT NULL,
	PRIMARY KEY (org_id, email)
);
CREATE INDEX org_invites_email ON org_invites (email);

CREATE TABLE teams (
	id TEXT PRIMARY KEY,
	org_id TEXT NOT NULL REFERENCES orgs (id),
	slug TEXT NOT NULL,
	name TEXT,
	created_at TEXT NOT NULL,
	UNIQUE (org_id, slug)
);

CREATE TABLE team_members (
	team_id TEXT NOT NULL REFERENCES teams (id),
	user_id TEXT NOT NULL REFERENCES users (id),
	created_at TEXT NOT NULL,
	PRIMARY KEY (team_id, user_id)
);
CREATE INDEX team_members_user ON team_members (user_id);

CREATE TABLE repos (
	id TEXT PRIMARY KEY,
	org_id TEXT NOT NULL REFERENCES orgs (id),
	name TEXT NOT NULL,
	visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
	created_by TEXT,
	created_at TEXT NOT NULL,
	UNIQUE (org_id, name)
);

CREATE TABLE repo_collaborators (
	repo_id TEXT NOT NULL REFERENCES repos (id),
	user_id TEXT NOT NULL REFERENCES users (id),
	permission TEXT NOT NULL CHECK (permission IN ('read', 'review', 'write', 'admin')),
	created_at TEXT NOT NULL,
	PRIMARY KEY (repo_id, user_id)
);
CREATE INDEX repo_collaborators_user ON repo_collaborators (user_id);
