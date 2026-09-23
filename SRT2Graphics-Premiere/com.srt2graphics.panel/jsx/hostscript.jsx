/* eslint-disable */
// SRT2Graphics v2.4 — ExtendScript engine for Adobe Premiere Pro (CEP ScriptPath)
// v2.4 ROOT-CAUSE anti-crash hardening (host hard-crashed on the transition
// from layer 1 to layer 2 even with long pauses — pauses can't fix a
// deterministic collision):
//   • NO $.gc() between layers anymore. v2.1/v2.2 gc'd once per layer (crash
//     "after a few layers"); v2.3 gc'd twice (crash moved EARLIER, to layer
//     2). $.gc() in Premiere's ExtendScript host runs while the graphics
//     engine still holds live wrapper references — the more we gc'd, the
//     earlier the host went down. Now the ONLY gc is one guarded pass at
//     finish, after S2G.state is dropped and nothing is in flight.
//   • FRESH OBJECT RESOLUTION per step: st.seq / st.vTrack are re-resolved
//     from app.project.activeSequence at every convertStep and the sequence
//     name is verified — stale cross-call wrappers can no longer touch a
//     dead/changed object model (graceful E_NOSEQ instead).
//   • RESUME (startIdx): convertStart accepts startIdx=N (0-based) so a run
//     aborted by a crash can continue from layer N+1 instead of starting
//     over. Pairs with the v2.3 mid-run protective saves.
//   • The decisive fix lives in mogrtbaker.js: every baked file now carries
//     its own RE-ISSUED object identities (ObjectUID/ObjectURef/ClipID).
//     v2.0..v2.3 shipped identical identities in every sibling file; import
//     #1 registered them, import #2 collided inside Premiere's object
//     registry — an uncatchable native crash that no pause can avoid.
// v2.3 RAM hardening (kept):
//   • BAKED-ENGINE DEDUPE — identical subtitle texts share ONE imported
//     projectItem: the panel sends an ASCII hash per cue, the first import of
//     a hash becomes the master and every further cue with the same hash is
//     placed via Track.overwriteClip(masterItem) instead of a fresh (heavy)
//     importMGT. Falls back to importMGT automatically when reuse fails.
//   • MID-RUN protective project save every N layers (default 10).
//   • finish protocol reports dupN / savedN so the panel can summarize.
// v2.2 anti-crash hardening:
//   • value engine imports the mogrt ONCE, then re-uses its projectItem via
//     Track.overwriteClip (no per-cue re-import/parse of the same file)
//   • Premiere auto-save is parked OFF during the batch, restored after
//   • one protective project save before the batch (never on untitled projects)
//   • one guarded in-place retry when an import fails transiently
//   • state + references are dropped and GC'd when the run finishes
// Protocol: pipe/tab separated, all strings encodeURIComponent-ed (no JSON dependency).
// Globals: app, qe, $, File, Folder, UnitValue
//
// v1.5 fix — THE decisive write-strategy shootout + encoding-immune documents.
//  Field evidence from the user's host (v1.4 "تست قالب" log):
//   • getValue of the template's own Source Text STILL returns ONE mangled
//     char ("Ɛ") even after byte-decoding → the doc's JSON body (which sits
//     BEHIND the 4-char prefix magic + 3 NULs) never reaches ExtendScript on
//     this host: the bridge truncates the value at the first NUL byte.
//     Reads are permanently lossy for doc-typed params there — no round-trip.
//   • The read-back CHANGED after our write («Ɛ» → another glyph) → writes DO
//     land; but v1.4 byte-encoded the WHOLE doc, mangling BOTH the prefix and
//     the Persian inside the JSON on a Unicode-native host → engine rejects
//     the doc → text vanishes (the original symptom).
//   • "phLen=39" was our own test string's length (synth mode reported
//     phLen=text.length) — the "39-char capacity" warning was noise. Fixed.
//  v1.5 therefore:
//   • Doc bodies are now PURE ASCII: every non-ASCII char (Persian, ZWNJ, …)
//     is serialized as \uXXXX inside the JSON. ASCII survives ANY marshalling
//     byte-for-byte, so the body can no longer be corrupted in transit.
//   • Writes are RAW Unicode by default (wmode=uni — the forum-proven form);
//     v1.4's byte mode stays available (wmode=bytes) plus raw-body (wmode=raw)
//     and prefix-less doc (wmode=noprefix) variants.
//   • The prefix magic is PERSONALIZED: when the read remnant is a single
//     mangled char, that char IS the doc's first char (NUL truncation), so we
//     rebuild the prefix from it instead of assuming the forum's U+0992.
//   • testMogrt now runs a 4-clip SHOOTOUT (one clip per strategy, distinct
//     Persian markers) and dumps the RAW hex of what getValue returns, so the
//     user's eyes + the hex decide the right mode. The panel gets a «حالت
//     نوشتن متن» selector that feeds conversion (S2G.writeMode).
//   • E_NOTRACK: after qe.addVideoTrack() the track count is POLLED ($.sleep)
//     instead of read once — one click now suffices, no stray track leaks.
// v1.4 fix — THE Unicode string-exchange layer (user evidence: even the
//  template's OWN default Persian text reads back as garbage — e.g. a Persian
//  placeholder shows up as a single mangled char like "Ɛ" — so the corruption
//  happens inside the ExtendScript <-> MOGRT string marshalling, in BOTH
//  directions, before any of our logic runs. getValue of the untouched
//  template was already broken, which also made the v1.3 "verify" meaningless:
//  a mangled write read back mangled and compared equal).
//  ExtendScript hands strings to the MOGRT text engine as raw BYTE strings;
//  multi-byte characters (Persian/Arabic/...) are mangled or lost. Fix = the
//  classic ExtendScript codec, applied at every boundary:
//    • s2g_toByteStr(str)  = unescape(encodeURIComponent(str)) — Unicode ->
//      UTF-8 byte string (one Latin-1 char per byte) BEFORE every setValue.
//    • s2g_fromByteStr(str) = decodeURIComponent(escape(str)) — byte string
//      -> Unicode right AFTER every getValue.
//    • ALL string writes now go through s2g_writeParam() (byte-encodes).
//    • ALL string reads go through s2g_readParamString() / s2g_scanParams()
//      (byte-decode), so the parameter report finally shows real Persian and
//      the verify compares DECODED text against the original — verify is now
//      meaningful. Garbage remnants like "Ɛ" (U+0190) are now classified as
//      doc remnants too, so the synthesized-document fallback engages.
// v1.3 fix — THE "text flashes then vanishes" root cause (confirmed by Adobe staff
//  on the Adobe forums — "Mogrt getValue returns JSON in Extendscript" and
//  "Premiere Pro ExtendScript changing the text of a MOGRT"):
//  The text parameter of a graphics/MOGRT clip is NOT a plain string. getValue()
//  returns a serialized TEXT DOCUMENT:
//   • Premiere-authored templates: 4-char binary prefix + JSON
//     {"mTextParam":{"mStyleSheet":{"mText":"...",...},...},"mVersion":1}
//   • AE-authored templates: JSON {"textEditValue":"...","fontTextRunLength":[n],...}
//  v1.2 wrote a plain string over that document → the text engine re-parses,
//  fails, and renders the clip EMPTY (text shows for a moment, then vanishes —
//  exactly the user-reported symptom). v1.3 round-trips the document: parse the
//  JSON, update ONLY the text fields, write back the FULL JSON (prefix kept).
//  AE docs also need fontTextRunLength = [text.length] or the text is dropped.
//  Premiere docs have a HARD cap: text longer than the template's original
//  placeholder gets discarded (Adobe DVAPR-4212165) — we now measure the
//  placeholder and warn the user instead of silently losing subtitles.
//
// v1.2 fix — THE "clips created but empty" root cause:
//  v1.1 scanned parameters via component.properties — but the Premiere API has
//  NO such member. Component exposes its parameters through `params`
//  (a ComponentParamCollection with numItems + [i]); a ComponentCollection is
//  counted with numComponents. Because .properties is undefined, every
//  component was skipped, zero parameters were ever found, and no text was
//  ever written — clips appeared with correct timing but empty text.
//  Now: s2g_getParamCollection() tries params -> properties -> indexed
//  fallbacks, so discovery works on every host layout.
//
// v1.1 fixes (kept):
//  - Text param discovery with 4 strategies: name-match -> longest value ->
//    probe round-trip -> blind write on unreadable params.
//  - Timing is written BEFORE text (text is the last write, so trims never wipe it).
//  - Cue overlaps pre-clamped at parse time.
//  - setValue fallback (with and without time argument) + read-back verify.
//  - s2g_testMogrt: inserts one diagnostic clip + full parameter report +
//    font/size capability flags (fontCtl / sizeCtl).

var S2G = S2G || {};
// v1.5: write strategy selected in the panel (uni | bytes | raw | noprefix);
// the 4-clip shootout in «تست قالب» decides it for the host at hand.
S2G.writeMode = 'uni';

// A text-ish parameter name (any language)
var S2G_TEXT_NAME_RE = /text|متن|زیرنویس|caption|subtitle|titel|title|legend|نوشته/i;
// Names that must never be treated as the text param
var S2G_STYLE_NAME_RE = /font|فونت|fam|size|اندازه|style|استایل|color|رنگ|opacity|weight|tracking|leading|align|justify|position|مکان|background|پس.?زمینه|shadow|سایه|stroke|دورخط/i;

