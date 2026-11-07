-- Audit log is append-only: any UPDATE or DELETE aborts.
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
--> statement-breakpoint
-- Defence in depth for the anti-gaming rules (the service layer enforces them first).
-- Committed definitions are immutable once the day has locked_at.
CREATE TRIGGER outcomes_locked_no_edit BEFORE UPDATE OF title, done_means, level, goal_id, planned, date, position, carried_from ON outcomes
WHEN (SELECT locked_at FROM days WHERE date = OLD.date) IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'outcome definition is locked'); END;
--> statement-breakpoint
CREATE TRIGGER outcomes_locked_no_delete BEFORE DELETE ON outcomes
WHEN (SELECT locked_at FROM days WHERE date = OLD.date) IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'locked outcome cannot be deleted'); END;
--> statement-breakpoint
CREATE TRIGGER outcomes_locked_no_insert BEFORE INSERT ON outcomes
WHEN NEW.planned = 1 AND (SELECT locked_at FROM days WHERE date = NEW.date) IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'cannot add planned outcome to a locked day'); END;
--> statement-breakpoint
-- A locked day cannot be unlocked or re-stamped.
CREATE TRIGGER days_lock_immutable BEFORE UPDATE OF locked_at ON days
WHEN OLD.locked_at IS NOT NULL AND NEW.locked_at IS NOT OLD.locked_at
BEGIN SELECT RAISE(ABORT, 'locked_at is immutable'); END;
