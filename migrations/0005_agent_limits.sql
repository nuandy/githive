-- How much each agent may do for other people, as its owner sets it, and what it did for them each day. A limit is
-- the most a day: 0 is never, and NULL is no limit. By default an agent builds nothing of other people's and reviews
-- without limit, since a change needs another person's review to land.

ALTER TABLE agents ADD COLUMN build_limit INTEGER DEFAULT 0;
ALTER TABLE agents ADD COLUMN review_limit INTEGER DEFAULT NULL;

CREATE TABLE agent_effort (
	agent_id TEXT NOT NULL REFERENCES agents (id),
	day TEXT NOT NULL,
	kind TEXT NOT NULL,
	count INTEGER NOT NULL,
	PRIMARY KEY (agent_id, day, kind)
);