// ---------------- byte-string codec (v1.4) ----------------

// Unicode -> UTF-8 byte string (each byte carried as one Latin-1 char).
// Applied to EVERY string passed to prop.setValue — the MOGRT text engine
// receives our bytes 1:1 instead of mangling multi-byte characters.
function s2g_toByteStr(str) {
  try { return unescape(encodeURIComponent(String(str))); } catch (e) { return str; }
}

// UTF-8 byte string -> Unicode (inverse of s2g_toByteStr).
// Applied to EVERY string returned by prop.getValue — idempotent for values
// that arrive as proper Unicode (chars >= 0x100 round-trip unchanged), so it
// is safe on every host.
function s2g_fromByteStr(str) {
  try { return decodeURIComponent(escape(String(str))); } catch (e) { return str; }
}

// ---------------- text-document engine (v1.3) ----------------

function s2g_jsonOk() {
  return (typeof JSON !== 'undefined' && JSON && typeof JSON.parse === 'function');
}

// v1.5: JSON-string escape that produces PURE printable-ASCII output —
// backslash/quote first, then EVERY control char and every char >= 0x7F as
// \uXXXX. An ASCII-only body survives any byte/char marshalling unmangled.
function s2g_jsonEscape(s) {
  var out = String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  out = out.replace(/[\u0000-\u001F\u007F-\uFFFF]/g, function (ch) {
    var h = ch.charCodeAt(0).toString(16);
    return '\\u' + '0000'.substring(h.length) + h;
  });
  return out;
}

// v1.5: escape every non-ASCII char of an ALREADY-serialized JSON document
// into \uXXXX so the whole payload becomes pure ASCII (structure untouched;
// surrogate halves are escaped individually — valid JSON, parsers recombine).
function s2g_asciiify(s) {
  return String(s).replace(/[\u007F-\uFFFF]/g, function (ch) {
    var h = ch.charCodeAt(0).toString(16);
    return '\\u' + '0000'.substring(h.length) + h;
  });
}

// v1.5 diagnostic: hex-dump the first `maxU` UTF-16 units of a raw value so
// the panel log shows EXACTLY what the host marshalling produced.
function s2g_hexDump(s, maxU) {
  s = String(s);
  var n = Math.min(s.length, maxU || 16);
  var parts = [];
  for (var i = 0; i < n; i++) {
    var h = s.charCodeAt(i).toString(16).toUpperCase();
    parts.push('0000'.substring(h.length) + h);
  }
  return 'n=' + s.length + ' [' + parts.join(' ') + ']' + (s.length > n ? '…' : '');
}

// Distinguish doc-prefix remnants (Odia char U+0992 / NUL bytes) and mangled
// garbage (user log: a Persian placeholder read back as "Ɛ" = U+0190) from
// real short plain-text values (Persian/Latin). Remnant => the param holds a
// (possibly corrupted) document -> use the synthesized-document fallback.
// v1.4 widened: C1 controls (0x80-0x9F), Latin-Ext-B (0x180-0x24F, covers
// "Ɛ"), Indic band (0x900-0xDFF, covers the doc prefix U+0992) and the
// private-use area are all remnant signals in <= 8-char values.
function s2g_looksLikeDocRemnant(s) {
  if (!s || s.length > 8) { return false; }
  var remnant = false;
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c <= 0x1F || c === 0x7F || (c >= 0x80 && c <= 0x9F) ||
        (c >= 0x180 && c <= 0x24F) || (c >= 0x900 && c <= 0xDFF) ||
        (c >= 0xE000 && c <= 0xF8FF)) { remnant = true; }
    if ((c >= 0x20 && c <= 0x7E) || (c >= 0x600 && c <= 0x6FF) ||
        c === 0x200C || c === 0x200D || c === 0x0A || c === 0x0D) { return false; }
  }
  return remnant;
}

// v1.5: when the host truncates the doc at the first NUL byte, the surviving
// remnant IS the document's first character (its UTF-8 bytes sit right before
// the NULs). Recover it and use it as the synth prefix magic instead of
// assuming the forum-dumped U+0992 — templates/hosts differ.
function s2g_magicFromRemnant(raw) {
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > 4) { return 0; }
  if (raw.indexOf('{') >= 0) { return 0; }
  var c = raw.charCodeAt(0);
  if (c >= 0x20 && c <= 0x7E) { return 0; }   // plain ASCII — not a magic
  if (c >= 0x600 && c <= 0x6FF) { return 0; } // real Persian text
  if (c === 0x200C || c === 0x200D) { return 0; }
  return c;
}

// Synthesized minimal Premiere text document — last resort when the current
// value is unreadable (getValue throws / host returns garbage). Shape copied
// from a real dump posted by Adobe staff on the forums.
// v1.5: magicChar = personalized prefix (0 = default U+0992); noPrefix drops
// the binary prefix entirely; the body is built via s2g_jsonEscape which is
// now PURE ASCII (Persian → \uXXXX escapes).
function s2g_synthPremDoc(text, magicChar, noPrefix) {
  var mc = (typeof magicChar === 'number' && magicChar > 0) ? magicChar : 0x0992;
  var prefix = noPrefix ? '' : (String.fromCharCode(mc) + String.fromCharCode(0, 0, 0));
  var inner = '{"mTextParam":{"mAlignment":0,"mDefaultRun":[],"mHeight":0,"mHindiDigits":true,' +
    '"mIndic":true,"mIsVerticalText":false,"mLeading":0,"mLigatures":true,"mRTL":false,' +
    '"mShadowAngle":135,"mShadowBlur":40,"mShadowColor":4144959,"mShadowOffset":7,' +
    '"mShadowOpacity":75,"mShadowSize":0,"mShadowVisible":false,"mStyleSheet":{' +
    '"mBaselineOption":{"mParamValues":[[0,0]]},"mBaselineShift":{"mParamValues":[[0,0]]},' +
    '"mCapsOption":{"mParamValues":[[0,0]]},"mFauxBold":{"mParamValues":[[0,false]]},' +
    '"mFauxItalic":{"mParamValues":[[0,false]]},"mFillColor":{"mParamValues":[[0,16777215]]},' +
    '"mFillOverStroke":{"mParamValues":[[0,true]]},"mFillVisible":{"mParamValues":[[0,true]]},' +
    '"mFontName":{"mParamValues":[[0,"Assistant-SemiBold"]]},"mFontSize":{"mParamValues":[[0,140]]},' +
    '"mKerning":{"mParamValues":[[0,0]]},"mStrokeColor":{"mParamValues":[[0,16777215]]},' +
    '"mStrokeVisible":{"mParamValues":[[0,false]]},"mStrokeWidth":{"mParamValues":[[0,1]]},' +
    '"mText":"' + s2g_jsonEscape(text) + '"' +
    ',"mTracking":{"mParamValues":[[0,0]]},"mTsumi":{"mParamValues":[[0,0]]}},' +
    '"mTabWidth":400,"mWidth":0},"mVersion":1}';
  return prefix + inner;
}

// Read the current value of a param as a usable UNICODE string (host quirks
// tolerated). v1.4: the raw bytes coming back from the MOGRT layer are decoded
// here — this is the single choke point for every string read.
function s2g_readParamString(prop) {
  try {
    var v = prop.getValue();
    if (typeof v === 'string') { return s2g_fromByteStr(v); }
    if (v && typeof v === 'object' && typeof v.join === 'function') { return s2g_fromByteStr(v.join('')); }
    return String(v);
  } catch (e0) { return null; }
}

// Classify a raw param value as a text document:
//   {kind:'prem'|'ae', prefix:String, obj:Object}  |  null (plain string)
function s2g_parseTextDoc(s) {
  if (!s || typeof s !== 'string') { return null; }
  var b = s.indexOf('{');
  if (b < 0) { return null; }
  if (!s2g_jsonOk()) { return null; }
  var obj = null;
  try { obj = JSON.parse(s.substring(b)); } catch (e1) { return null; }
  if (!obj || typeof obj !== 'object') { return null; }
  if (obj.mTextParam) { return { kind: 'prem', prefix: s.substring(0, b), obj: obj }; }
  if (typeof obj.textEditValue === 'string') { return { kind: 'ae', prefix: s.substring(0, b), obj: obj }; }
  return null;
}

function s2g_docGetText(doc) {
  try {
    if (doc.kind === 'prem') { return String(doc.obj.mTextParam.mStyleSheet.mText); }
    return String(doc.obj.textEditValue);
  } catch (e) { return null; }
}

// Mutate the doc so it renders `text`; true on success.
function s2g_docSetText(doc, text) {
  try {
    if (doc.kind === 'prem') {
      if (!doc.obj.mTextParam.mStyleSheet) { doc.obj.mTextParam.mStyleSheet = {}; }
      doc.obj.mTextParam.mStyleSheet.mText = text;
      return true;
    }
    doc.obj.textEditValue = text;
    // AE templates: run length MUST match the new text or it gets dropped
    doc.obj.fontTextRunLength = [text.length];
    return true;
  } catch (e) { return false; }
}

function s2g_trim(s) {
  return s.replace(/^\s+/, '').replace(/\s+$/, '');
}

function s2g_ok(fields) {
  return encodeURIComponent(fields.join('|'));
}

