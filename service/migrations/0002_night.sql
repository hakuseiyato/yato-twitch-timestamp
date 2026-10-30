-- 夜の処理の要求・結果
-- Night-run request and outcome
ALTER TABLE streams ADD COLUMN night_requested_at TEXT;
ALTER TABLE streams ADD COLUMN night_done_at TEXT;
ALTER TABLE streams ADD COLUMN night_status TEXT;
