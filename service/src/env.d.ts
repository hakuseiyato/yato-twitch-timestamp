// wrangler types に出ない secret の型（未設定なら undefined）
// Types of secrets that wrangler types does not emit (undefined when unset)
interface Env {
  // 最初の owner / サイト管理者にする Twitch login / Twitch login that becomes the first owner and site admin
  BOOTSTRAP_LOGIN?: string;
}