function s2g_err(code, detail) {
  var d = '';
  try { d = encodeURIComponent(String(detail || '')); } catch (e) { d = ''; }
  return encodeURIComponent('err=' + code + '|detail=' + d);
}

function s2g_buildComps(clip) {
  var comps = [];
  try {
    var m = clip.getMGTComponent();
    if (m) { comps.push(m); }
  } catch (e0) {}
  var cc = null;
  try { cc = clip.components; } catch (e1) { cc = null; }
  if (!cc) {
    try { cc = clip.getComponents(); } catch (e1b) { cc = null; }
  }
  if (cc) {
    var n = 0;
    try { n = Number(cc.numComponents); } catch (e2) {}
    if (!n || n <= 0) { try { n = Number(cc.numItems); } catch (e3) {} }
    if (!n || n <= 0) { try { n = Number(cc.length); } catch (e4) {} }
    if (n > 0) {
      for (var i = 0; i < n; i++) {
        try {
          var comp = cc[i];
          if (comp) { comps.push(comp); }
        } catch (e5) {}
      }
    }
  }
  // de-dupe (getMGTComponent is usually also inside clip.components)
  var seen = {};
  var uniq = [];
  for (var u = 0; u < comps.length; u++) {
    var key = 'x' + u;
    try { key = String(comps[u].matchName) + '\u0001' + String(comps[u].displayName); } catch (e6) {}
    if (seen[key]) { continue; }
    seen[key] = true;
    uniq.push(comps[u]);
  }
  return uniq;
}

// Resolve the parameter collection of a Component.
// The documented member is `params` (ComponentParamCollection: numItems + [i]);
// v1.1 read `properties`, which does NOT exist -> zero params found -> empty text.
// Defensive fallbacks keep this working even if a future host renames things.
function s2g_getParamCollection(comp) {
  var col = null;
  try { if (comp.params) { col = comp.params; } } catch (e0) {}
  if (!col) {
    try { if (comp.properties) { col = comp.properties; } } catch (e1) {}
  }
  if (!col) { return null; }
  var n = 0;
  try { n = Number(col.numItems); } catch (e2) {}
  if (!n || n <= 0) { try { n = Number(comp.numParams); } catch (e3) {} }
  if (!n || n <= 0) { try { n = Number(col.numComponents); } catch (e3b) {} }
  if (!n || n <= 0) { try { n = Number(col.length); } catch (e4) {} }
  if (!n || n <= 0) { return null; }
  return { col: col, n: n };
}

function s2g_propName(prop) {
  try { return prop.displayName || prop.name || ''; } catch (e) { return ''; }
}

// ---------------- parameter scanning ----------------

// Scan every parameter of every component; keep the live prop reference.
function s2g_scanParams(clip) {
  var found = [];
  var comps = s2g_buildComps(clip);
  for (var c = 0; c < comps.length; c++) {
    var pc = null;
    try { pc = s2g_getParamCollection(comps[c]); } catch (e0) { pc = null; }
    if (!pc || pc.n <= 0) { continue; }
    for (var p = 0; p < pc.n; p++) {
      var info = { c: c, p: p, n: '', v: undefined, raw: null, readable: false, isString: false, prop: null };
      var prop = null;
      try { prop = pc.col[p]; } catch (e3) { continue; }
      if (!prop) { continue; }
      info.prop = prop;
      info.n = s2g_propName(prop);
      try {
        info.v = prop.getValue();
        info.readable = true;
        info.isString = (typeof info.v === 'string');
        // v1.4: decode byte strings immediately, so discovery ranking, the
        // parameter report and every downstream check see real Unicode.
        if (info.isString) {
          info.raw = info.v; // v1.5: keep the pre-decode bytes for hex diagnostics
          info.v = s2g_fromByteStr(info.v);
        }
      } catch (e4) { info.v = undefined; info.readable = false; }
      found.push(info);
    }
  }
  return found;
}

// Try to write+read-back a probe value; returns true | 'loose' | false
// v1.3: probing now goes through the document-aware writer — v1.2 probed with
// a plain string, which CORRUPTED document-typed params (the very bug users saw).
function s2g_probeParam(prop, probeVal) {
  var r = s2g_setTextValue(prop, probeVal);
  if (!r.ok) { return false; }
  var raw = s2g_readParamString(prop);
  if (raw === null) { return 'loose'; } // write accepted, unreadable
  var doc = s2g_parseTextDoc(raw);
  var cur = doc ? s2g_docGetText(doc) : raw;
  if (cur === probeVal) { return true; }
  if (String(cur).replace(/\r\n/g, '\n') === String(probeVal).replace(/\r\n/g, '\n')) { return true; }
  return 'loose'; // write accepted but read-back differs (serialized text engines)
}

// Discover the text parameter of an inserted MOGRT clip (4-strategy engine).
// Sets st.textParam and returns {pick, how} or null.
function s2g_discoverTextParam(clip, st) {
  var params = s2g_scanParams(clip);
  var names = [];
  var cands = [];
  var blind = [];
  for (var i = 0; i < params.length; i++) {
    var q = params[i];
    var t = q.isString ? ('str:' + q.v.length) : (q.readable ? (typeof q.v) : 'unreadable');
    names.push('"' + q.n + '"[' + t + ']');
    if (S2G_STYLE_NAME_RE.test(q.n)) { continue; } // never a text param
    if (q.isString) { cands.push(q); }
    else if (!q.readable && S2G_TEXT_NAME_RE.test(q.n)) { blind.push(q); }
  }
  st.diagNames = names.join('  ');
  if (!cands.length && !blind.length) { return null; }

  var best = null;
  // rank 1 — text-ish parameter name
  for (var j = 0; j < cands.length; j++) {
    var c1 = cands[j];
    if (S2G_TEXT_NAME_RE.test(c1.n)) {
      if (!best || c1.v.length > best.v.length) { best = c1; }
    }
  }
  if (best) { st.textParam = { c: best.c, p: best.p, n: best.n }; return { pick: best, how: 'name' }; }

  // rank 2 — blind write on unreadable but text-named params (driver quirks).
  // v1.5: this now beats value/probe ranking — a param literally named
  // "Source Text"/"متن" that merely THROWS on getValue is a far better
  // target than a random numeric-as-string param like "Blend Mode: 4".
  for (var b = 0; b < blind.length; b++) {
    var bl = blind[b];
    var wrote = s2g_writeParam(bl.prop, ' ');
    if (wrote) {
      st.textParam = { c: bl.c, p: bl.p, n: bl.n };
      return { pick: bl, how: 'blind' };
    }
  }

  // rank 3 — probe round-trip (covers EMPTY template text — the classic "no text" bug)
  for (var m = 0; m < cands.length; m++) {
    var c3 = cands[m];
    var pr = s2g_probeParam(c3.prop, 'S2G-PROBE');
    if (pr === true || pr === 'loose') {
      st.textParam = { c: c3.c, p: c3.p, n: c3.n };
      return { pick: c3, how: (pr === true ? 'probe' : 'probe-loose') };
    }
  }

  // rank 4 — longest current string value (template placeholder text)
  best = null;
  for (var k = 0; k < cands.length; k++) {
    var c2 = cands[k];
    if (c2.v.length > 0 && (!best || c2.v.length > best.v.length)) { best = c2; }
  }
  if (best) { st.textParam = { c: best.c, p: best.p, n: best.n }; return { pick: best, how: 'value' }; }
  return null;
}

// Discover optional font / size params (best-effort overrides)
function s2g_discoverStyleParams(clip, st) {
  var params = s2g_scanParams(clip);
  for (var i = 0; i < params.length; i++) {
    var q = params[i];
    if (st.fontParam === null && q.readable && q.isString && q.v.length > 0 &&
        /font|فونت|fam/i.test(q.n) && !/size|اندازه/i.test(q.n)) {
      st.fontParam = { c: q.c, p: q.p, n: q.n };
    }
    if (st.sizeParam === null && q.readable && typeof q.v === 'number' &&
        /size|اندازه/i.test(q.n)) {
      st.sizeParam = { c: q.c, p: q.p, n: q.n };
    }
  }
}

function s2g_locateProp(clip, cache, wantType) {
  if (!cache) { return null; }
  var comps = s2g_buildComps(clip);
  if (cache.c >= comps.length) { return null; }
  var pc = null;
  try { pc = s2g_getParamCollection(comps[cache.c]); } catch (e1) { return null; }
  if (!pc || cache.p >= pc.n) { return null; }
  var prop = null;
  try { prop = pc.col[cache.p]; } catch (e2) { return null; }
  if (!prop || s2g_propName(prop) !== cache.n) { return null; }
  var v;
  try { v = prop.getValue(); if (typeof v === 'string') { v = s2g_fromByteStr(v); } } catch (e3) { return null; }
  if (typeof v !== wantType) { return null; }
  return prop;
}

// Locate by index+name only (getValue may throw on some hosts)
function s2g_locateByName(clip, cache) {
  if (!cache) { return null; }
  var comps = s2g_buildComps(clip);
  if (cache.c >= comps.length) { return null; }
  var pc = null;
  try { pc = s2g_getParamCollection(comps[cache.c]); } catch (e1) { return null; }
  if (!pc || cache.p >= pc.n) { return null; }
  var prop = null;
  try { prop = pc.col[cache.p]; } catch (e2) { return null; }
  if (!prop || s2g_propName(prop) !== cache.n) { return null; }
  return prop;
}

