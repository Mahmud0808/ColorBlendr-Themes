CREATE TABLE IF NOT EXISTS votes (
    theme_id TEXT NOT NULL,
    device TEXT NOT NULL,
    created INTEGER NOT NULL,
    PRIMARY KEY (theme_id, device)
);

CREATE INDEX IF NOT EXISTS idx_votes_device ON votes (device);

-- Rolling upload throttle per IP.
CREATE TABLE IF NOT EXISTS uploads (
    ip TEXT NOT NULL,
    created INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_uploads_ip ON uploads (ip, created);
