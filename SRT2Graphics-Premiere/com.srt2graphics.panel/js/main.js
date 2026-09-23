/* SRT2Graphics — panel logic (CEP renderer) */
/* global CSInterface, SystemPath */

//==SRT-PARSER-START==
/**
 * Parses SRT subtitle content into cues.
 * Tolerant to: BOM, CRLF/LF, dot or comma millis, missing index lines, HTML-ish tags.
 * @param {string} content raw SRT file content
 * @returns {{ok:boolean, cues:Array, error:string?, warnings:string[]}}
 */
function parseSrt(content) {
  var warnings = [];
  if (typeof content !== 'string' || !content.length) {
    return { ok: false, cues: [], error: 'EMPTY', warnings: warnings };
  }
  // strip BOM
  content = content.replace(/^\uFEFF/, '');
  // normalize newlines
  content = content.replace(/\r\n?/g, '\n');

  var timeRe = /(\d{1,2}):(\d{1,2}):(\d{1,2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{1,2}):(\d{1,2})[,.](\d{1,3})/;
  var blocks = content.split(/\n{2,}/);
  var cues = [];
  var idxRe = /^\s*\d+\s*$/;

  for (var b = 0; b < blocks.length; b++) {
    var block = blocks[b];
    if (!block || !block.trim()) { continue; }
    var lines = block.split('\n');
    // find the timing line
    var tLine = -1;
    for (var i = 0; i < lines.length; i++) {
      if (timeRe.test(lines[i])) { tLine = i; break; }
    }
    if (tLine === -1) {
      if (block.trim().length > 4) { warnings.push('SKIP-NOTIME'); }
      continue;
    }
    var m = lines[tLine].match(timeRe);
    if (!m) { continue; }
    var startMs = (+m[1]) * 3600000 + (+m[2]) * 60000 + (+m[3]) * 1000 + (+((m[4] + '00').substr(0, 3)));
    var endMs   = (+m[5]) * 3600000 + (+m[6]) * 60000 + (+m[7]) * 1000 + (+((m[8] + '00').substr(0, 3)));

    // text lines: after timing line, skip a bare index line if present
    var textLines = lines.slice(tLine + 1);
    while (textLines.length && idxRe.test(textLines[0])) { textLines.shift(); }
    // also handle index line BEFORE timing line (normal case) — already skipped via block split
    var text = textLines.join('\n')
      .replace(/<[^>]+>/g, '')      // strip tags like <i>, <font ...>
      .replace(/\{\[^}]*\}/g, '')   // strip ASS-style override tags {\...}
      .trim();
    if (!text) { warnings.push('SKIP-EMPTYTEXT'); continue; }
    if (endMs <= startMs) { warnings.push('SKIP-BADTIME'); continue; }
    cues.push({ startMs: startMs, endMs: endMs, text: text });
  }

  cues.sort(function (a, b) { return a.startMs - b.startMs; });
  if (!cues.length) { return { ok: false, cues: [], error: 'NOCUES', warnings: warnings }; }
  return { ok: true, cues: cues, warnings: warnings };
}
//==SRT-PARSER-END==