// THE write primitive — v1.5: the write encoding is selectable per call.
//   'uni'/'raw'/'noprefix' → raw Unicode (forum-proven; with the new
//                            ASCII-escaped doc bodies the content cannot be
//                            mangled by the marshalling)
//   'bytes'                → v1.4 behavior: unescape(encodeURIComponent(s))
//   anything else          → S2G.writeMode (panel setting; default 'uni')
// Tries the time-variant setValue(value, 1) first, then the plain form.
function s2g_writeParam(prop, s, wmode) {
  var m = (wmode === 'bytes' || wmode === 'uni' || wmode === 'raw' || wmode === 'noprefix')
    ? wmode : (S2G.writeMode || 'uni');
  var b = (m === 'bytes') ? s2g_toByteStr(s) : String(s);
  try { prop.setValue(b, 1); return true; } catch (e1) {}
  try { prop.setValue(b); return true; } catch (e2) {}
  return false;
}

// THE text writer — document round-trip with layered fallbacks (v1.3 engine,
// v1.5 write modes + ASCII-escaped doc bodies + personalized prefix magic).
// wmode: 'uni' (default) | 'bytes' (v1.4) | 'raw' | 'noprefix'; undefined = S2G.writeMode.
// Returns {ok, mode:'doc'|'regex'|'synth'|'plain'|'failed', doc:'prem'|'ae'|'',
//          phLen:Number, wmode:String, magic:Number}
//  phLen = length of the template's placeholder text — ONLY meaningful in
//  'doc' mode now (v1.4's synth wrongly reported its own text length, which
//  produced the bogus "39-char capacity" warning in the field).
function s2g_setTextValue(prop, text, wmode) {
  var m = (wmode === 'bytes' || wmode === 'uni' || wmode === 'raw' || wmode === 'noprefix')
    ? wmode : (S2G.writeMode || 'uni');
  var res = { ok: false, mode: 'failed', doc: '', phLen: -1, wmode: m, magic: 0 };

  var raw = s2g_readParamString(prop);
  var doc = (raw !== null) ? s2g_parseTextDoc(raw) : null;

  // 1) proper round-trip: parse, update text fields, write back the full JSON
  if (doc) {
    var oldText = s2g_docGetText(doc);
    if (typeof oldText === 'string') { res.phLen = oldText.length; }
    var out = null;
    if (s2g_docSetText(doc, text)) {
      try { out = JSON.stringify(doc.obj); } catch (eS) { out = null; }
      // v1.5: pure-ASCII body — Persian becomes \uXXXX escapes
      if (out && m !== 'raw' && m !== 'bytes') { out = s2g_asciiify(out); }
    }
    if (out) {
      var full = (m === 'noprefix') ? out : (doc.prefix + out);
      if (s2g_writeParam(prop, full, m)) { res.ok = true; res.mode = 'doc'; res.doc = doc.kind; return res; }
    }
  }

  // 2) no JSON engine (very old hosts): in-place surgery on the serialized doc
  //    (function replacers — cue text may contain '$' which a string
  //    replacement would otherwise interpret)
  if (raw !== null && raw.indexOf('{') >= 0 && !s2g_jsonOk()) {
    var esc = s2g_jsonEscape(text);
    var reM = /("mText"\s*:\s*")((?:[^"\\]|\\.)*)"/;
    var reA = /("textEditValue"\s*:\s*")((?:[^"\\]|\\.)*)"/;
    var patched = raw.replace(reM, function (mm, g1) { return g1 + esc + '"'; });
    if (patched === raw) {
      patched = raw.replace(reA, function (mm, g1) { return g1 + esc + '"'; });
    }
    if (patched !== raw) {
      if (m === 'noprefix') { patched = patched.substring(patched.indexOf('{')); }
      if (s2g_writeParam(prop, patched, m)) { res.ok = true; res.mode = 'regex'; res.doc = 'prem'; return res; }
    }
  }

  // 3) document-typed but unparsable (corrupted / NUL-truncated by the host):
  //    a synthesized VALID document keeps the text engine alive. The prefix
  //    magic is recovered from the read remnant when possible (v1.5), and the
  //    body is pure ASCII unless 'raw'/'bytes' explicitly opt out.
  if (raw === null || raw.indexOf('{') >= 0 || s2g_looksLikeDocRemnant(raw)) {
    // v1.5: personalize the prefix from the read remnant for every raw-Unicode
    // mode (uni/raw; noprefix drops it anyway). Only 'bytes' keeps the v1.4
    // behavior of encoding the default magic into UTF-8 bytes.
    var magic = (m !== 'bytes') ? s2g_magicFromRemnant(raw) : 0;
    res.magic = magic;
    var synth = s2g_synthPremDoc(text, magic, m === 'noprefix');
    if (s2g_writeParam(prop, synth, m)) { res.ok = true; res.mode = 'synth'; res.doc = 'prem'; return res; }
  }

  // 4) plain string parameter — legacy behavior, encoded per wmode
  if (s2g_writeParam(prop, text, m)) { res.ok = true; res.mode = 'plain'; return res; }
  return res;
}

// Resolve the text prop for this clip and write `text`; verifies read-back once.
function s2g_applyText(st, clip, text) {
  var prop = s2g_locateProp(clip, st.textParam, 'string');
  if (!prop) { prop = s2g_locateByName(clip, st.textParam); }
  if (!prop) {
    var dres = s2g_discoverTextParam(clip, st);
    if (dres) { prop = dres.pick.prop; }
  }
  if (!prop) { return false; }

  var r = s2g_setTextValue(prop, text);
  if (!r.ok) { return false; }

  if (r.doc && !st.docType) {
    st.docType = r.doc;
    if (r.phLen >= 0) { st.phLen = r.phLen; }
  }

  // best-effort read-back verification, document-aware (newlines normalized)
  var norm = function (s) { return String(s).replace(/\r\n/g, '\n'); };
  try {
    var raw = s2g_readParamString(prop);
    var cur = raw;
    if (raw !== null) {
      var doc2 = s2g_parseTextDoc(raw);
      if (doc2) { cur = s2g_docGetText(doc2); }
    }
    if (cur === null || norm(cur) !== norm(text)) {
      var r2 = s2g_setTextValue(prop, text);
      var cur2 = null;
      try {
        var raw2 = s2g_readParamString(prop);
        var doc3 = (raw2 !== null) ? s2g_parseTextDoc(raw2) : null;
        cur2 = doc3 ? s2g_docGetText(doc3) : raw2;
      } catch (eV2) { cur2 = null; }
      if (r2.ok && cur2 !== null && norm(cur2) === norm(text)) {
        // second write took — keep it
      } else if (r2.ok && cur2 === null) {
        st.verifyWarn = true; // accepted but unverifiable
      } else {
        st.verifyWarn = true;
      }
    }
  } catch (eV) { /* unreadable on this host — accept the write */ }
  return true;
}

// ---------------- timeline helpers ----------------

function s2g_setTicks(clip, which, ticks) {
  try { clip[which].ticks = String(ticks); return true; } catch (e1) {}
  try { clip[which].seconds = Number(ticks) / 254016000000; return true; } catch (e2) {}
  return false;
}

function s2g_trackFree(track, sTicks, eTicks) {
  var clips;
  try { clips = track.clips; } catch (e0) { return true; }
  var n = 0;
  try { n = clips.numItems; } catch (e1) { return true; }
  for (var i = 0; i < n; i++) {
    var c = clips[i];
    var cs = 0, ce = 0;
    try { cs = Number(c.start.ticks); ce = Number(c.end.ticks); } catch (e2) { continue; }
    if (cs < eTicks && ce > sTicks) { return false; }
  }
  return true;
}

// Is this clip a graphics (MOGRT) clip? Source media (video, SRT, audio-linked)
// has no MGT component — used to protect user media from the clear pass.
function s2g_isMgtClip(c) {
  try {
    if (typeof c.getMGTComponent === 'function' && c.getMGTComponent()) { return true; }
  } catch (e0) {}
  return false;
}

// True when EVERY clip on the track is a MOGRT clip fully inside [s, e] —
// i.e. the previous output of this panel. Video/SRT source tracks never qualify.
function s2g_isPreviousOutput(track, sTicks, eTicks) {
  var clips;
  try { clips = track.clips; } catch (e0) { return false; }
  var cnt = 0;
  try { cnt = clips.numItems; } catch (e1) { return false; }
  if (cnt <= 0) { return false; }
  for (var k = 0; k < cnt; k++) {
    var c = clips[k];
    var cs = 0, ce = 0;
    try { cs = Number(c.start.ticks); ce = Number(c.end.ticks); } catch (e2) { return false; }
    if (cs < sTicks || ce > eTicks) { return false; }
    if (!s2g_isMgtClip(c)) { return false; }
  }
  return true;
}

// Remove clips fully inside [sTicks, eTicks] on this track (for safe re-runs)
function s2g_clearRange(seq, trackIdx, sTicks, eTicks) {
  var removed = 0;
  try {
    var track = seq.videoTracks[trackIdx];
    var clips = track.clips;
    for (var i = clips.numItems - 1; i >= 0; i--) {
      var c = clips[i];
      var cs = 0, ce = 0;
      try { cs = Number(c.start.ticks); ce = Number(c.end.ticks); } catch (e1) { continue; }
      if (cs >= sTicks && ce <= eTicks) {
        try { c.remove(true); removed++; } catch (e2) { try { c.remove(); removed++; } catch (e3) {} }
      }
    }
  } catch (e4) {}
  return removed;
}

