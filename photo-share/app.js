/* 写真共有（練習版） v1
   出典はすべて「写真共有_計画書.md」（計画 v1）。§番号は計画書の節。
   - 接続先URL・公開用キー・許可ドメインはコードに書かない（config.js がビルド時に作る window.APP_CONFIG から読む）
   - config.js が無い、または URL に ?mock=1 があるときはモックモード（通信しない） §9 */
(function () {
  'use strict';

  // ===== 定数（変えるときはここだけ） =====
  var APP_VERSION = 'v1';
  var DB_SCHEMA = 'photo_share';     // §5.1・U-02（sql/setup.sql と合わせる）
  var BUCKET = 'photo-share';        // §5.1・U-02（sql/setup.sql と合わせる）
  var KEEP_DAYS = 30;                // §6.3 保存期間（sql/setup.sql の interval '30 days' と合わせる）
  var MAX_SEND = 20;                 // U-11 1回に送れる枚数
  var MAX_ZIP = 50;                  // U-12 zip一括保存の上限
  var MEMO_MAX = 200;                // §4.3・§5.2 メモの最大文字数
  var FULL_EDGE = 2000;              // U-06 原寸用の長辺(px)
  var FULL_QUALITY = 0.85;           // U-06 原寸用のJPEG品質
  var THUMB_EDGE = 400;              // U-06 サムネイルの長辺(px)
  var THUMB_QUALITY = 0.75;          // U-06 サムネイルのJPEG品質
  var MOCK_FULL_EDGE = 800;          // §9 モックの原寸は長辺800pxに落として保存
  var MOCK_DOMAIN_DEFAULT = 'mock.example'; // §9 モック専用の架空ドメイン
  var PURGE_BATCH = 100;             // §6.5 1回に片付ける件数
  var PURGE_MAX_ROUNDS = 5;          // §6.5 1回の実行で最大5周
  var REFRESH_MARGIN_MS = 60 * 1000; // §6.6 有効期限の60秒前に更新
  var PRACTICE_NOTICE = '練習版です。業務の写真は送らないでください（テスト画像のみ）'; // §4.1（実データ版で外す文言）
  var DAY_MS = 24 * 60 * 60 * 1000;
  var JST_OFFSET_MS = 9 * 60 * 60 * 1000; // 日付・時刻は日本時間で表示 §4.4
  var LS = {                          // localStorage のキー §6.5・§6.6・§9
    session: 'photoShare.session',
    tab: 'photoShare.tab',
    purge: 'photoShare.lastPurge',
    mock: 'photoShareMock.v1'
  };

  // ===== 画面に出す文（何が起きたか＋次にすること） §4.2 =====
  var MSG = {
    emailEmpty: 'メールアドレスが入っていません。会社のメールアドレスを入力してください。',
    emailForm: 'メールアドレスの形が正しくありません。入力した内容を確かめてください。',
    emailDomain: 'このメールアドレスでは使えません。会社のメールアドレスを入力してください。',
    rateLimit: '送信回数の上限に達しました。しばらく待ってからもう一度押してください。',
    loginSendFail: 'ログイン用メールを送れませんでした。少し待ってからもう一度押してください。',
    loginSent: 'メールを送りました。届いたメールのリンクを、このiPhone（またはPC）で開いてください。',
    mockSent: '（モックモードのため実際のメールは送りません。下の「（モック）リンクを開いたことにする」を押してください。）',
    linkExpired: 'ログイン用リンクの期限が切れています。もう一度ログイン用メールを送ってください。',
    linkError: 'ログイン用リンクを確かめられませんでした。もう一度ログイン用メールを送ってください。',
    sessionExpired: 'ログインの期限が切れました。もう一度ログインしてください。',
    network: '通信できませんでした。ネットワークの状態を確かめて、もう一度操作してください。',
    configMissing: '接続先の設定が読み込めませんでした。管理している人に設定（環境変数）を確かめてもらってください。',
    imageUnreadable: 'この写真は読み込めませんでした。別の写真を選んでください。',
    uploadFail: 'この写真を送れませんでした。「失敗した写真をもう一度送る」を押してください。',
    tooMany: '1回に送れるのは' + MAX_SEND + '枚までです。' + (MAX_SEND + 1) + '枚目からは入れていません。送信が終わってから残りを選んでください。',
    memoTooLong: 'メモが' + MEMO_MAX + '文字を超えています。' + MEMO_MAX + '文字以内に減らしてください。',
    listFail: '写真の一覧を読み込めませんでした。「再読み込み」を押してください。',
    downloadFail: '写真を保存できませんでした。もう一度押してください。',
    zipFail: 'zipを作れませんでした。もう一度「選択した写真をzipで保存」を押してください。',
    zipOver: 'zip保存は1回' + MAX_ZIP + '枚までです。選択を' + MAX_ZIP + '枚以下に減らしてください。',
    purgeAutoFail: '片付けに失敗しました。あとで『片付け』ボタンを押してください。',
    purgeFail: '片付けに失敗しました。時間をおいてもう一度押してください。',
    mockFull: 'モックの保存容量がいっぱいです。URLに ?mock=1&reset=1 を付けて開き直してください。',
    noPhotos: 'まだ写真がありません。',
    noMatch: '条件に合う写真がありません。条件を変えてください。'
  };

  // 利用者向けの文を持つエラー（code='auth' はログイン画面へ戻す合図）
  function AppError(userMsg, code) {
    var e = new Error(userMsg);
    e.userMsg = userMsg;
    e.code = code || '';
    return e;
  }

  // ===== モード判定 §9 =====
  var params = new URLSearchParams(location.search);
  var cfg = (window.APP_CONFIG && typeof window.APP_CONFIG === 'object') ? window.APP_CONFIG : null;
  var IS_MOCK = params.get('mock') === '1' || !cfg;
  var FAIL = IS_MOCK ? (params.get('fail') || '') : '';           // ?fail=upload|list|purge
  var AUTO_PURGE_OFF = IS_MOCK && params.get('autopurge') === '0'; // テスト用：自動片付けを止める（モックのみ）

  function normDomain(d) {
    return String(d || '').trim().toLowerCase().replace(/^@+/, '');
  }
  var ALLOWED_DOMAIN = IS_MOCK
    ? normDomain(params.get('domain') || MOCK_DOMAIN_DEFAULT)
    : normDomain(cfg.ALLOWED_EMAIL_DOMAIN);

  // ===== 現在時刻（モックは ?now= で固定できる） §9 =====
  var LOAD_AT = Date.now();
  var FIXED_NOW = null;
  if (IS_MOCK && params.get('now')) {
    var t0 = Date.parse(params.get('now'));
    if (!isNaN(t0)) FIXED_NOW = t0;
  }
  // 固定時刻を起点に、読み込んでからの経過時間だけ進める（同じ時刻の行が並ばないように）
  function nowMs() {
    return FIXED_NOW === null ? Date.now() : FIXED_NOW + (Date.now() - LOAD_AT);
  }

  // ===== 小さな道具 =====
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { /* 何もしない */ } }

  // セッションの保存は この3関数だけ（実データ版で保存先を変えるならここ） §12
  function saveSession(s) { lsSet(LS.session, JSON.stringify(s)); }
  function loadSession() {
    try { var s = JSON.parse(lsGet(LS.session) || 'null'); return (s && typeof s === 'object') ? s : null; }
    catch (e) { return null; }
  }
  function clearSession() { lsDel(LS.session); }

  function uuid() {
    if (window.crypto && crypto.randomUUID) {
      try { return crypto.randomUUID(); } catch (e) { /* 下の方法で作る */ }
    }
    var b = new Uint8Array(16);
    crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = [];
    for (var i = 0; i < 16; i++) h.push((b[i] + 0x100).toString(16).slice(1));
    return h.slice(0, 4).join('') + '-' + h.slice(4, 6).join('') + '-' + h.slice(6, 8).join('') + '-' +
      h.slice(8, 10).join('') + '-' + h.slice(10, 16).join('');
  }

  function pad(n, w) { var s = String(n); while (s.length < (w || 2)) s = '0' + s; return s; }
  // 日本時間の年月日時分秒
  function jst(ms) {
    var d = new Date(ms + JST_OFFSET_MS);
    return {
      y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(),
      h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds()
    };
  }
  function fmtDateTime(ms) { var p = jst(ms); return p.y + '/' + pad(p.mo) + '/' + pad(p.d) + ' ' + pad(p.h) + ':' + pad(p.mi); }
  function jstDay(ms) { var p = jst(ms); return p.y + '-' + pad(p.mo) + '-' + pad(p.d); }
  function stamp(ms) { var p = jst(ms); return '' + p.y + pad(p.mo) + pad(p.d) + '_' + pad(p.h) + pad(p.mi) + pad(p.s); }
  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // dataURL → Blob（通信しないよう fetch は使わない）
  function dataUrlToBlob(dataUrl) {
    var comma = dataUrl.indexOf(',');
    var mime = (dataUrl.slice(5, comma).split(';')[0]) || 'application/octet-stream';
    var bin = atob(dataUrl.slice(comma + 1));
    var u8 = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new Blob([u8], { type: mime });
  }
  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(fr.error); };
      fr.readAsDataURL(blob);
    });
  }
  function emailFromJwt(token) {
    try {
      var part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      while (part.length % 4) part += '=';
      var json = decodeURIComponent(atob(part).split('').map(function (c) {
        return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
      }).join(''));
      return String(JSON.parse(json).email || '').toLowerCase();
    } catch (e) { return ''; }
  }

  // ファイルとして保存（<a download>）
  function saveBlob(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
    debug.saved.push({ name: name, size: blob.size });
    debug.lastSavedBlob = blob;
  }

  // ===== メールアドレスの入力チェック §4.2（最終判定はRLS） =====
  function checkEmail(raw) {
    var email = String(raw || '').trim().toLowerCase();
    if (!email) return { ok: false, msg: MSG.emailEmpty };
    var at = email.indexOf('@');
    if (at < 1 || at !== email.lastIndexOf('@') || at === email.length - 1 || /\s/.test(email)) {
      return { ok: false, msg: MSG.emailForm };
    }
    // ドメイン部分が許可ドメインと完全に一致するときだけ通す（sub.ドメイン・ドメイン.example は通さない）
    if (!ALLOWED_DOMAIN || email.slice(at + 1) !== ALLOWED_DOMAIN) return { ok: false, msg: MSG.emailDomain };
    return { ok: true, email: email };
  }

  // ===== 画像の縮小 §4.3（canvasで描き直すのでExifは送られない） =====
  function loadImage(file) {
    var viaImg = function () {
      return new Promise(function (resolve, reject) {
        var url = URL.createObjectURL(file);
        var img = new Image();
        img.onload = function () { img._url = url; resolve(img); };
        img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('img')); };
        img.src = url;
      });
    };
    if (window.createImageBitmap) {
      // 向きは画像の情報どおり（from-image）に描く
      return createImageBitmap(file, { imageOrientation: 'from-image' }).catch(viaImg);
    }
    return viaImg();
  }
  function drawToJpeg(src, w0, h0, maxEdge, quality) {
    var scale = Math.min(1, maxEdge / Math.max(w0, h0)); // 元が小さければ拡大しない
    var w = Math.max(1, Math.round(w0 * scale));
    var h = Math.max(1, Math.round(h0 * scale));
    var c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';          // 透過画像は白地にする
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, w, h);
    return new Promise(function (resolve, reject) {
      c.toBlob(function (b) {
        if (b) resolve({ blob: b, width: w, height: h });
        else reject(new Error('toBlob'));
      }, 'image/jpeg', quality);
    });
  }
  // 原寸用（長辺2000px）とサムネイル用（長辺400px）を作る
  async function makeJpegs(file) {
    var src;
    try { src = await loadImage(file); } catch (e) { throw AppError(MSG.imageUnreadable); }
    try {
      var w0 = src.naturalWidth || src.width;
      var h0 = src.naturalHeight || src.height;
      if (!w0 || !h0) throw new Error('size');
      var full = await drawToJpeg(src, w0, h0, FULL_EDGE, FULL_QUALITY);
      var thumb = await drawToJpeg(src, w0, h0, THUMB_EDGE, THUMB_QUALITY);
      return { full: full, thumb: thumb, sourceWidth: w0, sourceHeight: h0 };
    } catch (e) {
      throw AppError(MSG.imageUnreadable);
    } finally {
      if (src && src.close) src.close();
      if (src && src._url) URL.revokeObjectURL(src._url);
    }
  }

  // ===== zip（無圧縮 store 方式・CRC-32 自前） §4.4 =====
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(u8) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  // files: [{ name: 半角英数字のファイル名, data: Uint8Array }]、ms: zip内の日時（日本時間で記録）
  function makeZip(files, ms) {
    var p = jst(ms);
    var dosTime = (p.h << 11) | (p.mi << 5) | (p.s >> 1);
    var dosDate = ((p.y - 1980) << 9) | (p.mo << 5) | p.d;
    var enc = new TextEncoder();
    var locals = [];
    var centrals = [];
    var offset = 0;
    var cdSize = 0;
    files.forEach(function (f) {
      var name = enc.encode(f.name);
      var crc = crc32(f.data);
      var size = f.data.length;
      var lh = new Uint8Array(30 + name.length);
      var v = new DataView(lh.buffer);
      v.setUint32(0, 0x04034b50, true); // ローカルファイルヘッダ
      v.setUint16(4, 20, true);         // 展開に必要な版
      v.setUint16(6, 0, true);          // フラグ
      v.setUint16(8, 0, true);          // 0 = store（無圧縮）
      v.setUint16(10, dosTime, true);
      v.setUint16(12, dosDate, true);
      v.setUint32(14, crc, true);
      v.setUint32(18, size, true);
      v.setUint32(22, size, true);
      v.setUint16(26, name.length, true);
      v.setUint16(28, 0, true);
      lh.set(name, 30);
      locals.push(lh, f.data);

      var ch = new Uint8Array(46 + name.length);
      var w = new DataView(ch.buffer);
      w.setUint32(0, 0x02014b50, true); // 中央ディレクトリ
      w.setUint16(4, 20, true);
      w.setUint16(6, 20, true);
      w.setUint16(8, 0, true);
      w.setUint16(10, 0, true);
      w.setUint16(12, dosTime, true);
      w.setUint16(14, dosDate, true);
      w.setUint32(16, crc, true);
      w.setUint32(20, size, true);
      w.setUint32(24, size, true);
      w.setUint16(28, name.length, true);
      w.setUint16(30, 0, true);
      w.setUint16(32, 0, true);
      w.setUint16(34, 0, true);
      w.setUint16(36, 0, true);
      w.setUint32(38, 0, true);
      w.setUint32(42, offset, true);
      ch.set(name, 46);
      centrals.push(ch);

      offset += lh.length + size;
      cdSize += ch.length;
    });
    var end = new Uint8Array(22);
    var e = new DataView(end.buffer);
    e.setUint32(0, 0x06054b50, true);   // 終端レコード
    e.setUint16(8, files.length, true);
    e.setUint16(10, files.length, true);
    e.setUint32(12, cdSize, true);
    e.setUint32(16, offset, true);
    return new Blob(locals.concat(centrals, [end]), { type: 'application/zip' });
  }

  // 写真1枚の保存ファイル名 photo_YYYYMMDD_HHmmss_<id先頭8桁>.jpg §4.4
  function photoFileName(row) {
    var id8 = String(row.id).replace(/[^0-9a-zA-Z]/g, '').slice(0, 8);
    return 'photo_' + stamp(Date.parse(row.created_at)) + '_' + id8 + '.jpg';
  }

  // ===== API層：モック（通信なし・localStorage） §9 =====
  var MockApi = (function () {
    var db = null;
    var pendingEmail = null;
    var uploadCalls = 0;

    function load() {
      if (db) return db;
      try { db = JSON.parse(lsGet(LS.mock) || 'null'); } catch (e) { db = null; }
      if (!db || !Array.isArray(db.rows) || !db.objects) db = null;
      return db;
    }
    function save() {
      if (!lsSet(LS.mock, JSON.stringify(db))) throw AppError(MSG.mockFull);
    }
    // 架空のテスト画像（色付き四角＋「TEST n」の文字だけ）
    function testImage(w, h, n, quality) {
      var colors = ['#e57373', '#64b5f6', '#81c784', '#ffb74d', '#ba68c8', '#4db6ac', '#f06292', '#a1887f'];
      var c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      var ctx = c.getContext('2d');
      ctx.fillStyle = colors[(n - 1) % colors.length];
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold ' + Math.round(h / 5) + 'px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('TEST ' + n, w / 2, h / 2);
      return c.toDataURL('image/jpeg', quality);
    }
    function seed() {
      db = { rows: [], objects: {}, seq: 0 };
      var now = nowMs();
      // 作成日時：0・1・5・15・29日前・30日と1分前・31日前・45日前 §9
      var ages = [0, 1 * DAY_MS, 5 * DAY_MS, 15 * DAY_MS, 29 * DAY_MS, 30 * DAY_MS + 60000, 31 * DAY_MS, 45 * DAY_MS];
      var senders = ['user-a@', 'user-b@', 'user-c@'];
      var memos = ['TEST 1 練習', '', 'テスト 3', 'TEST 4 練習', '', 'テスト 6', 'TEST 7', 'テスト 8'];
      // 古い順に入れる（seq が新しいほど大きくなるように）
      for (var i = ages.length - 1; i >= 0; i--) {
        var n = i + 1;
        var u = uuid();
        var row = {
          id: uuid(),
          storage_path: 'p/' + u + '.jpg',
          thumb_path: 't/' + u + '.jpg',
          uploader_email: senders[i % senders.length] + ALLOWED_DOMAIN,
          memo: memos[i] || null,
          created_at: new Date(now - ages[i]).toISOString(),
          seq: ++db.seq
        };
        try {
          db.objects[row.storage_path] = testImage(640, 480, n, FULL_QUALITY);
          db.objects[row.thumb_path] = testImage(400, 300, n, THUMB_QUALITY);
        } catch (e) { /* canvas が使えない環境では画像なしで行だけ作る */ }
        db.rows.push(row);
      }
    }
    function publicRow(r) {
      return { id: r.id, storage_path: r.storage_path, thumb_path: r.thumb_path,
        uploader_email: r.uploader_email, memo: r.memo, created_at: r.created_at };
    }
    function cutoff() { return nowMs() - KEEP_DAYS * DAY_MS; }
    function requireSession() {
      var s = loadSession();
      if (!s || s.mode !== 'mock') throw AppError(MSG.sessionExpired, 'auth');
      return s;
    }

    return {
      // 起動時に呼ぶ。reset=true なら擬似データを作り直す
      init: function (reset) {
        if (reset || !load()) {
          seed();
          save();
        }
      },
      sendLoginLink: async function (email) {
        await delay(300);
        pendingEmail = email;
        return { mockLinkReady: true };
      },
      // 「（モック）リンクを開いたことにする」
      mockOpenLink: async function () {
        if (!pendingEmail) throw AppError(MSG.linkError);
        var s = { mode: 'mock', email: pendingEmail, access_token: 'mock', refresh_token: 'mock',
          expires_at: Date.now() + 365 * DAY_MS };
        saveSession(s);
        pendingEmail = null;
        return s;
      },
      completeLoginFromUrl: async function () { return null; },
      getSession: async function () {
        var s = loadSession();
        return (s && s.mode === 'mock') ? s : null;
      },
      refreshSession: async function () { return requireSession(); },
      logout: async function () { clearSession(); },
      uploadPhoto: async function (photo, onProgress) {
        var s = requireSession();
        uploadCalls++;
        for (var step = 1; step <= 4; step++) {
          await delay(60);
          if (onProgress) onProgress(step / 5);
        }
        if (FAIL === 'upload' && uploadCalls === 2) throw AppError(MSG.uploadFail); // 送信の2枚目で失敗 §9
        // 容量を抑えるため、モックの原寸は長辺800pxに落として保存 §9
        var bmp = await loadImage(photo.full);
        var small;
        try {
          small = await drawToJpeg(bmp, bmp.naturalWidth || bmp.width, bmp.naturalHeight || bmp.height, MOCK_FULL_EDGE, FULL_QUALITY);
        } finally {
          if (bmp.close) bmp.close();
          if (bmp._url) URL.revokeObjectURL(bmp._url);
        }
        var u = uuid();
        var row = {
          id: uuid(),
          storage_path: 'p/' + u + '.jpg',
          thumb_path: 't/' + u + '.jpg',
          uploader_email: s.email,
          memo: photo.memo || null,
          created_at: new Date(nowMs()).toISOString(),
          seq: ++load().seq
        };
        db.objects[row.storage_path] = await blobToDataUrl(small.blob);
        db.objects[row.thumb_path] = await blobToDataUrl(photo.thumb);
        db.rows.push(row);
        try { save(); } catch (e) {
          db.rows.pop();
          delete db.objects[row.storage_path];
          delete db.objects[row.thumb_path];
          throw e;
        }
        if (onProgress) onProgress(1);
        return publicRow(row);
      },
      // RLS と同じ条件（created_at > now - 30日）をここで当てる §9
      listPhotos: async function () {
        requireSession();
        await delay(50);
        if (FAIL === 'list') throw AppError(MSG.listFail);
        var c = cutoff();
        return load().rows
          .filter(function (r) { return Date.parse(r.created_at) > c; })
          .sort(function (a, b) { return (Date.parse(b.created_at) - Date.parse(a.created_at)) || (b.seq - a.seq); })
          .map(publicRow);
      },
      downloadBlob: async function (path) {
        requireSession();
        var d = load().objects[path];
        if (!d) throw AppError(MSG.downloadFail);
        return dataUrlToBlob(d);
      },
      listExpired: async function (limit) {
        requireSession();
        if (FAIL === 'purge') throw AppError(MSG.purgeFail);
        var c = cutoff();
        return load().rows
          .filter(function (r) { return Date.parse(r.created_at) <= c; })
          .sort(function (a, b) { return Date.parse(a.created_at) - Date.parse(b.created_at); })
          .slice(0, limit)
          .map(function (r) { return { id: r.id, storage_path: r.storage_path, thumb_path: r.thumb_path }; });
      },
      removeObjects: async function (paths) {
        requireSession();
        load();
        paths.forEach(function (p) { delete db.objects[p]; });
        save();
        return paths.slice();
      },
      deleteExpiredRows: async function (ids) {
        requireSession();
        var c = cutoff();
        var before = load().rows.length;
        db.rows = db.rows.filter(function (r) {
          return !(ids.indexOf(r.id) >= 0 && Date.parse(r.created_at) <= c); // 30日以内は消さない
        });
        save();
        return before - db.rows.length;
      },
      // テスト用：擬似データの中身を見る
      _dump: function () { return load(); }
    };
  })();

  // ===== API層：本番（Supabaseへ fetch / XMLHttpRequest） §6.6 =====
  var RealApi = (function () {
    var BASE = cfg ? String(cfg.SUPABASE_URL || '').replace(/\/+$/, '') : '';
    var KEY = cfg ? String(cfg.SUPABASE_PUBLISHABLE_KEY || '') : '';
    var session = null;
    var refreshing = null;

    function current() {
      if (!session) {
        var s = loadSession();
        session = (s && s.mode === 'real') ? s : null;
      }
      return session;
    }
    function toSession(d, emailFallback) {
      return {
        mode: 'real',
        access_token: d.access_token,
        refresh_token: d.refresh_token,
        expires_at: Date.now() + (Number(d.expires_in) || 3600) * 1000,
        email: String((d.user && d.user.email) || emailFallback || emailFromJwt(d.access_token) || '').toLowerCase()
      };
    }
    function lost() {
      session = null;
      clearSession();
      return AppError(MSG.sessionExpired, 'auth');
    }
    async function refreshSession() {
      if (refreshing) return refreshing;
      refreshing = (async function () {
        var s = current();
        if (!s || !s.refresh_token) throw lost();
        var res;
        try {
          res = await fetch(BASE + '/auth/v1/token?grant_type=refresh_token', {
            method: 'POST',
            headers: { apikey: KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ refresh_token: s.refresh_token })
          });
        } catch (e) { throw AppError(MSG.network); }
        if (!res.ok) throw lost();
        session = toSession(await res.json(), s.email);
        saveSession(session);
        return session;
      })();
      try { return await refreshing; } finally { refreshing = null; }
    }
    async function ensureFresh() {
      var s = current();
      if (!s) throw lost();
      if (s.expires_at - REFRESH_MARGIN_MS < Date.now()) await refreshSession();
      return session;
    }
    // ログイン中の呼び出し。401 なら1回だけ更新してやり直す
    async function authFetch(url, opts) {
      await ensureFresh();
      var run = function () {
        var h = Object.assign({ apikey: KEY, Authorization: 'Bearer ' + session.access_token }, opts.headers || {});
        return fetch(url, Object.assign({}, opts, { headers: h }));
      };
      var res;
      try { res = await run(); } catch (e) { throw AppError(MSG.network); }
      if (res.status === 401) {
        await refreshSession();
        try { res = await run(); } catch (e) { throw AppError(MSG.network); }
        if (res.status === 401) throw lost();
      }
      return res;
    }
    async function rpc(name, body, failMsg) {
      var res = await authFetch(BASE + '/rest/v1/rpc/' + name, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Profile': DB_SCHEMA },
        body: JSON.stringify(body)
      });
      if (!res.ok) throw AppError(failMsg);
      return res.json();
    }
    // Storageへの送信（進捗を取るため XMLHttpRequest） §5.5
    function xhrUpload(path, blob, onProg) {
      return new Promise(function (resolve, reject) {
        var x = new XMLHttpRequest();
        x.open('POST', BASE + '/storage/v1/object/' + BUCKET + '/' + path);
        x.setRequestHeader('apikey', KEY);
        x.setRequestHeader('Authorization', 'Bearer ' + session.access_token);
        x.setRequestHeader('Content-Type', 'image/jpeg');
        x.setRequestHeader('x-upsert', 'false');
        x.upload.onprogress = function (e) { if (e.lengthComputable && onProg) onProg(e.loaded); };
        x.onload = function () { resolve(x.status); };
        x.onerror = function () { reject(AppError(MSG.network)); };
        x.send(blob);
      });
    }
    async function uploadObject(path, blob, onProg) {
      await ensureFresh();
      var st = await xhrUpload(path, blob, onProg);
      if (st === 401 || st === 403) {     // トークン切れのことがあるので1回だけ更新してやり直す
        await refreshSession();
        st = await xhrUpload(path, blob, onProg);
      }
      if (st < 200 || st >= 300) throw AppError(MSG.uploadFail);
    }
    async function removeQuietly(paths) {
      try {
        await authFetch(BASE + '/storage/v1/object/' + BUCKET, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prefixes: paths })
        });
      } catch (e) { /* 1回だけ試す §5.5 */ }
    }

    return {
      configOk: function () { return !!(BASE && KEY && ALLOWED_DOMAIN); },
      sendLoginLink: async function (email) {
        var back = location.origin + location.pathname; // 戻り先は現在のURL §6.6
        var res;
        try {
          res = await fetch(BASE + '/auth/v1/otp?redirect_to=' + encodeURIComponent(back), {
            method: 'POST',
            headers: { apikey: KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: email, create_user: true })
          });
        } catch (e) { throw AppError(MSG.network); }
        if (res.status === 429) throw AppError(MSG.rateLimit);
        if (!res.ok) {
          var b = null;
          try { b = await res.json(); } catch (e) { /* 本文なし */ }
          var code = b && (b.error_code || b.code || '');
          if (String(code).indexOf('rate_limit') >= 0) throw AppError(MSG.rateLimit);
          throw AppError(MSG.loginSendFail);
        }
        return { mockLinkReady: false };
      },
      // メールのリンクから戻ったとき：URLのハッシュからトークンを取り出し、URLから消す §4.2・§6.6
      completeLoginFromUrl: async function () {
        var hp = new URLSearchParams(location.hash.replace(/^#/, ''));
        var qp = new URLSearchParams(location.search);
        var err = hp.get('error') || hp.get('error_code') || qp.get('error') || qp.get('error_code');
        var token = hp.get('access_token');
        if (!err && !token) return null;
        history.replaceState(null, '', location.pathname); // トークン・エラーをURLから消す
        if (err) {
          var code = hp.get('error_code') || qp.get('error_code') || '';
          throw AppError(code === 'otp_expired' ? MSG.linkExpired : MSG.linkError);
        }
        session = toSession({
          access_token: token,
          refresh_token: hp.get('refresh_token'),
          expires_in: hp.get('expires_in')
        }, emailFromJwt(token));
        saveSession(session);
        return session;
      },
      getSession: async function () { return current(); },
      refreshSession: refreshSession,
      logout: async function () {
        var s = current();
        if (s) {
          try {
            await fetch(BASE + '/auth/v1/logout', {
              method: 'POST',
              headers: { apikey: KEY, Authorization: 'Bearer ' + s.access_token }
            });
          } catch (e) { /* 端末の保存分は必ず消す */ }
        }
        session = null;
        clearSession();
      },
      // 原寸 → サムネイル → photos行の順 §5.5
      uploadPhoto: async function (photo, onProgress) {
        var u = uuid();
        var sp = 'p/' + u + '.jpg';
        var tp = 't/' + u + '.jpg';
        var total = photo.full.size + photo.thumb.size;
        var prog = function (base) {
          return function (loaded) { if (onProgress) onProgress(Math.min(1, (base + loaded) / total)); };
        };
        await uploadObject(sp, photo.full, prog(0));
        try {
          await uploadObject(tp, photo.thumb, prog(photo.full.size));
        } catch (e) {
          await removeQuietly([sp]);
          throw e;
        }
        var row;
        try {
          var res = await authFetch(BASE + '/rest/v1/photos', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Profile': DB_SCHEMA, Prefer: 'return=representation' },
            body: JSON.stringify({ storage_path: sp, thumb_path: tp, memo: photo.memo || null })
          });
          if (!res.ok) throw AppError(MSG.uploadFail);
          row = (await res.json())[0];
        } catch (e) {
          await removeQuietly([sp, tp]); // 送ったファイルの削除を1回だけ試す §5.5
          if (e.code === 'auth') throw e;
          throw AppError(MSG.uploadFail);
        }
        if (onProgress) onProgress(1);
        return row;
      },
      listPhotos: async function () {
        var res = await authFetch(BASE + '/rest/v1/photos?select=id,storage_path,thumb_path,uploader_email,memo,created_at&order=created_at.desc', {
          method: 'GET',
          headers: { 'Accept-Profile': DB_SCHEMA }
        });
        if (!res.ok) throw AppError(MSG.listFail);
        return res.json();
      },
      // 非公開バケットから Authorization 付きで取得（署名付きURLは使わない） §5.4
      downloadBlob: async function (path) {
        var res = await authFetch(BASE + '/storage/v1/object/authenticated/' + BUCKET + '/' + path, { method: 'GET' });
        if (!res.ok) throw AppError(MSG.downloadFail);
        return res.blob();
      },
      listExpired: async function (limit) {
        return rpc('list_expired', { max_rows: limit }, MSG.purgeFail);
      },
      removeObjects: async function (paths) {
        var res = await authFetch(BASE + '/storage/v1/object/' + BUCKET, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prefixes: paths })
        });
        if (!res.ok) throw AppError(MSG.purgeFail);
        return res.json();
      },
      deleteExpiredRows: async function (ids) {
        var n = await rpc('delete_expired', { ids: ids }, MSG.purgeFail);
        return Number(n) || 0;
      }
    };
  })();

  var api = IS_MOCK ? MockApi : RealApi;

  // ===== 画面の状態 =====
  var state = {
    session: null,
    tab: null,
    loginBusy: false,
    picks: [],             // 送る写真 { key, file, url, status, err, done }
    sending: false,
    photos: [],            // 一覧（新しい順）
    loaded: false,
    loading: false,
    selected: new Set(),   // 選択中の写真id（タブを往復しても残る）
    thumbUrls: new Map(),  // サムネイルのパス → blob URL
    zipping: false,
    purging: false
  };
  var debug = { saved: [], lastSavedBlob: null, lastPrepared: null, autoPurgeRuns: 0 };

  function $(id) { return document.getElementById(id); }
  function setText(id, text) { $(id).textContent = text || ''; }

  // ===== ログイン画面 §4.2 =====
  function showLogin(errMsg) {
    $('main-view').hidden = true;
    $('login-view').hidden = false;
    setText('login-err', errMsg || '');
  }

  async function onLoginSubmit(ev) {
    ev.preventDefault();
    if (state.loginBusy) return;
    setText('login-err', '');
    setText('login-msg', '');
    $('mock-open-link').hidden = true;
    var chk = checkEmail($('login-email').value);
    if (!chk.ok) { setText('login-err', chk.msg); return; }
    state.loginBusy = true;
    $('login-send').disabled = true;
    try {
      var r = await api.sendLoginLink(chk.email);
      setText('login-msg', MSG.loginSent + (r.mockLinkReady ? '\n' + MSG.mockSent : ''));
      if (r.mockLinkReady) $('mock-open-link').hidden = false;
    } catch (e) {
      setText('login-err', e.userMsg || MSG.loginSendFail);
    } finally {
      state.loginBusy = false;
      $('login-send').disabled = false;
    }
  }

  async function onMockOpenLink() {
    try {
      var s = await MockApi.mockOpenLink();
      $('mock-open-link').hidden = true;
      setText('login-msg', '');
      enterMain(s);
    } catch (e) {
      setText('login-err', e.userMsg || MSG.linkError);
    }
  }

  function enterMain(s) {
    state.session = s;
    $('login-view').hidden = true;
    $('main-view').hidden = false;
    setText('user-email', 'ログイン中：' + s.email);
    var saved = lsGet(LS.tab);
    var first = (saved === 'send' || saved === 'view') ? saved : (window.innerWidth < 768 ? 'send' : 'view'); // §4.1
    switchTab(first);
  }

  function onAuthLost() {
    state.session = null;
    clearSession();
    showLogin(MSG.sessionExpired);
  }

  async function onLogout() {
    $('logout-btn').disabled = true;
    try { await api.logout(); } finally { location.reload(); }
  }

  // ===== タブ =====
  function switchTab(name) {
    if (name !== 'send' && name !== 'view') name = 'send';
    state.tab = name;
    lsSet(LS.tab, name);
    var tabs = document.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      var on = tabs[i].getAttribute('data-tab') === name;
      tabs[i].classList.toggle('active', on);
      tabs[i].setAttribute('aria-selected', on ? 'true' : 'false');
    }
    var pages = document.querySelectorAll('.page');
    for (var j = 0; j < pages.length; j++) pages[j].classList.toggle('active', pages[j].id === 'page-' + name);
    if (name === 'view') {
      if (!state.loaded && !state.loading) loadPhotos();
      autoPurgeIfNeeded();
    }
  }
  window.switchTab = switchTab;

  // ===== 「送る」タブ §4.3 =====
  function onPick(ev) {
    var files = Array.prototype.slice.call(ev.target.files || []);
    ev.target.value = '';           // 同じ写真をもう一度選べるように
    if (state.sending) return;
    var skipped = 0;
    files.forEach(function (f) {
      if (state.picks.length >= MAX_SEND) { skipped++; return; }
      state.picks.push({ key: uuid(), file: f, url: URL.createObjectURL(f), status: '', err: '', done: false });
    });
    setText('pick-msg', skipped > 0 ? MSG.tooMany : '');
    $('send-done').hidden = true;
    setText('send-progress', '');
    setText('send-err', '');
    renderPicks();
  }

  function renderPicks() {
    var ul = $('pick-list');
    ul.textContent = '';
    state.picks.forEach(function (p) {
      var li = document.createElement('li');
      var img = document.createElement('img');
      img.src = p.url;
      img.alt = '選んだ写真';
      li.appendChild(img);
      var st = document.createElement('span');
      st.className = 'pick-state' + (p.err ? ' err' : '');
      st.textContent = p.err ? '失敗：' + p.err : p.status;
      li.appendChild(st);
      var rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'remove-btn';
      rm.textContent = '×';
      rm.title = '外す';
      rm.setAttribute('aria-label', 'この写真を外す');
      rm.disabled = state.sending;
      rm.addEventListener('click', function () { removePick(p.key); });
      li.appendChild(rm);
      ul.appendChild(li);
    });
    updateSendUi();
  }

  function removePick(key) {
    if (state.sending) return;
    state.picks = state.picks.filter(function (p) {
      if (p.key === key) { URL.revokeObjectURL(p.url); return false; }
      return true;
    });
    if (state.picks.length < MAX_SEND) setText('pick-msg', '');
    renderPicks();
  }

  function updateSendUi() {
    $('send-btn').disabled = state.sending || state.picks.length === 0;
    $('pick-input').disabled = state.sending;
    $('pick-label').classList.toggle('disabled', state.sending);
    $('pick-label').setAttribute('aria-disabled', state.sending ? 'true' : 'false');
    var hasFail = state.picks.some(function (p) { return !!p.err; });
    $('retry-btn').hidden = !hasFail || state.sending;
    $('retry-btn').disabled = state.sending;
    $('memo-input').disabled = state.sending;
  }

  function updateMemoCount() {
    var n = $('memo-input').value.length;
    setText('memo-count', n <= MEMO_MAX ? '残り' + (MEMO_MAX - n) + '文字' : (n - MEMO_MAX) + '文字多すぎます');
  }

  async function sendPicks() {
    if (state.sending || state.picks.length === 0) return;
    var memo = $('memo-input').value.trim();
    if (memo.length > MEMO_MAX) { setText('send-err', MSG.memoTooLong); return; }
    setText('send-err', '');
    setText('pick-msg', '');
    $('send-done').hidden = true;
    state.sending = true;
    var targets = state.picks.slice();
    targets.forEach(function (p) { p.err = ''; p.status = '待ち'; });
    renderPicks();
    var n = targets.length;
    var ok = 0;
    var ng = 0;
    var authLost = false;
    for (var i = 0; i < n; i++) {
      var p = targets[i];
      var label = (i + 1) + '／' + n + '枚目';
      setText('send-progress', label + ' 縮小中');
      p.status = '縮小中';
      renderPicks();
      try {
        var jp = await makeJpegs(p.file);
        debug.lastPrepared = {
          sourceWidth: jp.sourceWidth, sourceHeight: jp.sourceHeight,
          fullWidth: jp.full.width, fullHeight: jp.full.height, fullType: jp.full.blob.type, fullSize: jp.full.blob.size,
          thumbWidth: jp.thumb.width, thumbHeight: jp.thumb.height, thumbType: jp.thumb.blob.type, thumbSize: jp.thumb.blob.size
        };
        setText('send-progress', label + ' 送信中 0%');
        p.status = '送信中';
        renderPicks();
        await api.uploadPhoto({ full: jp.full.blob, thumb: jp.thumb.blob, memo: memo }, (function (lb) {
          return function (f) { setText('send-progress', lb + ' 送信中 ' + Math.round(f * 100) + '%'); };
        })(label));
        p.done = true;
        p.status = '送信済み';
        ok++;
      } catch (e) {
        if (e.code === 'auth') { authLost = true; break; }
        p.err = e.userMsg || MSG.uploadFail;
        p.status = '';
        ng++;
      }
      renderPicks();
    }
    state.sending = false;
    if (authLost) { onAuthLost(); return; }
    // 送れた写真は一覧から外し、失敗した写真だけを残す §4.3
    state.picks = state.picks.filter(function (q) {
      if (q.done) { URL.revokeObjectURL(q.url); return false; }
      return true;
    });
    setText('send-progress', '完了 ' + ok + '枚（失敗' + ng + '枚）');
    if (ng === 0) {
      $('memo-input').value = '';
      updateMemoCount();
      $('send-done').hidden = false;
    }
    renderPicks();
    if (ok > 0) {
      state.loaded = false;
      if (state.tab === 'view') loadPhotos();
    }
  }

  // ===== 「見る」タブ §4.4 =====
  async function loadPhotos() {
    if (state.loading) return;
    state.loading = true;
    setText('view-err', '');
    setText('view-count', '読み込み中…');
    $('reload-btn').disabled = true;
    try {
      var rows = await api.listPhotos();
      state.photos = Array.isArray(rows) ? rows : [];
      state.loaded = true;
      var ids = new Set(state.photos.map(function (r) { return r.id; }));
      state.selected.forEach(function (id) { if (!ids.has(id)) state.selected.delete(id); });
      buildSenderOptions();
      renderGallery();
    } catch (e) {
      if (e.code === 'auth') { onAuthLost(); return; }
      setText('view-err', e.userMsg || MSG.listFail);
      setText('view-count', '');
    } finally {
      state.loading = false;
      $('reload-btn').disabled = false;
    }
  }

  function buildSenderOptions() {
    var sel = $('f-sender');
    var cur = sel.value;
    var list = Array.from(new Set(state.photos.map(function (r) { return r.uploader_email; }))).sort();
    sel.textContent = '';
    var all = document.createElement('option');
    all.value = '';
    all.textContent = '全員';
    sel.appendChild(all);
    list.forEach(function (em) {
      var o = document.createElement('option');
      o.value = em;
      o.textContent = em;
      sel.appendChild(o);
    });
    sel.value = list.indexOf(cur) >= 0 ? cur : '';
  }

  // 絞り込み：日付（日本時間の日単位・両端を含む）・送信者・メモ（部分一致・大文字小文字無視）
  function filteredPhotos() {
    var from = $('f-from').value;
    var to = $('f-to').value;
    var sender = $('f-sender').value;
    var memo = $('f-memo').value.trim().toLowerCase();
    return state.photos.filter(function (r) {
      var day = jstDay(Date.parse(r.created_at));
      if (from && day < from) return false;
      if (to && day > to) return false;
      if (sender && r.uploader_email !== sender) return false;
      if (memo && String(r.memo || '').toLowerCase().indexOf(memo) < 0) return false;
      return true;
    });
  }

  function daysLeft(createdIso) {
    var left = Date.parse(createdIso) + KEEP_DAYS * DAY_MS - nowMs();
    return Math.min(KEEP_DAYS, Math.max(0, Math.ceil(left / DAY_MS))); // 端末の時計ずれで31日と出ないよう上限30
  }

  function renderGallery() {
    var list = filteredPhotos();
    setText('view-count', '表示 ' + list.length + '件／' + KEEP_DAYS + '日以内 ' + state.photos.length + '件');
    var empty = $('view-empty');
    if (state.photos.length === 0) { empty.textContent = MSG.noPhotos; empty.hidden = false; }
    else if (list.length === 0) { empty.textContent = MSG.noMatch; empty.hidden = false; }
    else { empty.textContent = ''; empty.hidden = true; }

    var ul = $('gallery');
    ul.textContent = '';
    list.forEach(function (r) {
      var ms = Date.parse(r.created_at);
      var li = document.createElement('li');
      li.className = 'tile' + (state.selected.has(r.id) ? ' selected' : '');
      li.setAttribute('data-id', r.id);

      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'thumb-btn';
      btn.title = '押すと原寸を保存します';
      var img = document.createElement('img');
      img.alt = '写真 ' + fmtDateTime(ms) + '（押すと保存）';
      img.setAttribute('data-thumb', r.thumb_path);
      var cached = state.thumbUrls.get(r.thumb_path);
      if (cached) img.src = cached;
      btn.appendChild(img);
      btn.addEventListener('click', function () { saveOne(r, btn); });
      li.appendChild(btn);

      var meta = document.createElement('p');
      meta.className = 'meta';
      [
        ['when', fmtDateTime(ms)],
        ['who', r.uploader_email],
        ['memo', r.memo ? 'メモ：' + r.memo : 'メモなし'],
        ['left-days', 'あと' + daysLeft(r.created_at) + '日で消えます']
      ].forEach(function (pair) {
        var s = document.createElement('span');
        s.className = pair[0];
        s.textContent = pair[1];
        meta.appendChild(s);
        meta.appendChild(document.createElement('br'));
      });
      li.appendChild(meta);

      var lab = document.createElement('label');
      lab.className = 'sel-label';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'sel-check';
      cb.checked = state.selected.has(r.id);
      cb.addEventListener('change', function () {
        if (cb.checked) state.selected.add(r.id); else state.selected.delete(r.id);
        li.classList.toggle('selected', cb.checked);
        updateZipUi();
      });
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode('選ぶ'));
      li.appendChild(lab);
      ul.appendChild(li);
    });
    updateZipUi();
    loadThumbs(list);
  }

  // サムネイルを4本ずつ取りに行く
  var thumbQueue = [];
  var thumbRunning = 0;
  function loadThumbs(list) {
    list.forEach(function (r) {
      if (!state.thumbUrls.has(r.thumb_path) && thumbQueue.indexOf(r.thumb_path) < 0) thumbQueue.push(r.thumb_path);
    });
    while (thumbRunning < 4 && thumbQueue.length) runThumb(thumbQueue.shift());
  }
  async function runThumb(path) {
    thumbRunning++;
    try {
      var blob = await api.downloadBlob(path);
      var url = URL.createObjectURL(blob);
      state.thumbUrls.set(path, url);
      var imgs = document.querySelectorAll('#gallery img');
      for (var i = 0; i < imgs.length; i++) if (imgs[i].getAttribute('data-thumb') === path) imgs[i].src = url;
    } catch (e) {
      if (e.code === 'auth') { thumbQueue = []; onAuthLost(); }
    } finally {
      thumbRunning--;
      if (thumbQueue.length) runThumb(thumbQueue.shift());
    }
  }

  // サムネイルを押す → 原寸を1枚保存
  async function saveOne(row, btn) {
    if (btn.disabled) return;
    btn.disabled = true;
    setText('view-err', '');
    try {
      var blob = await api.downloadBlob(row.storage_path);
      saveBlob(blob, photoFileName(row));
    } catch (e) {
      if (e.code === 'auth') { onAuthLost(); return; }
      setText('view-err', e.userMsg || MSG.downloadFail);
    } finally {
      btn.disabled = false;
    }
  }

  function selectedRows() {
    return state.photos.filter(function (r) { return state.selected.has(r.id); });
  }

  function updateZipUi() {
    var n = selectedRows().length;
    var b = $('zip-btn');
    b.textContent = '選択した写真をzipで保存（' + n + '枚）';
    b.disabled = state.zipping || n === 0 || n > MAX_ZIP;
    if (!state.zipping) setText('zip-msg', n > MAX_ZIP ? MSG.zipOver : '');
  }

  function selectVisible(on) {
    filteredPhotos().forEach(function (r) {
      if (on) state.selected.add(r.id); else state.selected.delete(r.id);
    });
    renderGallery();
  }

  async function saveZip() {
    var rows = selectedRows();
    if (state.zipping || rows.length === 0 || rows.length > MAX_ZIP) return;
    state.zipping = true;
    updateZipUi();
    setText('view-err', '');
    try {
      var files = [];
      var used = new Set();
      for (var i = 0; i < rows.length; i++) {
        setText('zip-msg', '取得中 ' + (i + 1) + '／' + rows.length);
        var blob = await api.downloadBlob(rows[i].storage_path);
        var data = new Uint8Array(await blob.arrayBuffer());
        var name = photoFileName(rows[i]);
        var k = 2;
        while (used.has(name)) name = photoFileName(rows[i]).replace(/\.jpg$/, '_' + (k++) + '.jpg');
        used.add(name);
        files.push({ name: name, data: data });
      }
      var now = nowMs();
      saveBlob(makeZip(files, now), 'photos_' + stamp(now) + '.zip');
      setText('zip-msg', 'zipを保存しました（' + files.length + '枚）。');
    } catch (e) {
      if (e.code === 'auth') { state.zipping = false; onAuthLost(); return; }
      setText('zip-msg', '');
      setText('view-err', MSG.zipFail);
    } finally {
      state.zipping = false;
      var keep = $('zip-msg').textContent;
      updateZipUi();
      if (keep && selectedRows().length <= MAX_ZIP) setText('zip-msg', keep);
    }
  }

  // ===== 期限切れの片付け §6.5（手動ボタン＋1日1回自動・同じ関数） =====
  async function runPurge() {
    var total = 0;
    for (var round = 0; round < PURGE_MAX_ROUNDS; round++) {
      var rows = await api.listExpired(PURGE_BATCH);
      if (!rows || rows.length === 0) break;
      var paths = [];
      rows.forEach(function (r) { paths.push(r.storage_path, r.thumb_path); });
      await api.removeObjects(paths);           // 失敗したら行は消さない（次回やり直せる）
      total += await api.deleteExpiredRows(rows.map(function (r) { return r.id; }));
      if (rows.length < PURGE_BATCH) break;
    }
    return total;
  }

  function autoPurgeIfNeeded() {
    if (AUTO_PURGE_OFF || state.purging) return;
    var today = jstDay(nowMs());
    if (lsGet(LS.purge) === today) return;
    lsSet(LS.purge, today);                     // 失敗しても同じ日は再実行しない
    state.purging = true;
    debug.autoPurgeRuns++;
    runPurge().then(function () {
      state.purging = false;
    }).catch(function (e) {
      state.purging = false;
      if (e.code === 'auth') { onAuthLost(); return; }
      setText('purge-msg', MSG.purgeAutoFail);
    });
  }

  async function onPurgeYes() {
    if (state.purging) return;
    state.purging = true;
    $('purge-yes').disabled = true;
    $('purge-no').disabled = true;
    $('purge-btn').disabled = true;
    setText('purge-msg', '片付け中…');
    try {
      var n = await runPurge();
      setText('purge-msg', n > 0 ? '片付けました（' + n + '件）。' : '片付ける写真はありませんでした。');
      await loadPhotos();
    } catch (e) {
      if (e.code === 'auth') { onAuthLost(); return; }
      setText('purge-msg', MSG.purgeFail);
    } finally {
      state.purging = false;
      $('purge-confirm').hidden = true;
      $('purge-yes').disabled = false;
      $('purge-no').disabled = false;
      $('purge-btn').disabled = false;
    }
  }

  // ===== 起動 =====
  function bind() {
    $('login-form').addEventListener('submit', onLoginSubmit);
    $('mock-open-link').addEventListener('click', onMockOpenLink);
    $('logout-btn').addEventListener('click', onLogout);
    var tabs = document.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener('click', function (ev) { switchTab(ev.currentTarget.getAttribute('data-tab')); });
    }
    $('pick-input').addEventListener('change', onPick);
    $('memo-input').addEventListener('input', updateMemoCount);
    $('send-btn').addEventListener('click', sendPicks);
    $('retry-btn').addEventListener('click', sendPicks);
    $('go-view-link').addEventListener('click', function (ev) { ev.preventDefault(); switchTab('view'); });
    ['f-from', 'f-to', 'f-sender', 'f-memo'].forEach(function (id) {
      $(id).addEventListener('input', renderGallery);
      $(id).addEventListener('change', renderGallery);
    });
    $('sel-all-btn').addEventListener('click', function () { selectVisible(true); });
    $('sel-clear-btn').addEventListener('click', function () { selectVisible(false); });
    $('zip-btn').addEventListener('click', saveZip);
    $('reload-btn').addEventListener('click', loadPhotos);
    $('purge-btn').addEventListener('click', function () { $('purge-confirm').hidden = false; });
    $('purge-no').addEventListener('click', function () { $('purge-confirm').hidden = true; });
    $('purge-yes').addEventListener('click', onPurgeYes);
  }

  async function start() {
    setText('login-notice', PRACTICE_NOTICE);
    setText('main-notice', PRACTICE_NOTICE);
    $('mode-badge').hidden = !IS_MOCK;
    $('login-mode').hidden = !IS_MOCK;
    $('memo-input').setAttribute('maxlength', String(MEMO_MAX));
    updateMemoCount();
    bind();

    if (IS_MOCK) {
      var reset = params.get('reset') === '1';
      MockApi.init(reset);
      if (reset) {
        lsDel(LS.purge);
        params.delete('reset');      // 再読込で作り直さないようURLから外す
        var q = params.toString();
        history.replaceState(null, '', location.pathname + (q ? '?' + q : '') + location.hash);
      }
      $('login-email').placeholder = 'user-a@' + ALLOWED_DOMAIN;
    } else if (!RealApi.configOk()) {
      showLogin(MSG.configMissing);
      $('login-send').disabled = true;
      return;
    }

    var s = null;
    try {
      s = await api.completeLoginFromUrl();
    } catch (e) {
      showLogin(e.userMsg || MSG.linkError);
      return;
    }
    if (!s) s = await api.getSession();
    if (s) enterMain(s); else showLogin();
  }

  // テスト用の窓口（画面の動作には使わない）
  window.PhotoShare = {
    version: APP_VERSION,
    isMock: IS_MOCK,
    allowedDomain: ALLOWED_DOMAIN,
    api: api,
    state: state,
    debug: debug,
    nowMs: nowMs,
    checkEmail: checkEmail,
    makeJpegs: makeJpegs,
    drawToJpeg: drawToJpeg,
    makeZip: makeZip,
    crc32: crc32,
    photoFileName: photoFileName,
    runPurge: runPurge
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
