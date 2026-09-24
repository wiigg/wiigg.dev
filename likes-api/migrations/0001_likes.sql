CREATE TABLE likes (
  post_id TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  PRIMARY KEY (post_id, visitor_id)
) WITHOUT ROWID;