function s2g_findTargetTrack(seq, avoidIdx, sTicks, eTicks, doClear) {
  var n = 0;
  try { n = seq.videoTracks.numTracks; } catch (e0) { return -1; }
  var from = (avoidIdx >= 0) ? avoidIdx + 1 : n - 1;
  var step = (avoidIdx >= 0) ? 1 : -1;

  function scan(fn) {
    for (var i = from; i >= 0 && i < n; i += step) {
      if (i === avoidIdx) { continue; }
      if (fn(i)) { return i; }
    }
    return -1;
  }

  // 1) replace mode: the track this panel filled before (all-MOGRT, inside range).
  //    "پاک‌سازی ترک مقصد" means REPLACE, so prefer it over a virgin empty track;
  //    the all-MOGRT condition guarantees user media is never touched.
  if (doClear) {
    var prev = scan(function (i) { return s2g_isPreviousOutput(seq.videoTracks[i], sTicks, eTicks); });
    if (prev >= 0) { return prev; }
  }
  // 2) first empty track below (or above, in browse mode)
  var empty = scan(function (i) { return s2g_trackFree(seq.videoTracks[i], sTicks, eTicks); });
  if (empty >= 0) { return empty; }
  // 3) try to add a new video track via QE (undocumented, best effort).
  //    v1.5: the track count does not refresh immediately after addVideoTrack —
  //    poll it ($.sleep) instead of reading it once. Earlier every click added
  //    ANOTHER invisible track (E_NOTRACK, E_NOTRACK, then success on the
  //    3rd click — leaving stray empty tracks behind).
  try {
    var qeSeq = qe.project.getActiveSequence();
    if (qeSeq && typeof qeSeq.addVideoTrack === 'function') {
      qeSeq.addVideoTrack();
      for (var w = 0; w < 10; w++) {
        try { $.sleep(120); } catch (eS1) {}
        var n2 = 0;
        try { n2 = Number(seq.videoTracks.numTracks); } catch (eS2) { n2 = 0; }
        if (n2 > n) {
          var ni = n2 - 1;
          if (s2g_trackFree(seq.videoTracks[ni], sTicks, eTicks)) { return ni; }
          break;
        }
      }
    }
  } catch (e4) {}
  return -1;
}

// ---------------- public API ----------------

// v2.1: cooperative yield — pause the ExtendScript thread for ms. Used between
// the test-button imports. NEVER used inside the conversion loop: the panel
// spaces those calls out with real setTimeout gaps so Premiere's main thread
// stays fully free between layers (a $.sleep here would block the main thread
// and make Premiere show "Not Responding" instead of healing it).
function s2g_yield(ms) {
  try { if (typeof $ !== 'undefined' && $.sleep) { $.sleep(ms); } } catch (eY) {}
}

// v2.2 — park Premiere's auto-save during the batch (auto-save firing in the
// middle of heavy importMGT churn is a classic crash trigger) and restore it
// after. All guarded: some hosts lack these undocumented methods.
function s2g_autoSaveOff(st) {
  try {
    if (typeof app === 'undefined' || !app || !app.setEnableAutoSave) { return false; }
    var prev = true;
    try { if (app.getEnableAutoSave) { prev = !!app.getEnableAutoSave(); } } catch (eR) { prev = true; }
    try { app.setEnableAutoSave(false); } catch (eS) { return false; }
    st.asPrev = prev;
    st.asParked = true;
    return true;
  } catch (eO) { return false; }
}

function s2g_autoSaveRestore(st) {
  if (!st || !st.asParked) { return false; }
  st.asParked = false;
  try { app.setEnableAutoSave(!!st.asPrev); return true; } catch (eS) { return false; }
}

// v2.2 — one protective save before the batch. NEVER on an untitled project:
// save() would pop a modal dialog and block the bridge.
function s2g_saveProjectGuarded() {
  try {
    var ppath = '';
    try { ppath = String(app.project.path || ''); } catch (eP) { ppath = ''; }
    if (!ppath) { return false; }
    app.project.save();
    return true;
  } catch (eS) { return false; }
}

// v2.2 — find the clip on a track that starts exactly at sTicks (the one
// overwriteClip just placed there).
function s2g_clipAt(track, sTicks) {
  try {
    var cl = track.clips;
    var n = 0;
    try { n = Number(cl.numItems); } catch (eN) { n = 0; }
    for (var i = 0; i < n; i++) {
      var c = null;
      try { c = cl[i]; } catch (eI) { c = null; }
      if (!c) { continue; }
      var stk = '';
      try { stk = String(c.start.ticks); } catch (eT) { stk = ''; }
      if (stk === String(sTicks)) { return c; }
    }
  } catch (eO) {}
  return null;
}

function s2g_ping() {
  try {
    var appVer = '';
    try { appVer = String(app.version); } catch (e0) {}
    var asCap = '0';
    try { if (app && app.setEnableAutoSave) { asCap = '1'; } } catch (eAs) { asCap = '0'; }
    return s2g_ok(['ok=1', 'ver=2.4.0', 'appv=' + encodeURIComponent(appVer), 'as=' + asCap]);
  } catch (e) {
    return s2g_err('E_PING', e);
  }
}

// v2.0 — import ONE baked mogrt (text already inside the file) at an exact
// tick position. Used by «تست قالب» to place the 5th (بیکری) test clip.
// enc = encodeURIComponent(path) + '|' + startTicks + '|' + durTicks
function s2g_importBakedAt(enc) {
  try {
    var raw = decodeURIComponent(enc || '');
    var parts = raw.split('|');
    if (parts.length < 3) { return s2g_err('E_PAYLOAD', 'path|ticks|dur'); }
    var p = '';
    try { p = decodeURIComponent(parts[0]); } catch (e0) { p = parts[0]; }
    var t0 = Number(parts[1]), dur = Number(parts[2]);
    if (!p || isNaN(t0) || isNaN(dur) || dur <= 0) { return s2g_err('E_PAYLOAD', 'bad fields'); }
    var f = new File(p);
    if (!f.exists) { return s2g_err('E_NOMOGRT', 'baked file missing'); }
    var seq = app.project.activeSequence;
    if (!seq) { return s2g_err('E_NOSEQ', ''); }
    var target = s2g_findTargetTrack(seq, -1, t0, t0 + dur, false);
    if (target < 0) { return s2g_err('E_NOTRACK', ''); }
    var clip = null;
    try { clip = seq.importMGT(p, String(t0), target, -1); } catch (e1) { clip = null; }
    if (!clip) { return s2g_err('E_IMPORT', 'baked'); }
    s2g_setTicks(clip, 'end', t0 + dur);
    try { if (Number(clip.start.ticks) !== t0) { s2g_setTicks(clip, 'start', t0); } } catch (e2) {}
    return s2g_ok(['ok=1', 'track=' + String(target), 'ticks=' + String(t0), 'dur=' + String(dur)]);
  } catch (e) {
    return s2g_err('E_JSX', e);
  }
}

function s2g_getSelectedSrt() {
  try {
    var seq = app.project.activeSequence;
    if (!seq) { return s2g_err('E_NOSEQ', ''); }
    var sel = null;
    try { sel = seq.getSelection(); } catch (e0) {}
    if (!sel || !sel.length) { return s2g_err('E_NOSEL', ''); }
    for (var i = 0; i < sel.length; i++) {
      var ti = sel[i];
      var pi = null;
      try { pi = ti.projectItem; } catch (e1) { pi = null; }
      if (!pi) { continue; }
      var mp = '';
      try { mp = pi.getMediaPath(); } catch (e2) { mp = ''; }
      if (!mp || !/\.srt$/i.test(mp)) { continue; }
      var startTicks = 0, inTicks = 0, trackIdx = -1;
      try { startTicks = Number(ti.start.ticks); } catch (e3) {}
      try { inTicks = Number(ti.inPoint.ticks); } catch (e4) {}
      try { trackIdx = Number(ti.parentTrackIndex); } catch (e5) {}
      var anchor = startTicks - inTicks;
      if (anchor < 0) { anchor = startTicks; }
      var name = mp.replace(/\\/g, '/').split('/').pop();
      return s2g_ok(['ok=1',
        'path=' + encodeURIComponent(mp),
        'name=' + encodeURIComponent(name),
        'anchorTicks=' + String(anchor),
        'track=' + String(trackIdx)]);
    }
    return s2g_err('E_NOTSRT', '');
  } catch (e) {
    return s2g_err('E_JSX', e);
  }
}

function s2g_pickFile(isSrt) {
  var isWin = ($.os.indexOf('Windows') >= 0);
  var f = null;
  if (isSrt) {
    var fltSrt = isWin ? 'SRT subtitle:*.srt' : function (fi) { return /\.srt$/i.test(fi.name); };
    f = File.openDialog('Select SRT file', fltSrt, false);
  } else {
    var fltMg = isWin ? 'Motion Graphics Template:*.mogrt' : function (fi) { return /\.mogrt$/i.test(fi.name); };
    f = File.openDialog('Select MOGRT template', fltMg, false);
  }
  if (!f) { return s2g_err('E_CANCEL', ''); }
  return s2g_ok(['ok=1', 'path=' + encodeURIComponent(f.fsName)]);
}