(function () {
  'use strict';

  // v2.5 stability net: a renderer-side error must never kill the panel or
  // freeze a running conversion — surface it in the log and stay alive.
  window.onerror = function (msg, src, line) {
    try { log('خطای داخلی پنل: ' + String(msg) + ' (خط ' + String(line) + ')', 'err'); } catch (e) {}
    return true; // swallow — keep the panel alive
  };
  if (window.addEventListener) {
    window.addEventListener('unhandledrejection', function (ev) {
      try { log('خطای ناهمگام پنل: ' + String((ev && ev.reason) || ev), 'err'); } catch (e) {}
    });
  }

  var cs = new CSInterface();
  var cepFile = new CepFile();
  var TICKS_PER_MS = 254016000; // 254016000000 ticks/sec ÷ 1000

  var $ = function (id) { return document.getElementById(id); };

  var state = {
    connected: false,
    mogrtPath: '',
    srtName: '',
    cues: null,
    anchorTicks: 0,
    anchorMode: 'zero', // 'clip' | 'file' | 'playhead'
    engine: 'auto',     // v2.0: 'auto' | 'bake' | 'value'
    paceMs: 3000,       // v2.1: pause between layers (crash prevention)
    paceTimer: null,    // v2.1: countdown timer between layers
    quiet: true,        // v2.5: per-layer silence is ALWAYS on (no per-layer messages)
    converting: false,
    abort: false
  };

  // ---------- utils ----------
  var FA_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
  function faNum(n) {
    return String(n).replace(/\d/g, function (d) { return FA_DIGITS[+d]; });
  }
  function fmtTime(ms) {
    var h = Math.floor(ms / 3600000), m = Math.floor(ms % 3600000 / 60000),
        s = Math.floor(ms % 60000 / 1000), f = Math.floor(ms % 1000 / 10);
    var p = function (x) { return (x < 10 ? '0' : '') + x; };
    return p(h) + ':' + p(m) + ':' + p(s) + ',' + p(f);
  }
  // v1.5: ticks -> m:ss.cc (for the shootout clip timecodes)
  function fmtTicksTC(ticks) {
    var ms = Math.round(Number(ticks) / 254016); // ticks -> ms
    if (!isFinite(ms) || ms < 0) { ms = 0; }
    var m = Math.floor(ms / 60000), s = Math.floor(ms % 60000 / 1000), f = Math.floor(ms % 1000 / 10);
    var p = function (x) { return (x < 10 ? '0' : '') + x; };
    return p(m) + ':' + p(s) + '.' + p(f);
  }
  function decField(v) {
    try { return decodeURIComponent(v || ''); } catch (e) { return v || ''; }
  }
  // v2.3: long runs used to append hundreds of log <div>s — the log now keeps
  // only the newest MAX_LOG_LINES lines (older ones drop off the top; the
  // final summary is always at the bottom so nothing important is lost).
  var MAX_LOG_LINES = 60;
  function log(msg, cls) {
    var el = $('log');
    var line = document.createElement('div');
    if (cls) { line.className = cls; }
    line.textContent = msg;
    el.appendChild(line);
    try { while (el.children.length > MAX_LOG_LINES) { el.removeChild(el.firstChild); } } catch (eL) {}
    el.scrollTop = el.scrollHeight;
  }
  // v2.5 SILENT CONVERSION — «بدون پیغام برای هر لایه»: while converting,
  // NO message is shown for any layer (step messages, adaptive-pace notes,
  // per-layer warnings — all suppressed); only the progress counter updates.
  // Hard errors and the final summary ALWAYS show. Unconditional by design.
  function logDyn(msg, cls) {
    if (state.converting && cls !== 'err') { return; }
    log(msg, cls);
  }
  function setPath(elId, text, ok) {
    var el = $(elId);
    el.textContent = text;
    el.classList.toggle('empty', !ok);
    el.classList.toggle('ok', !!ok);
  }
  function saveSettings() {
    try {
      localStorage.setItem('s2g', JSON.stringify({
        mogrtPath: state.mogrtPath,
        font: $('inpFont').value,
        size: $('inpSize').value,
        clear: $('optClear').checked,
        playhead: $('optPlayhead').checked,
        engine: $('selEngine') ? $('selEngine').value : 'auto',
        wmode: $('selWriteMode') ? $('selWriteMode').value : 'uni',
        pace: $('selPace') ? $('selPace').value : '3000',
        quiet: $('optQuiet') ? $('optQuiet').checked : false
      }));
    } catch (e) {}
  }
  function loadSettings() {
    try {
      var s = JSON.parse(localStorage.getItem('s2g') || '{}');
      if (s.mogrtPath) { setMogrt(s.mogrtPath); }
      if (s.font) { $('inpFont').value = s.font; }
      if (s.size) { $('inpSize').value = s.size; }
      if (s.clear !== undefined) { $('optClear').checked = !!s.clear; }
      if (s.playhead !== undefined) { $('optPlayhead').checked = !!s.playhead; }
      // v2.0: engine selection
      if (s.engine && $('selEngine')) {
        for (var e = 0; e < $('selEngine').options.length; e++) {
          if ($('selEngine').options[e].value === s.engine) { $('selEngine').value = s.engine; state.engine = s.engine; break; }
        }
      }
      // v1.5: write strategy (decided by the 4-clip shootout in «تست قالب»)
      if (s.wmode && $('selWriteMode')) {
        for (var i = 0; i < $('selWriteMode').options.length; i++) {
          if ($('selWriteMode').options[i].value === s.wmode) { $('selWriteMode').value = s.wmode; break; }
        }
      }
      // v2.1: pace between layers (crash prevention)
      if (s.pace !== undefined && $('selPace')) { $('selPace').value = String(s.pace); }
      // v2.3: quiet mode during conversion
      if (s.quiet !== undefined && $('optQuiet')) { $('optQuiet').checked = !!s.quiet; state.quiet = !!s.quiet; }
    } catch (e) {}
    if ($('selPace')) { state.paceMs = parseInt($('selPace').value, 10) || 0; }
  }

  // ---------- JSX bridge ----------
  // fields whose values are additionally URI-encoded on the JSX side
  var AUTO_DECODE = { path: 1, name: 1, detail: 1 };

  function callJsx(fn, arg, cb) {
    var script = 's2g_' + fn + '(' + (arg !== undefined ? '"' + arg + '"' : '') + ')';
    cs.evalScript(script, function (res) {
      if (res === CSInterface.EVAL_SCRIPT_ERROR || res === 'EvalScript error.' || res === 'undefined' || res === '') {
        cb({ err: 'E_JSX', detail: String(res) });
        return;
      }
      var decoded;
      try { decoded = decodeURIComponent(res); } catch (e) { cb({ err: 'E_DEC', detail: String(e) }); return; }
      // parse pipe protocol
      var obj = {};
      var parts = decoded.split('|');
      for (var i = 0; i < parts.length; i++) {
        var eq = parts[i].indexOf('=');
        if (eq < 0) { continue; }
        var k = parts[i].substring(0, eq);
        var v = parts[i].substring(eq + 1);
        if (AUTO_DECODE[k]) {
          try { v = decodeURIComponent(v); } catch (e2) {}
        }
        obj[k] = v;
      }
      cb(obj);
    });
  }

  function checkConnection() {
    callJsx('ping', undefined, function (r) {
      var wasOn = state.connected;
      state.connected = !r.err && r.ok === '1';
      var el = $('connState');
      if (state.connected) {
        el.textContent = 'متصل به پریمیر ✓';
        el.className = 'conn on';
        if (!wasOn) {
          log('اتصال به پریمیر برقرار شد.', 'ok');
          // v2.2: host cannot park auto-save via script — tell the user once
          if (r.ver && r.ver.indexOf('2.2') === 0 && r.as === '0') {
            log('این نسخه‌ی پریمیر اجازه نمی‌دهد اسکریپت ذخیره‌سازی خودکار را خاموش کند؛ قبل از تبدیل‌های بزرگ خودتان آن را موقتاً خاموش کنید (Edit > Preferences > Auto Save).', 'warn');
          }
        }
      } else {
        el.textContent = 'خارج از پریمیر';
        el.className = 'conn off';
      }
    });
  }

  // ---------- template ----------
  function setMogrt(p) {
    state.mogrtPath = p;
    setPath('mogrtPath', p, true);
    $('btnConvert').disabled = !(state.mogrtPath && state.cues && state.cues.length && !state.converting);
    saveSettings();
  }

  // ---------- SRT loading ----------
  function loadSrtContent(content, name, anchorTicks, anchorMode, anchorTrack) {
    var parsed = parseSrt(content);
    if (!parsed.ok) {
      setPath('srtState', 'خطا در خواندن: ' + (parsed.error === 'NOCUES' ? 'هیچ زیرنویسی پیدا نشد' : 'فایل خالی'), false);
      log('خواندن SRT ناموفق بود (' + parsed.error + ').', 'err');
      state.cues = null;
      $('btnConvert').disabled = true;
      return;
    }
    state.cues = parsed.cues;
    state.anchorTicks = anchorTicks || 0;
    state.anchorMode = anchorMode;
    state.anchorTrack = (typeof anchorTrack === 'number' && !isNaN(anchorTrack)) ? anchorTrack : -1;
    state.srtName = name;
    var first = parsed.cues[0], last = parsed.cues[parsed.cues.length - 1];
    setPath('srtState', '«' + name + '» — ' + faNum(parsed.cues.length) + ' کیو (' +
      fmtTime(first.startMs) + ' تا ' + fmtTime(last.endMs) + ')', true);
    log(faNum(parsed.cues.length) + ' کیو از «' + name + '» بارگذاری شد. شروع اولین کیو: ' + fmtTime(first.startMs), 'ok');
    if (parsed.warnings.length) {
      log(faNum(parsed.warnings.length) + ' خط نامعتبر نادیده گرفته شد.', 'warn');
    }
    if (anchorMode === 'clip') {
      log('زمان‌بندی بر اساس محل کلیپ SRT روی تایم‌لاین تنظیم شد.', 'ok');
    } else if (anchorMode === 'playhead') {
      log('شروع از محل پلی‌هد.', 'ok');
    }
    updatePaceEst();
    $('btnConvert').disabled = !(state.mogrtPath && !state.converting);
  }

  function fromClip() {
    if (!requireConnection()) { return; }
    callJsx('getSelectedSrt', undefined, function (r) {
      if (r.err) { handleErr(r); return; }
      var content = readFileUtf8(r.path);
      if (content === null) {
        // fallback: read inside JSX
        callJsx('readFile', encodeURIComponent(r.path), function (r2) {
          if (r2.err || r2.ok !== '1') {
            log('فایل SRT قابل خواندن نیست: ' + r.path, 'err');
            return;
          }
          var data = '';
          try { data = decodeURIComponent(r2.data); } catch (e) { data = r2.data; }
          loadSrtContent(data, r.name, parseInt(r.anchorTicks, 10), 'clip', parseInt(r.track, 10));
        });
        return;
      }
      loadSrtContent(content, r.name, parseInt(r.anchorTicks, 10), 'clip', parseInt(r.track, 10));
    });
  }

  function browseSrt() {
    if (!requireConnection()) { return; }
    callJsx('browseSrt', undefined, function (r) {
      if (r.err) { if (r.err !== 'E_CANCEL') { handleErr(r); } return; }
      var content = readFileUtf8(r.path);
      if (content === null) {
        callJsx('readFile', encodeURIComponent(r.path), function (r2) {
          if (r2.err || r2.ok !== '1') { log('فایل SRT قابل خواندن نیست.', 'err'); return; }
          var data2 = '';
          try { data2 = decodeURIComponent(r2.data); } catch (e) { data2 = r2.data; }
          applyBrowse(r.path, data2);
        });
        return;
      }
      applyBrowse(r.path, content);
    });
  }

  function applyBrowse(path, content) {
    var name = path.split(/[\\/]/).pop();
    if ($('optPlayhead').checked) {
      callJsx('getPlayheadTicks', undefined, function (r) {
        var ticks = (r && !r.err && r.ticks) ? parseInt(r.ticks, 10) : 0;
        loadSrtContent(content, name, ticks, 'playhead');
      });
    } else {
      loadSrtContent(content, name, 0, 'file');
    }
  }

  function readFileUtf8(path) {
    try {
      var res = cepFile.readFile(path);
      if (res && res.err === 0 && typeof res.data === 'string' && res.data.length) {
        return res.data;
      }
    } catch (e) {}
    return null;
  }

  function requireConnection() {
    if (!state.connected) {
      log('پنل خارج از پریمیر باز شده است. داخل پریمیر (منوی Window > Extensions) بازش کنید.', 'err');
      return false;
    }
    return true;
  }

  function handleErr(r) {
    var msgs = {
      E_NOSEQ: 'هیچ سکانس فعالی باز نیست.',
      E_NOSEL: 'کلیپی در تایم‌لاین انتخاب نشده است. کلیپ SRT را انتخاب کنید.',
      E_NOTSRT: 'کلیپ انتخاب‌شده یک فایل SRT نیست. کلیپ زیرنویس (نه فایل ویدیو) را انتخاب کنید.',
      E_NOMOGRT: 'فایل قالب پیدا نشد؛ دوباره انتخابش کنید.',
      E_IMPORT: 'درج قالب در تایم‌لاین ناموفق بود. فایل mogrt را در خود پریمیر باز کنید تا سالم بودنش را ببینید.',
      E_PAYLOAD: 'خطای انتقال داده بین پنل و پریمیر.',
      E_NOCUES: 'هیچ زیرنویس معتبری در فایل پیدا نشد.',
      E_NOFILE: 'فایل قابل خواندن نیست.',
      E_CANCEL: null,
      E_JSX: 'خطای ارتباط با موتور اسکریپت.',
      E_DEC: 'خطای رمزگشایی داده.'
    };
    var m = msgs[r.err] || ('خطا: ' + r.err);
    if (m) { log(m, 'err'); }
  }

  // ---------- conversion ----------
  var TPS = 254016000000; // ticks per second

  // v2.0 BAKED ENGINE — bake one .mogrt per cue with the text already inside
  // v2.2 — now chunked/async: keeps the panel UI alive on big SRT files and
  // reports progress while baking (cb receives the bakeAllCues result shape).
  function bakeAllCuesAsync(onProgress, cb) {
    try {
      if (!window.MogrtBaker || !MogrtBaker.nodeAvailable()) { cb({ ok: false, error: 'Node در دسترس نیست' }); return; }
      MogrtBaker.cleanupTemp();
      // v2.4: bake UNIQUE texts only — identical cues share one baked file
      // (and later one imported projectItem). Faster bake, fewer near-clone
      // files for Premiere to juggle; the JSX per-hash master/dedupe logic
      // stays unchanged. cueMap[i] = index of the baked file for cue i.
      var list = [];
      var cueMap = [];
      var byKey = {};
      for (var i = 0; i < state.cues.length; i++) {
        var c = state.cues[i];
        var txt = c.text.replace(/\n/g, '\r\n');
        var k = textHash(txt);
        if (byKey[k] === undefined) {
          byKey[k] = list.length;
          list.push({
            startTicks: c.startMs * TICKS_PER_MS + state.anchorTicks,
            endTicks: c.endMs * TICKS_PER_MS + state.anchorTicks,
            text: txt,
            label: ' — ' + (list.length + 1)
          });
        }
        cueMap.push(byKey[k]);
      }
      var done = function (res) {
        if (res && res.ok) { res.cueMap = cueMap; res.uniqueN = list.length; }
        cb(res);
      };
      if (MogrtBaker.bakeCueListAsync) {
        MogrtBaker.bakeCueListAsync(state.mogrtPath, list, onProgress, done);
      } else {
        // v2.5: guarded sync fallback — a throw here must not hang the UI
        setTimeout(function () {
          try { done(MogrtBaker.bakeCueList(state.mogrtPath, list)); }
          catch (eBs) { done({ ok: false, error: String((eBs && eBs.message) || eBs) }); }
        }, 0);
      }
    } catch (e) { cb({ ok: false, error: String(e && e.message || e) }); }
  }

  // v2.3: ASCII-safe dedupe key for identical subtitle texts. The panel sends
  // one hash per cue; the JSX engine imports ONE mogrt per unique hash and
  // copies every repeat from it (Track.overwriteClip) — this is what keeps
  // RAM flat on dialogue-heavy SRT files. djb2 over the UTF-8 bytes + length
  // suffix; the raw Persian text itself never crosses the bridge.
  function textHash(s) {
    var bytes;
    try { bytes = unescape(encodeURIComponent(s || '')); } catch (eH) { bytes = String(s || ''); }
    var h = 5381;
    for (var i = 0; i < bytes.length; i++) { h = (((h << 5) + h) + bytes.charCodeAt(i)) >>> 0; }
    return h.toString(16) + 'x' + bytes.length;
  }

  function buildPayloadBaked(items, cueMap, startIdx) {
    var meta = [
      'mogrt=' + encodeURIComponent(state.mogrtPath),
      'clear=' + ($('optClear').checked ? '1' : '0'),
      'font=',
      'size=-1',
      'anchor=' + state.anchorTicks,
      'avoidTrack=' + (state.anchorMode === 'clip' && typeof state.anchorTrack === 'number' && state.anchorTrack >= 0 ? state.anchorTrack : -1),
      'wmode=uni',
      'baked=1',
      'startIdx=' + (startIdx > 0 ? startIdx : 0)
    ].join('|');
    var lines = [meta];
    for (var i = 0; i < state.cues.length; i++) {
      var c = state.cues[i];
      var it = items[(cueMap && cueMap[i] !== undefined) ? cueMap[i] : i];
      if (!it) { continue; }
      // v2.3: 4th field = text hash (ASCII hex) — drives the import dedupe
      var h = textHash(c.text);
      lines.push(it.startTicks + '\t' + it.endTicks + '\t' + encodeURIComponent(it.path) + (h ? ('\t' + h) : ''));
    }
    return encodeURIComponent(lines.join('\n'));
  }

  function bakeTestProbe() {
    try {
      if (!window.MogrtBaker || !MogrtBaker.nodeAvailable()) { return { ok: false, error: 'Node در دسترس نیست' }; }
      var probe = 'سلام! این متن آزمایشی موتور بیکری است ۱۲۳';
      var res = MogrtBaker.bakeCueList(state.mogrtPath, [{ startTicks: 0, endTicks: 0, text: probe }]);
      if (!res.ok) { return { ok: false, error: res.error }; }
      return { ok: true, path: res.items[0].path };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  }

  function buildPayload() {
    var font = $('inpFont').value.trim();
    var size = $('inpSize').value.trim();
    var meta = [
      'mogrt=' + encodeURIComponent(state.mogrtPath),
      'clear=' + ($('optClear').checked ? '1' : '0'),
      'font=' + encodeURIComponent(font),
      'size=' + (size === '' ? '-1' : size),
      'anchor=' + state.anchorTicks,
      'avoidTrack=' + (state.anchorMode === 'clip' && typeof state.anchorTrack === 'number' && state.anchorTrack >= 0 ? state.anchorTrack : -1),
      'wmode=' + ($('selWriteMode') ? $('selWriteMode').value : 'uni'),
      'startIdx=' + (state.startIdx > 0 ? state.startIdx : 0)
    ].join('|');
    var lines = [meta];
    for (var i = 0; i < state.cues.length; i++) {
      var c = state.cues[i];
      var s = c.startMs * TICKS_PER_MS + state.anchorTicks;
      var e = c.endMs * TICKS_PER_MS + state.anchorTicks;
      var text = c.text.replace(/\n/g, '\r\n');
      lines.push(s + '\t' + e + '\t' + encodeURIComponent(text));
    }
    return encodeURIComponent(lines.join('\n'));
  }

  function convert() {
    if (state.converting) { return; }
    if (!state.mogrtPath) { log('اول قالب گرافیکی (mogrt) را انتخاب کنید.', 'err'); return; }
    if (!state.cues || !state.cues.length) { log('اول فایل SRT را بارگذاری کنید.', 'err'); return; }
    if (!requireConnection()) { return; }

    // v2.4: resume — «ادامه از لایه» (UI 1-based → payload 0-based)
    var resumeFrom = 0;
    if ($('inpResume')) {
      var rv = parseInt($('inpResume').value, 10);
      if (!isNaN(rv) && rv > 1) { resumeFrom = rv - 1; }
      if (resumeFrom > state.cues.length) { resumeFrom = state.cues.length; }
      $('inpResume').value = '';
    }
    state.startIdx = resumeFrom;

    saveSettings();
    state.converting = true;
    state.abort = false;
    state.lastFailN = 0;   // v2.2: adaptive pacing tracker
    state.curPace = state.paceMs; // v2.2: current (adaptive) pace
    state.stepBusy = false; state.stepLost = 0; state.stepTs = 0; // v2.5 watchdog state
    $('btnConvert').disabled = true;
    $('btnAbort').classList.remove('hidden');
    $('progressBox').classList.remove('hidden');
    $('progressBar').style.width = '0%';
    $('progressText').textContent = 'شروع…';
    log('— تبدیل شروع شد («' + state.srtName + '» ← ' + faNum(state.cues.length) + ' لایه) —');
    // v2.4: resume notice
    if (resumeFrom > 0) {
      log('رزوم: از لایه‌ی ' + faNum(resumeFrom + 1) + ' ادامه می‌دهیم — لایه‌های قبلی دست‌نخورده می‌مانند.', '');
    }
    // v2.2: adaptive anti-crash notice
    if (state.paceMs > 0) {
      log('حالت ضدکرش فعال: مکث ' + faNum(state.paceMs / 1000) + ' ثانیه‌ای بین لایه‌ها + نفس تازه‌ی هر ۱۰ لایه. اگر لایه‌ای ناموفق شد، مکث خودکار بیشتر می‌شود.', '');
    } else {
      log('مکث بین لایه‌ها خاموش است — اگر پریمیر دوباره کرش کرد، مکث را در بخش مقصد فعال کنید.', 'warn');
    }

    // v2.0: engine selection — baked (default) with automatic fallback
    var engine = state.engine || 'auto';
    if (engine === 'auto' || engine === 'bake') {
      log('موتور بیکری: ساخت قالب اختصاصی برای هر لایه…');
      $('progressText').textContent = 'آماده‌سازی قالب‌های بیکری…';
      bakeAllCuesAsync(function (p) {
        $('progressText').textContent = 'آماده‌سازی قالب‌های بیکری: ' + faNum(p.done) + ' از ' + faNum(p.total) + '…';
      }, function (bake) {
        if (state.abort) { finishConversion(); log('تبدیل توسط کاربر لغو شد.', 'warn'); return; }
        if (bake.ok) {
          log('بیکری آماده شد — ' + faNum(bake.items.length) + ' قالب اختصاصی (برای ' + faNum(state.cues.length) + ' لایه، متن‌های تکراری مشترک) ✓', 'ok');
          log('پوشه‌ی فایل‌های بیکری (رسید گرافیکی پروژه — پاکش نکنید): ' + bake.dir, '');
          var payloadB = buildPayloadBaked(bake.items, bake.cueMap, state.startIdx);
          callJsx('convertStart', payloadB, function (r) { afterStart(r, true); });
          return;
        }
        if (engine === 'bake') {
          finishConversion();
          log('موتور بیکری در دسترس نیست: ' + bake.error, 'err');
          return;
        }
        log('موتور بیکری در دسترس نیست (' + bake.error + ') — به موتور نوشتن مستقیم برمی‌گردیم.', 'warn');
        var payload = buildPayload();
        callJsx('convertStart', payload, function (r) { afterStart(r, false); });
      });
      return;
    }

    var payload = buildPayload();
    callJsx('convertStart', payload, function (r) { afterStart(r, false); });
  }

  function afterStart(r, baked) {
    if (r.err) {
      finishConversion();
      handleErr(r);
      if (r.err === 'E_NOTRACK') { log('پریمیر ترک خالی پیدا نکرد و ترک جدید هم اضافه نشد. یک ترک ویدیویی خالی بسازید و دوباره تلاش کنید.', 'err'); }
      return;
    }
    // v2.2: protective-save + auto-save parking reports
    if (r.saved === '1') { log('پروژه قبل از تبدیل ذخیره شد ✓ (نقطه‌ی بازیابی امن در صورت کرش)', 'ok'); }
    if (r.asoff === '1') { log('ذخیره‌سازی خودکار پریمیر در طول تبدیل موقتاً خاموش شد تا با درج لایه‌ها تداخل نکند.', ''); }
    log('ترک مقصد: V' + faNum(parseInt(r.track, 10) + 1) +
      (r.cleared === '1' ? ' (پاک‌سازی شد)' : '') +
      ' — ' + (baked ? 'در حال درج لایه‌های بیکری…' : 'قالب بارگذاری شد، در حال ساخت لایه‌ها…'));
    // v2.2: give Premiere a settle beat after track setup before the first import
    setTimeout(stepLoop, 800);
  }

  function stepLoop() {
    if (state.abort) {
      callJsx('convertAbort', undefined, function () {});
      finishConversion();
      log('تبدیل توسط کاربر لغو شد.', 'warn');
      return;
    }
    // v2.5: busy/watchdog bookkeeping — if this call is never answered
    // (evalScript lost, Premiere hung), the watchdog recovers the loop.
    state.stepBusy = true;
    state.stepTs = Date.now();
    callJsx('convertStep', undefined, function (r) {
      state.stepBusy = false;
      state.stepLost = 0;
      try {
      if (r.err) {
        finishConversion();
        if (r.err === 'E_NOSEQ') {
          log('سکانس فعال عوض شده یا بسته شده است! همان سکانس قبلی را فعال کنید و با «ادامه از لایه» ادامه دهید.', 'err');
        } else {
          log('خطا در حین تبدیل: ' + (r.detail || r.err), 'err');
        }
        return;
      }
      var done = parseInt(r.done, 10), total = parseInt(r.total, 10);
      var pct = total ? Math.round(done * 100 / total) : 100;
      $('progressBar').style.width = pct + '%';
      $('progressText').textContent = faNum(pct) + '٪ — ' + faNum(done) + ' از ' + faNum(total);
      // v2.4 crash-resume anchor: remember the next layer so a host crash can
      // be recovered with «ادامه از لایه» after restarting Premiere.
      try { localStorage.setItem('s2gResume', JSON.stringify({ srt: state.srtName, mogrt: state.mogrtPath, next: done + 1, total: total, ts: Date.now() })); } catch (eR) {}
      if (r.msg) { logDyn(decodeURIComponent(r.msg), r.msgClass || ''); }
      if (r.finish === '1') {
        finishConversion();
        try { localStorage.removeItem('s2gResume'); } catch (eR2) {}
        var okN = parseInt(r.okN, 10), failN = parseInt(r.failN, 10);
        if (okN === 0 && failN > 0) {
          log(faNum(failN) + ' لایه ساخته شد اما هیچ متنی روی‌شان نوشته نشد!', 'err');
          log('دکمه‌ی «تست قالب» را بزنید تا علت دقیق مشخص شود؛ معمولاً باید قالب را طبق راهنما دوباره بسازید.', 'warn');
        } else if (failN > 0) {
          log('پایان یافت: ' + faNum(okN) + ' موفق، ' + faNum(failN) + ' ناموفق.', 'warn');
        } else {
          log('پایان یافت — ' + faNum(okN) + ' لایه گرافیکی همراه با متن ساخته شد ✓', 'ok');
          log('لایه‌ها را در پنل Essential Graphics هم می‌توانید ویرایش کنید.', 'ok');
        }
        if (r.verifyWarn === '1') {
          log('بازخوانی متن روی برخی لایه‌ها تأیید نشد؛ در پریمیر بررسی کنید که متن‌ها دیده می‌شوند.', 'warn');
        }
        // v2.2: stability bookkeeping reports
        if (r.asrest === '1') { log('ذخیره‌سازی خودکار پریمیر دوباره فعال شد ✓', ''); }
        if (r.reused && parseInt(r.reused, 10) > 0) {
          log('بهینه‌سازی v2.2: ' + faNum(parseInt(r.reused, 10)) + ' لایه بدون ایمپورت مجدد، از همان رسید گرافیکی ساخته شدند ✓', 'ok');
        }
        // v2.3: dedupe + mid-run save summaries + RAM-release hint
        if (r.dupN && parseInt(r.dupN, 10) > 0) {
          log('بهینه‌سازی v2.3: ' + faNum(parseInt(r.dupN, 10)) + ' لایه‌ی با متن تکراری بدون ایمپورت جدید، از همان قالب مشترک ساخته شدند ✓ (کاهش مصرف رم)', 'ok');
        }
        if (r.savedN && parseInt(r.savedN, 10) > 0) {
          log('ذخیره‌ی میانی پروژه ' + faNum(parseInt(r.savedN, 10)) + ' بار انجام شد ✓ (نقاط بازیابی وسط کار)', '');
        }
        log('نکته‌ی حافظه: برای آزادسازی کامل رم (تخلیه‌ی تاریخچه Undo و کش گرافیک)، پروژه را ذخیره و یک‌بار ببندید و دوباره باز کنید.', '');
      } else {
        // v2.2 adaptive anti-crash pacing: the user's base pause + automatic
        // doubling on failure (max 10s) + a deep breath every 10 layers.
        if (state.paceMs > 0) {
          var failNow = parseInt(r.failN, 10) || 0;
          var hadFail = failNow > (state.lastFailN || 0);
          state.lastFailN = failNow;
          if (hadFail && state.curPace < 10000) {
            state.curPace = Math.min(state.curPace * 2, 10000);
            logDyn('یک لایه ناموفق شد — مکث احتیاطی به ' + faNum(state.curPace / 1000) + ' ثانیه افزایش یافت.', 'warn');
          } else if (!hadFail && state.curPace !== state.paceMs) {
            state.curPace = state.paceMs;
            logDyn('درج‌ها دوباره روان شد — مکث به تنظیم شما (' + faNum(state.paceMs / 1000) + ' ثانیه) برگشت.', '');
          }
          var deep = (done > 0 && done % 10 === 0) ? 2000 : 0;
          paceWait(state.curPace + deep, pct, done, total);
        } else {
          setTimeout(stepLoop, 0);
        }
      }
      } catch (eStep) {
        // v2.5: a single bad response must never freeze the progress bar —
        // stop gracefully; the resume feature lets the user continue.
        finishConversion();
        log('خطای غیرمنتظره در حلقه تبدیل (' + String((eStep && eStep.message) || eStep) + ') — تبدیل متوقف شد. با «ادامه از لایه» می‌توانید از همین نقطه ادامه دهید.', 'err');
      }
    });
  }

  // v2.1: countdown pause between layers — interruptible by «لغو» within 500ms
  function paceWait(ms, pct, done, total) {
    var remain = ms;
    state.paceTimer = setInterval(function () {
      if (state.abort) { clearInterval(state.paceTimer); state.paceTimer = null; stepLoop(); return; }
      remain -= 500;
      if (remain <= 0) {
        clearInterval(state.paceTimer);
        state.paceTimer = null;
        stepLoop();
      } else {
        $('progressText').textContent = faNum(pct) + '٪ — لایه ' + faNum(done) + ' از ' + faNum(total) +
          ' — مکث ' + faNum(Math.ceil(remain / 1000)) + ' ثانیه‌ای تا لایه بعد…';
      }
    }, 500);
  }

  function finishConversion() {
    state.converting = false;
    state.stepBusy = false;
    state.stepLost = 0;
    if (state.paceTimer) { clearInterval(state.paceTimer); state.paceTimer = null; }
    $('btnAbort').classList.add('hidden');
    $('btnConvert').disabled = !(state.mogrtPath && state.cues && state.cues.length);
  }

  // v2.1: rough total-time estimate for the chosen pace, shown next to the selector
  function updatePaceEst() {
    var el = $('paceEst');
    if (!el) { return; }
    var pace = ($('selPace') ? parseInt($('selPace').value, 10) : state.paceMs) || 0;
    if (!state.cues || !state.cues.length) {
      el.textContent = 'بعد از بارگذاری SRT محاسبه می‌شود';
      return;
    }
    var n = state.cues.length;
    var perLayer = pace / 1000 + 0.6 + 0.2; // + ~0.6s import + ~0.2s avg deep-breath share
    var sec = Math.round(n * perLayer);
    var txt;
    if (sec < 90) { txt = '≈ ' + faNum(sec) + ' ثانیه'; }
    else { txt = '≈ ' + faNum(Math.round(sec / 60)) + ' دقیقه'; }
    el.textContent = faNum(n) + ' لایه × مکث ' + faNum(pace / 1000) + ' ثانیه ' + txt;
  }

  // ---------- wire up ----------
  // v2.5: guarded wiring — a missing element can never break init or the
  // bindings that come after it (panel stays fully functional).
  function on(id, ev, fn) {
    var el = $(id);
    if (el) { el.addEventListener(ev, fn); return true; }
    return false;
  }

  on('btnPickMogrt', 'click', function () {
    if (!requireConnection()) { return; }
    callJsx('browseMogrt', undefined, function (r) {
      if (r.err) { if (r.err !== 'E_CANCEL') { handleErr(r); } return; }
      setMogrt(r.path);
      log('قالب انتخاب شد: ' + r.path.split(/[\\/]/).pop(), 'ok');
    });
  });

  // Diagnostic v1.5: 1 diagnostic clip + a 4-clip write-strategy shootout.
  // Whichever clip shows correct Persian on the timeline decides the panel's
  // «حالت نوشتن متن» setting — that mode then drives the real conversion.
  on('btnTestMogrt', 'click', function () {
    if (!requireConnection()) { return; }
    if (!state.mogrtPath) { log('اول قالب گرافیکی (.mogrt) را انتخاب کنید.', 'err'); return; }
    log('۶ کلیپ آزمایشی در محل پلی‌هد ساخته می‌شود (۱ تشخیصی + ۴ شوترای حالت نوشتن + ۱ بیکری)…');
    callJsx('testMogrt', encodeURIComponent(state.mogrtPath), function (r) {
      if (r.err) {
        handleErr(r);
        if (r.err === 'E_NOTRACK') { log('پنل می‌کوشد خودش ترک ویدیویی اضافه کند؛ اگر باز هم خطا داد، یک ترک ویدیویی خالی بسازید و دوباره کلیک کنید.', 'err'); }
        return;
      }
      var howFa = {
        name: 'تشخیص با نام پارامتر',
        value: 'تشخیص با متن فعلی قالب',
        probe: 'تشخیص کاوشی — متن قالب خالی بود (باگ نسخه‌ی قبل همین بود)',
        'probe-loose': 'تشخیص کاوشی',
        blind: 'تشخیص با نوشتن آزمایشی'
      };
      if (r.params) {
        var lines = decField(r.params);
        if (lines) {
          var arr = lines.split('\n');
          for (var i = 0; i < arr.length; i++) { log('پارامتر: ' + arr[i], ''); }
        }
      }
      if (r.how && r.how !== 'none') {
        log('پارامتر متن: «' + decField(r.pname) + '» — ' + (howFa[r.how] || r.how), 'ok');
        // v1.5: raw hex of what getValue really returns — the ground truth
        if (r.rd0p) { log('\u200Eخوانش خام پریمیر (قبل از دیکد): ' + decField(r.rd0p), ''); }
        if (r.rd0d) { log('\u200Eپس از دیکد: ' + decField(r.rd0d), ''); }
        if (r.mg && r.mg !== '0') {
          log('پیشوند سند قالب (بازیابی‌شده): U+' + Number(r.mg).toString(16).toUpperCase() + ' — پنل همین را برای نوشتن بازسازی می‌کند.', '');
        }
        // v1.5 shootout results
        var nS = parseInt(r.shots || '0', 10);
        if (nS > 0) {
          var modeFa = {
            uni: '۱ — یونیکد + سند ASCII',
            bytes: '۲ — بایتی (نسخه ۱٫۴)',
            raw: '۳ — یونیکد + متن خام',
            noprefix: '۴ — سند بدون پیشوند'
          };
          for (var s = 0; s < nS; s++) {
            var shv = decField(r['sh' + s]);
            if (!shv) { continue; }
            var pp = shv.split('|');
            if (pp[0] === 'IMPORT_FAIL') { log('کلیپ ' + faNum(s + 1) + ' — درج ناموفق', 'err'); continue; }
            if (pp[0] === 'NOPARAM') { log('کلیپ ' + faNum(s + 1) + ' — پارامتر متن پیدا نشد', 'err'); continue; }
            var mode = pp[0] || '?', mk = pp[1] || '?';
            var tc = fmtTicksTC(parseInt(pp[2] || '0', 10));
            var setOk = (pp[3] || '').indexOf('1') >= 0;
            var via = (pp[4] || '').replace('via=', '');
            var rbOk = ((pp[6] || '').replace('ok=', '') === '1');
            var rbTxt = '';
            var rbIdx = shv.indexOf('rb=');
            if (rbIdx >= 0) { rbTxt = shv.substring(rbIdx + 3); }
            log('کلیپ ' + faNum(s + 1) + ' — حالت ' + (modeFa[mode] || mode) +
              ' — متن «' + mk + '» @ \u200E' + tc +
              (setOk ? ' — نوشته شد' + (via ? ' (' + via + ')' : '') : ' — نوشتن ناموفق!') +
              (rbOk ? ' — بازخوانی ✓' : ''), setOk ? (rbOk ? 'ok' : '') : 'err');
            if (rbTxt) { log('\u200Eبازخوانی: ' + rbTxt, ''); }
          }
          log('حالا این ۴ کلیپ را در تایم‌لاین ببینید: هرکدام متن فارسیِ سالم نشان داد، همان شماره را در «حالت نوشتن متن» (بخش مقصد) انتخاب کنید و تبدیل را اجرا کنید.', 'ok');
          log('اگر هیچ‌کدام متن سالم نشان نداد، این گزارش را کامل کپی و برای من بفرستید — خط‌های n=[hex] تعیین‌کننده‌اند.', 'warn');
        }

        // v2.0: the 6th test clip — BAKED engine (text already inside the file).
        // This one bypasses setValue entirely; if Persian shows correctly here
        // but not in the 4 shots above, the bridge is the culprit and the
        // baked engine (default) will just work.
        if (r.ticks) {
          var probe = bakeTestProbe();
          if (probe.ok) {
            var stepT = Math.floor(1.5 * TPS);
            var t6 = parseInt(r.ticks, 10) + 5 * stepT;
            callJsx('importBakedAt', encodeURIComponent(probe.path) + '|' + t6 + '|' + stepT, function (rb) {
              if (rb.err) { log('کلیپ بیکری ساخته نشد (' + rb.err + ')', 'warn'); return; }
              log('کلیپ ۶ («بیکری») — متن فارسی از پیش داخل قالب کاشته شده @ \u200E' + fmtTicksTC(t6) + ' — این باید فارسیِ سالم باشد.', 'ok');
              log('اگر «بیکری» سالم بود: در «موتور تبدیل» گزینه‌ی بیکری را نگه دارید — دیگر نیازی به حالت‌های نوشتن نیست.', 'ok');
            });
          } else {
            log('موتور بیکری برای تست در دسترس نیست (' + probe.error + ').', 'warn');
          }
        }
        // template style capabilities (v1.2)
        var fc = (r.fontCtl === '1'), sc = (r.sizeCtl === '1');
        if (fc || sc) {
          log('کنترل‌های قالب — فونت: ' + (fc ? 'قابل تغییر ✓' : 'قفل') + '، اندازه: ' + (sc ? 'قابل تغییر ✓' : 'قفل'), fc || sc ? 'ok' : '');
          if (!fc) { log('فونت قالب قابل تغییر از پنل نیست؛ برای فونت دلخواه، قالب را با همان فونت بسازید.', 'warn'); }
        } else {
          log('این قالب فونت/اندازه را قفل کرده؛ استایل از خود قالب اعمال می‌شود (مشکلی نیست، فقط قابل تغییر از پنل نیست).', 'warn');
        }
      } else {
        var diag = decField(r.diag);
        log('هیچ پارامتر متنی در قالب پیدا نشد!' + (diag ? ' پارامترها: ' + diag : ''), 'err');
        log('قالب باید یک لایه‌ی متن داشته باشد؛ طبق راهنمای ساخت قالب دوباره بسازید.', 'err');
      }
    });
  });

  on('btnFromClip', 'click', fromClip);
  on('btnBrowseSrt', 'click', browseSrt);
  on('btnConvert', 'click', convert);
  on('btnAbort', 'click', function () { state.abort = true; });
  on('optPlayhead', 'change', saveSettings);
  on('optClear', 'change', saveSettings);
  if ($('optQuiet')) {
    $('optQuiet').addEventListener('change', function () {
      state.quiet = $('optQuiet').checked;
      saveSettings();
    });
  }
  on('selWriteMode', 'change', saveSettings);
  on('selEngine', 'change', saveSettings);
  on('selPace', 'change', function () {
    state.paceMs = parseInt($('selPace').value, 10) || 0;
    saveSettings();
    updatePaceEst();
  });
  on('inpFont', 'change', saveSettings);
  on('inpSize', 'change', saveSettings);

  on('btnGuide', 'click', function () { var m = $('modal'); if (m) { m.classList.remove('hidden'); } });
  on('btnCloseModal', 'click', function () { var m = $('modal'); if (m) { m.classList.add('hidden'); } });

  // init
  loadSettings();
  checkConnection();
  updatePaceEst();
  // v2.4: crash-resume hint from a previous session (CEP localStorage
  // survives Premiere restarts — the anchor is written after every layer)
  try {
    var rz = JSON.parse(localStorage.getItem('s2gResume') || 'null');
    if (rz && rz.next && rz.ts && (Date.now() - rz.ts) < 7 * 24 * 3600 * 1000) {
      log('اجرای قبلی تا لایه‌ی ' + faNum(rz.next) + ' (از ' + faNum(rz.total) + ') پیش رفته بود. اگر پریمیر کرش کرد: بعد از بازنشانی، همان SRT و قالب را انتخاب و در «ادامه از لایه» عدد ' + faNum(rz.next + 1) + ' را وارد کنید (بهترین نقطه: مضرب ۱۰ + ۱).', 'warn');
    }
  } catch (eRz) {}
  if (window.MogrtBaker && MogrtBaker.nodeAvailable()) {
    log('موتور بیکری فعال است (نسخه ۲) — متن فارسی مستقیم داخل قالب کاشته می‌شود و از پل اسکریپت رد نمی‌شود.', 'ok');
  } else {
    log('موتور بیکری در این محیط در دسترس نیست؛ از موتور نوشتن مستقیم استفاده می‌شود.', 'warn');
  }
  setInterval(function () { try { if (!state.connected) { checkConnection(); } } catch (eC) {} }, 3000);

  // v2.5 watchdog: if Premiere stops answering convertStep (evalScript lost,
  // host busy/hung), recover the loop automatically instead of freezing.
  setInterval(function () {
    try {
      if (!state.converting || !state.stepBusy || state.paceTimer) { return; }
      if (Date.now() - (state.stepTs || 0) < 90000) { return; }
      state.stepLost = (state.stepLost || 0) + 1;
      if (state.stepLost <= 2) {
        state.stepTs = Date.now();
        state.stepBusy = false;
        log('پاسخ پریمیر قطع شد — تلاش مجدد خودکار…', 'warn');
        setTimeout(stepLoop, 1500);
      } else {
        state.stepBusy = false;
        finishConversion();
        log('ارتباط با پریمیر چند بار بی‌پاسخ شد؛ تبدیل متوقف گردید. با «ادامه از لایه» می‌توانید ادامه دهید.', 'err');
      }
    } catch (eW) {}
  }, 10000);
})();
