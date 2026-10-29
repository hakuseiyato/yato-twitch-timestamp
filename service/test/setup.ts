// 各テストファイルの前に D1 のスキーマを用意する / Prepares the D1 schema before each test file
import { applyMigrations } from './helpers';

await applyMigrations();