function s2g_browseSrt() {
  try { return s2g_pickFile(true); } catch (e) { return s2g_err('E_JSX', e); }
}

function s2g_browseMogrt() {
  try { return s2g_pickFile(false); } catch (e) { return s2g_err('E_JSX', e); }
}

function s2g_readFile(encPath) {
  try {
    var path = decodeURIComponent(encPath);
    var f = new File(path);
    f.encoding = 'UTF8';
    if (!f.open('r')) { return s2g_err('E_NOFILE', 'cannot open'); }
    var content = f.read();
    f.close();
    if (content.length > 1200000) { return s2g_err('E_BIG', content.length); }
    return s2g_ok(['ok=1', 'data=' + encodeURIComponent(content)]);
  } catch (e) {
    return s2g_err('E_JSX', e);
  }
}

function s2g_getPlayheadTicks() {
  try {
    var seq = app.project.activeSequence;
    if (!seq) { return s2g_err('E_NOSEQ', ''); }
    var ticks = 0;
    try { ticks = Number(seq.player.getCurrentTime().ticks); } catch (e0) { ticks = 0; }
    return s2g_ok(['ok=1', 'ticks=' + String(ticks)]);
  } catch (e) {
    return s2g_err('E_JSX', e);
  }
}

function s2g_convertStart(enc) {
  try {
    var raw = decodeURIComponent(enc);
    var nl = raw.indexOf('\n');
    if (nl < 0) { return s2g_err('E_PAYLOAD', 'no body'); }
    var metaRaw = raw.substring(0, nl);
    var bodyRaw = raw.substring(nl + 1);

    var m = {};
    var metaParts = metaRaw.split('|');
    for (var i = 0; i < metaParts.length; i++) {
      var eq = metaParts[i].indexOf('=');
      if (eq < 0) { continue; }
      m[metaParts[i].substring(0, eq)] = metaParts[i].substring(eq + 1);
    }

    var mogrt = decodeURIComponent(m.mogrt || '');
    var doClear = (m.clear === '1');
    var font = '';
    try { font = decodeURIComponent(m.font || ''); } catch (e0) { font = ''; }
    var size = -1;
    try { size = parseFloat(m.size); } catch (e1) { size = -1; }
    var anchor = 0;
    try { anchor = Number(m.anchor || '0'); } catch (e2) { anchor = 0; }
    var avoid = -1;
    try { avoid = parseInt(m.avoidTrack, 10); } catch (e3) { avoid = -1; }
    if (isNaN(avoid)) { avoid = -1; }

    // v1.5: write strategy from the panel («حالت نوشتن متن» selector)
    var wmode = String(m.wmode || 'uni');
    if (wmode !== 'bytes' && wmode !== 'raw' && wmode !== 'noprefix') { wmode = 'uni'; }
    S2G.writeMode = wmode;

    // v2.3: mid-run protective save interval (layers); 0 disables. The panel
    // may send saveEvery; default is 10 per the user's choice.
    var saveEvery = parseInt(m.saveEvery, 10);
    if (isNaN(saveEvery) || saveEvery < 0) { saveEvery = 10; }

    // v2.4: resume support — skip the first N cues (0-based). A run aborted
    // by a host crash continues from where the log says it stopped instead of
    // rebuilding (and re-crashing over) the layers that already exist.
    var startIdx = parseInt(m.startIdx, 10);
    if (isNaN(startIdx) || startIdx < 0) { startIdx = 0; }

    // v2.0: baked-mogrt engine — cue "text" field is actually the ASCII
    // file path of a per-cue .mogrt with the Persian text already inside;
    // NO setValue text writes happen at all in this mode.
    var baked = (m.baked === '1');

    if (!mogrt) { return s2g_err('E_NOMOGRT', ''); }
    var mgFile = new File(mogrt);
    if (!mgFile.exists) { return s2g_err('E_NOMOGRT', 'file missing'); }

    var seq = app.project.activeSequence;
    if (!seq) { return s2g_err('E_NOSEQ', ''); }

    // parse cues
    var cueLines = bodyRaw.split('\n');
    var cues = [];
    var minS = 0, maxE = 0, frameTicks = 254016000000 / 25;
    try { frameTicks = Number(seq.timebase); } catch (e4) {}
    if (!frameTicks || frameTicks <= 0) { frameTicks = 254016000000 / 25; }
    for (var c = 0; c < cueLines.length; c++) {
      var line = cueLines[c];
      if (!line) { continue; }
      var parts = line.split('\t');
      if (parts.length < 3) { continue; }
      var s = Number(parts[0]), eT = Number(parts[1]);
      var text = '';
      try { text = decodeURIComponent(parts[2]); } catch (e5) { text = parts[2]; }
      // v2.3: optional 4th field — ASCII dedupe hash of the cue text (baked
      // engine). '' = no dedupe (older panel payloads keep working unchanged).
      var h = (parts.length >= 4) ? String(parts[3]) : '';
      if (isNaN(s) || isNaN(eT) || eT <= s) { continue; }
      if (eT < s + frameTicks) { eT = s + frameTicks; }
      cues.push({ s: s, e: eT, text: text, h: h });
      if (cues.length === 1 || s < minS) { minS = s; }
      if (eT > maxE) { maxE = eT; }
    }
    if (!cues.length) { return s2g_err('E_NOCUES', ''); }

    // sort + pre-clamp overlaps so the previous clip's end is NEVER changed
    // after its text has been written (v1.0 wrote text first, then trimmed —
    // that could wipe text on some hosts).
    cues.sort(function (a, b) { return a.s - b.s; });
    for (var oc = 0; oc < cues.length - 1; oc++) {
      if (cues[oc].e > cues[oc + 1].s) { cues[oc].e = cues[oc + 1].s; }
      if (cues[oc].e <= cues[oc].s) { cues[oc].e = cues[oc].s + frameTicks; }
    }

    // find destination track
    var target = s2g_findTargetTrack(seq, avoid, minS, maxE, doClear);
    if (target < 0) { return s2g_err('E_NOTRACK', ''); }

    var cleared = 0;
    if (doClear) { cleared = s2g_clearRange(seq, target, minS, maxE); }

    // v2.2 stability: one protective project save + park auto-save before the
    // batch. Auto-save firing mid-import-churn is a classic crash trigger.
    var savedFirst = s2g_saveProjectGuarded();

    S2G.state = {
      seq: seq,
      seqName: String(seq.name),
      mogrt: mogrt,
      baked: baked,
      bakeTold: false,
      cues: cues,
      idx: 0,
      okN: 0,
      failN: 0,
      target: target,
      frameTicks: frameTicks,
      font: font,
      size: (size > 0 ? size : -1),
      textParam: null,
      textHow: '',
      diagNames: '',
      verifyWarn: false,
      docType: '',
      phLen: 0,
      lenWarned: false,
      fontParam: null,
      fontFound: false,
      sizeParam: null,
      fontTried: false,
      fontApplied: false,
      lastClip: null,
      lastEnd: 0,
      reused: 0,
      mgtItem: null,
      vTrack: null,
      asParked: false,
      asPrev: true,
      aborted: false,
      msgs: [],
      // v2.3 RAM hardening
      bakeMap: {},
      dupN: 0,
      savedN: 0,
      saveEvery: saveEvery,
      startIdx: startIdx
    };

    // v2.4: honor the resume point — dedupe/bakeMap start empty on purpose,
    // so the first resumed cue does a fresh (correct) import.
    if (startIdx > 0 && startIdx < cues.length) { S2G.state.idx = startIdx; }
    else if (startIdx >= cues.length) { S2G.state.idx = cues.length; }

    try { S2G.state.vTrack = seq.videoTracks[target]; } catch (eVt) { S2G.state.vTrack = null; }
    var asOff = s2g_autoSaveOff(S2G.state);

    return s2g_ok(['ok=1', 'total=' + String(cues.length),
      'track=' + String(target), 'cleared=' + String(cleared),
      'saved=' + (savedFirst ? '1' : '0'), 'asoff=' + (asOff ? '1' : '0'),
      'startIdx=' + String(S2G.state.idx)]);
  } catch (e) {
    return s2g_err('E_JSX', e);
  }
}

