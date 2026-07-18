CREATE TABLE IF NOT EXISTS votes (
    theme_id TEXT NOT NULL,
    device TEXT NOT NULL,
    created INTEGER NOT NULL,
    PRIMARY KEY (theme_id, device)
);

CREATE INDEX IF NOT EXISTS idx_votes_device ON votes (device);

-- Rolling upload throttle per device hash.
CREATE TABLE IF NOT EXISTS uploads (
    device TEXT NOT NULL,
    created INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_uploads_device ON uploads (device, created);

-- One "download" per device per theme, recorded when a theme is applied.
CREATE TABLE IF NOT EXISTS applies (
    theme_id TEXT NOT NULL,
    device TEXT NOT NULL,
    created INTEGER NOT NULL,
    PRIMARY KEY (theme_id, device)
);

-- One report per device per theme; first report opens a GitHub issue.
CREATE TABLE IF NOT EXISTS reports (
    theme_id TEXT NOT NULL,
    device TEXT NOT NULL,
    created INTEGER NOT NULL,
    PRIMARY KEY (theme_id, device)
);

-- Failed admin auth attempts per salted IP hash; drives the lockout.
CREATE TABLE IF NOT EXISTS admin_attempts (
    ip TEXT NOT NULL,
    created INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_attempts_ip ON admin_attempts (ip, created);

-- Permanently blocked uploaders, keyed by the same salted SSAID hash as
-- votes — no raw identity stored. reason = what they submitted, so the
-- owner can still identify the block later.
CREATE TABLE IF NOT EXISTS blocked_devices (
    device TEXT PRIMARY KEY,
    reason TEXT NOT NULL DEFAULT '',
    created INTEGER NOT NULL
);

-- Submission queue: uploads land here; nothing reaches GitHub until the
-- owner approves via the admin endpoints. device = salted SSAID hash.
CREATE TABLE IF NOT EXISTS pending (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    author TEXT NOT NULL DEFAULT '',
    payload TEXT NOT NULL,
    device TEXT NOT NULL,
    created INTEGER NOT NULL
);
