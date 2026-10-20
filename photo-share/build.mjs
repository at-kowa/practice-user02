// 写真共有（練習版） v1 ビルド（計画書 §5.1）
// 環境変数から dist/config.js を作り、画面のファイルを dist/ へコピーする。
// Node 標準モジュールだけを使う（npm の依存なし）。
// 使い方: node build.mjs   （SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY / ALLOWED_EMAIL_DOMAIN が必要）
import { mkdirSync, rmSync, copyFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, 'dist');

const NAMES = ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'ALLOWED_EMAIL_DOMAIN'];
const FILES = ['index.html', 'app.js', 'style.css'];

// 1. 欠けている環境変数を調べる（値は表示しない）
const missing = NAMES.filter((n) => !String(process.env[n] || '').trim());
if (missing.length) {
  console.error('ビルドを中止しました。次の環境変数が設定されていません: ' + missing.join(', '));
  process.exit(1);
}

// 2. 秘密用キーの取り違えを止める（値は表示しない）
const secretIn = NAMES.filter((n) => String(process.env[n]).includes('sb_secret_'));
if (secretIn.length) {
  console.error('ビルドを中止しました。秘密用キー（sb_secret_）が入っています。公開用キーに直してください: ' + secretIn.join(', '));
  process.exit(1);
}

const config = {
  SUPABASE_URL: process.env.SUPABASE_URL.trim().replace(/\/+$/, ''),
  SUPABASE_PUBLISHABLE_KEY: process.env.SUPABASE_PUBLISHABLE_KEY.trim(),
  ALLOWED_EMAIL_DOMAIN: process.env.ALLOWED_EMAIL_DOMAIN.trim().toLowerCase().replace(/^@+/, '')
};

// 3. dist/ を作り直してコピー
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
for (const f of FILES) copyFileSync(join(here, f), join(dist, f));
writeFileSync(join(dist, 'config.js'), 'window.APP_CONFIG = ' + JSON.stringify(config, null, 2) + ';\n', 'utf8');

console.log('ビルドしました: dist/ に ' + FILES.concat('config.js').join(', ') + ' を作成');