function s2g_convertStep() {
  try {
    var st = S2G.state;
    if (!st) { return s2g_err('E_NOSTATE', ''); }
    // v2.1 CRASH FIX: importMGT is one of Premiere's heaviest scripting calls
    // (unzip mogrt → new project item → graphics render → timeline edit).
    // v2.0 ran up to 30 of them back-to-back inside one evalScript and the
    // panel fired the next batch immediately — Premiere never got idle main-
    // thread time and crashed after a few layers. The engine now inserts
    // EXACTLY ONE layer per call; the panel waits (default 3s, configurable)
    // between calls, so Premiere can breathe between layers.
    var CHUNK = 1;
    var processed = 0;
    var infoMsgs = [];
    var warnMsgs = [];
    // v2.4: NO $.gc() here anymore. v2.1/v2.2 gc'd once between layers (crash
    // "after a few layers"); v2.3 gc'd twice (crash moved EARLIER — layer 2).
    // $.gc() in this host runs while the graphics engine still holds live
    // wrapper references, so the safest amount of GC between layers is NONE.
    // The single guarded gc now lives at finish, after S2G.state is dropped.
    // v2.4 FRESH OBJECT RESOLUTION — never reuse Sequence/Track wrappers
    // across evalScript calls: re-resolve from the live project each step and
    // verify it is still the same sequence. A stale wrapper (sequence closed,
    // project switched, model re-seated after a save) now fails gracefully
    // with E_NOSEQ instead of touching a dead object model.
    var seq = null;
    try { seq = app.project.activeSequence; } catch (eSq) { seq = null; }
    if (!seq) { return s2g_err('E_NOSEQ', ''); }
    var seqNm = '';
    try { seqNm = String(seq.name); } catch (eNm) { seqNm = ''; }
    if (st.seqName && seqNm !== st.seqName) {
      st.aborted = true;
      // graceful stop must not leave Premiere's auto-save parked off
      s2g_autoSaveRestore(st);
      return s2g_err('E_NOSEQ', 'active sequence changed mid-run');
    }
    st.seq = seq;
    try { st.vTrack = seq.videoTracks[st.target]; } catch (eVt2) { st.vTrack = null; }

    while (st.idx < st.cues.length) {
      if (st.aborted) { break; }
      if (processed >= CHUNK) { break; }
      if (infoMsgs.length + warnMsgs.length >= 4) { break; }
      var cue = st.cues[st.idx];
      var sTicks = cue.s, eTicks = cue.e;

      // rare pathological overlap guard (dense cues < 1 frame apart)
      if (st.lastClip && st.lastEnd > sTicks) {
        try { st.lastClip.end.ticks = String(sTicks); } catch (e0) {}
        st.lastEnd = sTicks;
      }

      // v2.0 BAKED ENGINE: the mogrt file for THIS cue already contains the
      // Persian text — just import it and trim. No setValue on any param.
      if (st.baked) {
        if (!st.bakeTold) {
          st.bakeTold = true;
          infoMsgs.push('موتور بیکری — متن هر لایه از پیش داخل قالب اختصاصی‌اش کاشته شده؛ بدون setValue');
        }
        var bclip = null;
        // v2.3 RAM DEDUPE: identical texts (same ASCII hash) reuse the FIRST
        // imported projectItem via overwriteClip — a heavy importMGT (unzip →
        // new project item → graphics parse → render) is skipped entirely for
        // every repeated line of dialogue, which is exactly what fills RAM on
        // long SRT files. Falls back to importMGT when reuse fails.
        var bkey = cue.h || '';
        if (bkey && st.bakeMap[bkey] && st.vTrack) {
          try { st.vTrack.overwriteClip(st.bakeMap[bkey], String(sTicks)); } catch (eRv) { }
          try { bclip = s2g_clipAt(st.vTrack, sTicks); } catch (eRc) { bclip = null; }
          if (bclip) { st.dupN++; st.reused++; }
        }
        if (!bclip) {
          try { bclip = seq.importMGT(cue.text, String(sTicks), st.target, -1); } catch (eB1) { bclip = null; }
          if (!bclip) {
            // v2.2: one guarded retry — a failed import is often the async
            // pipeline still chewing on the previous layer.
            s2g_yield(1500);
            try { bclip = seq.importMGT(cue.text, String(sTicks), st.target, -1); } catch (eB3) { bclip = null; }
          }
          if (bclip && bkey && !st.bakeMap[bkey]) {
            try { st.bakeMap[bkey] = bclip.projectItem; } catch (eBm) { }
          }
        }
        if (!bclip) {
          st.failN++;
          st.idx++;
          if (warnMsgs.length < 3) { warnMsgs.push('درج کلیپ بیکری ناموفق @' + String(st.idx)); }
          continue;
        }
        s2g_setTicks(bclip, 'end', eTicks);
        try { if (Number(bclip.start.ticks) !== sTicks) { s2g_setTicks(bclip, 'start', sTicks); } } catch (eB2) {}
        st.okN++;
        st.lastClip = bclip;
        st.lastEnd = eTicks;
        st.idx++;
        processed++;
        // v2.3 MID-RUN PROTECTIVE SAVE — a crash mid-batch no longer loses
        // the layers already built (skipped on the very last layer; the
        // start-of-run save + auto-save resume cover the tail).
        if (st.saveEvery > 0 && st.idx < st.cues.length && (st.idx % st.saveEvery) === 0) {
          if (s2g_saveProjectGuarded()) { st.savedN++; }
        }
        continue;
      }

      // v2.2 VALUE-ENGINE OPTIMIZATION: reuse the project item imported ONCE —
      // overwriteClip places a new instance of the same MGT media (each
      // instance gets its own text params) without re-importing/parsing the
      // file again. Dramatically lighter for long SRT files.
      var clip = null;
      if (st.mgtItem && st.vTrack) {
        try { st.vTrack.overwriteClip(st.mgtItem, String(sTicks)); } catch (eOv) { }
        try { clip = s2g_clipAt(st.vTrack, sTicks); } catch (eFc) { clip = null; }
        if (clip) { st.reused++; }
      }
      if (!clip) {
        try { clip = seq.importMGT(st.mogrt, String(sTicks), st.target, -1); } catch (e1) { clip = null; }
        // v2.2: one guarded retry on transient import failure
        if (!clip) {
          s2g_yield(1500);
          try { clip = seq.importMGT(st.mogrt, String(sTicks), st.target, -1); } catch (e1b) { clip = null; }
        }
        if (clip && !st.mgtItem) {
          try { st.mgtItem = clip.projectItem; } catch (ePi) { st.mgtItem = null; }
        }
      }

      if (!clip) {
        st.failN++;
        st.idx++;
        if (warnMsgs.length < 3) { warnMsgs.push('درج کلیپ ناموفق @' + String(st.idx)); }
        continue;
      }

      // discover the text param once, on the first successfully inserted clip
      if (!st.textParam) {
        var dres = s2g_discoverTextParam(clip, st);
        if (dres) {
          st.textHow = dres.how;
          infoMsgs.push('پارامتر متن پیدا شد: «' + dres.pick.n + '» (' + dres.how + ')');
          s2g_discoverStyleParams(clip, st);
        } else {
          if (warnMsgs.length < 3) {
            warnMsgs.push('پارامتر متن در قالب پیدا نشد! پارامترها: ' + st.diagNames);
          }
        }
      }

      // 1) timing FIRST …
      s2g_setTicks(clip, 'end', eTicks);
      try { if (Number(clip.start.ticks) !== sTicks) { s2g_setTicks(clip, 'start', sTicks); } } catch (e5) {}

      // 2) … text LAST (so timing edits can never wipe it)
      if (st.textParam) {
        var applied = false;
        try { applied = s2g_applyText(st, clip, cue.text); } catch (e6) { applied = false; }
        if (applied) {
          st.okN++;
          // Premiere-authored docs cap text at the template's placeholder length —
          // longer texts are silently discarded by Premiere (DVAPR-4212165).
          if (!st.lenWarned && st.docType === 'prem' && st.phLen > 0 && cue.text.length > st.phLen) {
            st.lenWarned = true;
            if (warnMsgs.length < 3) {
              warnMsgs.push('ظرفیت متن این قالب ' + st.phLen + ' کاراکتر است و متن‌های بلندتر پاک می‌شوند (محدودیت پریمیر). داخل قالب یک متن نمونه‌ی بلند (مثلاً یک خط ۲۵۵ کاراکتری) ذخیره کنید.');
            }
          }
        }
        else {
          st.failN++;
          if (warnMsgs.length < 3) { warnMsgs.push('نوشتن متن ناموفق @' + String(st.idx)); }
        }
      } else {
        st.failN++;
      }

      // optional font override (best effort, after text)
      if (st.font !== '') {
        if (st.fontParam) {
          var fp = s2g_locateProp(clip, st.fontParam, 'string');
          if (fp) {
            if (s2g_writeParam(fp, st.font)) { st.fontApplied = true; }
            else if (!st.fontTried && warnMsgs.length < 3) { warnMsgs.push('اعمال فونت ناموفق'); }
          } else if (!st.fontTried && infoMsgs.length + warnMsgs.length < 3) {
            infoMsgs.push('پارامتر فونت در قالب پیدا نشد (فونت قالب استفاده می‌شود)');
          }
        } else if (!st.fontTried && infoMsgs.length + warnMsgs.length < 3) {
          infoMsgs.push('این قالب کنترل فونت را فعال نکرده است (فونت قالب استفاده می‌شود)');
        }
      }
      st.fontTried = true;

      // optional size override (best effort, after text)
      if (st.size > 0 && st.sizeParam) {
        var sp = s2g_locateProp(clip, st.sizeParam, 'number');
        if (sp) { try { sp.setValue(st.size, 1); } catch (e4) {} }
      }

      st.lastClip = clip;
      st.lastEnd = eTicks;
      st.idx++;
      processed++;
      // v2.3 mid-run protective save (value engine shares the policy)
      if (st.saveEvery > 0 && st.idx < st.cues.length && (st.idx % st.saveEvery) === 0) {
        if (s2g_saveProjectGuarded()) { st.savedN++; }
      }
    }

    var finish = (st.idx >= st.cues.length || st.aborted) ? '1' : '0';
    var out = ['ok=1',
      'done=' + String(st.idx),
      'total=' + String(st.cues.length),
      'okN=' + String(st.okN),
      'failN=' + String(st.failN),
      'finish=' + finish];
    if (st.aborted) { out.push('aborted=1'); }
    if (st.verifyWarn) { out.push('verifyWarn=1'); }
    var allMsgs = infoMsgs.concat(warnMsgs);
    if (allMsgs.length) {
      out.push('msg=' + encodeURIComponent(allMsgs.join('  •  ')));
      out.push('msgClass=' + (warnMsgs.length ? 'warn' : 'info'));
    }
    if (finish === '1') {
      // v2.2: restore auto-save, drop heavy references, final gc
      if (s2g_autoSaveRestore(st)) { out.push('asrest=1'); }
      if (st.reused > 0) { out.push('reused=' + String(st.reused)); }
      // v2.3: dedupe + mid-run save summaries
      if (st.dupN > 0) { out.push('dupN=' + String(st.dupN)); }
      if (st.savedN > 0) { out.push('savedN=' + String(st.savedN)); }
      st.lastClip = null;
      st.mgtItem = null;
      st.vTrack = null;
      st.bakeMap = null;
      S2G.state = null;
      try { if (typeof $ !== 'undefined' && $.gc) { $.gc(); } } catch (eGf) { }
    }
    return encodeURIComponent(out.join('|'));
  } catch (e) {
    return s2g_err('E_JSX', e);
  }
}

function s2g_convertAbort() {
  try {
    if (S2G.state) {
      S2G.state.aborted = true;
      // v2.2: parked auto-save must be restored even on abort
      var asRest = s2g_autoSaveRestore(S2G.state);
      return s2g_ok(asRest ? ['ok=1', 'asrest=1'] : ['ok=1']);
    }
    return s2g_ok(['ok=1']);
  } catch (e) {
    return s2g_err('E_JSX', e);
  }
}

// ---------------- template diagnostics ----------------

// v1.5 template diagnostics — the decisive one-click experiment:
//  1. ONE diagnostic clip at the playhead: full parameter report + RAW hex
//     dump of what getValue actually returns (no text write on it).
//  2. A 4-clip SHOOTOUT right after: each clip gets a short distinct Persian
//     marker written with a DIFFERENT strategy (uni / bytes / raw / noprefix).
//     Whichever clip shows correct Persian on the timeline is the write mode
//     the user picks in «حالت نوشتن متن» — it then drives the conversion.
function s2g_testMogrt(enc) {
  try {
    var path = '';
    try { path = decodeURIComponent(enc || ''); } catch (e0) { path = ''; }
    if (!path) { return s2g_err('E_NOMOGRT', 'no path'); }
    var f = new File(path);
    if (!f.exists) { return s2g_err('E_NOMOGRT', 'file missing'); }

    var seq = app.project.activeSequence;
    if (!seq) { return s2g_err('E_NOSEQ', ''); }

    var ticks = 0;
    try { ticks = Number(seq.player.getCurrentTime().ticks); } catch (e1) { ticks = 0; }
    // v1.5: the shootout needs room for 5 short clips (diagnostic + 4 shots)
    var TPS = 254016000000; // ticks per second
    var step = Math.floor(1.5 * TPS);
    var span = 5 * step + TPS;
    var target = s2g_findTargetTrack(seq, -1, ticks, ticks + span, false);
    if (target < 0) { return s2g_err('E_NOTRACK', ''); }

    s2g_yield(500); // v2.1: let Premiere settle before the first import
    var clip = null;
    try { clip = seq.importMGT(path, String(ticks), target, -1); } catch (e2) { clip = null; }
    if (!clip) { return s2g_err('E_IMPORT', ''); }
    // clip A is diagnostics-only now — keep it short so the shots don't overlap
    s2g_setTicks(clip, 'end', ticks + step);

    var st = { cues: null, textParam: null, diagNames: '', fontParam: null, sizeParam: null };
    var dres = null;
    try { dres = s2g_discoverTextParam(clip, st); } catch (e3) { dres = null; }

    var fields = ['ok=1', 'track=' + String(target), 'ticks=' + String(ticks)];

    // full parameter report
    var scan = [];
    try { scan = s2g_scanParams(clip); } catch (e4) { scan = []; }
    var report = [];
    for (var i = 0; i < scan.length; i++) {
      var q = scan[i];
      var prev = q.readable ? String(q.v) : '—';
      var tag = q.isString ? 'TEXT' : (q.readable ? (typeof q.v) : 'unreadable');
      // v1.4: for document-typed values show the DECODED inner text (the real
      // Persian placeholder), not the raw serialized bytes — this is exactly
      // where the user saw mangled garbage ("Ɛ") in earlier test reports.
      if (q.isString) {
        var dq = s2g_parseTextDoc(q.v);
        if (dq) {
          var dt = s2g_docGetText(dq);
          if (dt !== null) { prev = 'doc(' + dq.kind + ') text="' + dt + '"'; }
        }
      }
      if (prev.length > 60) { prev = prev.substring(0, 60) + '…'; }
      report.push(q.n + ' :: ' + tag + ' :: ' + prev);
    }
    fields.push('params=' + encodeURIComponent(report.join('\n')));

    if (dres) {
      fields.push('how=' + dres.how);
      fields.push('pname=' + encodeURIComponent(dres.pick.n));
      // template style capabilities (font/size controls may not be exposed)
      try { s2g_discoverStyleParams(clip, st); } catch (eS) {}
      fields.push('fontCtl=' + (st.fontParam ? '1' : '0'));
      fields.push('sizeCtl=' + (st.sizeParam ? '1' : '0'));

      // v1.5: RAW hex of the template's own value — pre-decode + decoded.
      // This shows the true prefix magic and HOW the host mangles reads
      // (field evidence: one mangled char = doc truncated at the first NUL).
      var pickRaw = (dres.pick && typeof dres.pick.raw === 'string') ? dres.pick.raw : null;
      if (pickRaw !== null) {
        fields.push('rd0p=' + encodeURIComponent(s2g_hexDump(pickRaw, 16)));
        fields.push('rd0d=' + encodeURIComponent(s2g_hexDump(s2g_fromByteStr(pickRaw), 16)));
        var mg0 = s2g_magicFromRemnant(s2g_fromByteStr(pickRaw));
        if (mg0 > 0) { fields.push('mg=' + String(mg0)); }
      } else {
        fields.push('rd0p=ERR');
      }

      // ---- v1.5 SHOOTOUT: 4 clips, one write strategy each ----
      var shots = [
        { m: 'uni',      mk: 'الف' },
        { m: 'bytes',    mk: 'بیم' },
        { m: 'raw',      mk: 'سیم' },
        { m: 'noprefix', mk: 'جیم' }
      ];
      var prevMode = S2G.writeMode;
      fields.push('shots=' + String(shots.length));
      for (var s = 0; s < shots.length; s++) {
        var t0 = ticks + (s + 1) * step;
        s2g_yield(500); // v2.1: breathe between the 4 shootout imports
        var c2 = null;
        try { c2 = seq.importMGT(path, String(t0), target, -1); } catch (eI2) { c2 = null; }
        if (!c2) { fields.push('sh' + s + '=' + encodeURIComponent('IMPORT_FAIL')); continue; }
        s2g_setTicks(c2, 'end', t0 + step);
        try { if (Number(c2.start.ticks) !== t0) { s2g_setTicks(c2, 'start', t0); } } catch (eT2) {}
        // discover the text prop on THIS clip (same path as real conversion)
        var st2 = { cues: null, textParam: null, diagNames: '', fontParam: null, sizeParam: null };
        var d2 = null;
        try { d2 = s2g_discoverTextParam(c2, st2); } catch (eD2) { d2 = null; }
        if (!d2) { fields.push('sh' + s + '=' + encodeURIComponent('NOPARAM')); continue; }
        var r2 = s2g_setTextValue(d2.pick.prop, shots[s].mk, shots[s].m);
        // read-back: parseable doc => extract text; plus the raw hex (diagnostic)
        var okv = '0', rb = '';
        try {
          var rv2 = s2g_readParamString(d2.pick.prop);
          if (rv2 !== null) {
            var d3 = s2g_parseTextDoc(rv2);
            if (d3) {
              var t3 = s2g_docGetText(d3);
              rb = 'doc:"' + String(t3) + '"';
              okv = (t3 === shots[s].mk) ? '1' : '0';
            }
          }
        } catch (eR2) {}
        try {
          var rv3 = d2.pick.prop.getValue();
          if (typeof rv3 === 'string') { rb = (rb ? rb + ' ' : '') + 'raw=' + s2g_hexDump(rv3, 12); }
        } catch (eR3) {}
        if (!rb) { rb = 'ERR'; }
        fields.push('sh' + s + '=' + encodeURIComponent(
          shots[s].m + '|' + shots[s].mk + '|' + String(t0) +
          '|set=' + (r2.ok ? '1' : '0') + '|via=' + r2.mode +
          '|mg=' + String(r2.magic || 0) + '|ok=' + okv + '|rb=' + rb));
      }
      S2G.writeMode = prevMode;
    } else {
      fields.push('how=none');
      fields.push('diag=' + encodeURIComponent(st.diagNames || 'no params'));
    }
    return s2g_ok(fields);
  } catch (e) {
    return s2g_err('E_JSX', e);
  }
}
