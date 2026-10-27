/* ============================================================================
   Study-state store (v2) — the shared synced substrate. Was single-purpose
   favorites; now holds ten namespaced maps with an account-scoped IndexedDB cache and durable
   operation queue. Verified session accounts sync to the study API; plain static
   origins retain the legacy private-Gist adapter for backward compatibility. Online-only (gated on https/localhost, NOT
   file://) so offline file:// deliverables stay self-contained. The pure core
   below is unit-tested (tools/test_favorites.mjs). Exposes window.LangFav on EVERY
   page: study pages inject capture UI + notes + progress; favorites.html renders
   the pooled library + SRS review; index renders 继续学习. srs.js / notes.js /
   progress.js layer on top via getNS/setKey/delKey. Design: plans/synced-study-state.md.
   ========================================================================== */
(function(){
  /*<<fav-pure>>*/
  // Pure, DOM/Network-free core. Extracted verbatim by the unit test.
  function FAV_PURE(){
    // ---- timestamps ----
    function tsToSec(t){
      var p = (String(t).match(/\d+/g) || []).map(Number);
      var s = 0; for (var i = 0; i < p.length; i++) s = s * 60 + p[i];
      return s;
    }
    function secToMmss(s){
      s = Math.max(0, Math.floor(+s || 0));
      var m = Math.floor(s / 60), ss = s % 60;
      return (m < 10 ? '0' : '') + m + ':' + (ss < 10 ? '0' : '') + ss;
    }
    // ---- identity: <yt>#<mmss>#<n>, n = within-second ordinal in DOM order.
    function assignFavIds(yt, tsList){
      var seen = {}, out = [];
      for (var i = 0; i < tsList.length; i++){
        var mmss = secToMmss(tsToSec(tsList[i]));
        var n = (seen[mmss] == null) ? 0 : seen[mmss] + 1;
        seen[mmss] = n;
        out.push(yt + '#' + mmss + '#' + n);
      }
      return out;
    }
/*<<page-key>>*/
    // ---- identity PREFIX: the <key> in <key>#<mmss>#<n>, derived from #clip's attributes.
    // DUPLICATED VERBATIM into favorites.js; test_page_tools.mjs asserts the two agree on a
    // shared table. It lives in the pure core because the two DOM copies DID diverge and shipped
    // that way: favorites read youtube→video→episode and page_tools read youtube→video→bilibili,
    // so on a Bilibili page favorites keyed every card on the EMPTY STRING while page_tools keyed
    // on the bvid — one card, two keyspaces, and every id-less page colliding with every other.
    // THE ORDER IS FROZEN (ids derived from it are permanent). Appending is safe; reordering is not.
    // `_p<N>` for N>1 because one bvid can be a whole COLLECTION: all seven parts of BV1p4MD6KEqW
    // are separate episodes running 0–23:4x, so without the part they would share nearly every id.
    // Part 1 stays BARE so the pages already published under the plain bvid keep theirs.
    function pageKey(a){
      a = a || {};
      var y = a.youtube || a.video || a.episode; if (y) return y;
      if (a.bilibili) return (a.page && String(a.page) !== '1') ? a.bilibili + '_p' + a.page : a.bilibili;
      var m = String(a.src || '').match(/embed\/([\w-]+)/); return m ? m[1] : '';
    }
    /*<</page-key>>*/
    // ---- furigana stripping (for the Anki FRONT: reading must not give the answer)
    function stripFuri(html){
      return String(html == null ? '' : html)
        .replace(/<rp\b[^>]*>[\s\S]*?<\/rp>/gi, '')
        .replace(/<rt\b[^>]*>[\s\S]*?<\/rt>/gi, '')
        .replace(/<[^>]+>/g, '');
    }
    function sanitizeField(s){
      return String(s == null ? '' : s).replace(/\t/g, ' ').replace(/\r?\n/g, '<br>');
    }
    // ---- Anki card: plain JP front, ruby+译+grammar back.
    function ankiCard(rec){
      var front = sanitizeField(stripFuri(rec.jp_html || ''));
      var parts = [rec.jp_html || ''];
      if (rec.cn) parts.push('【译】' + rec.cn);
      var pts = rec.points || [];
      for (var i = 0; i < pts.length; i++)
        parts.push('・' + (pts[i].term || '') + '：' + (pts[i].note || ''));
      // The pipeline's (?) means "this restoration may be a mishearing". The card is NOT dropped —
      // the user deliberately saved this line, and silently omitting it from their deck would be a
      // worse surprise than a caveat. But an unmarked card becomes a memorised fact, so the doubt
      // travels with it.
      if (/\(\?\)/.test(String(rec.jp_html || '') + String(rec.cn || '')))
        parts.push('⚠ 含 (?) 存疑还原 — 该句可能为 ASR 误听，请以原音为准');
      return { front: front, back: sanitizeField(parts.join('\n')) };
    }
    // ---- v2 map-state helpers (one map per namespace) ----
    var NS = ['items', 'srs', 'notes', 'progress', 'checkpoints', 'vocab', 'vsrs', 'activity', 'preferences', 'reading', 'completed'];
    function emptyState(){ var x = {}; NS.forEach(function(ns){ x[ns] = {}; }); return x; }
    function cloneState(state){
      state = state || {};
      var out = emptyState();
      for (var n = 0; n < NS.length; n++){
        var src = state[NS[n]] || {}, dst = out[NS[n]];
        for (var k in src) if (Object.prototype.hasOwnProperty.call(src, k)) dst[k] = src[k];
      }
      return out;
    }
    // v1 (or version-less) doc → map state; no favorites lost or moved. A doc from before a
    // namespace existed simply has no key for it → {}.
    function migrate(parsed){
      parsed = parsed || {};
      var out = emptyState(); NS.forEach(function(ns){ out[ns] = parsed[ns] || {}; }); return out;
    }
    // v2 writer: ALWAYS serialize every namespace map under {v:2, …}.
    function serialize(state){
      var out = {v:2}, maps = migrate(state); NS.forEach(function(ns){ out[ns] = maps[ns]; }); return out;
    }
    // normalize a legacy favorite op into a v2 namespaced op.
    function normalizeOp(o){
      if (!o) return null;
      if (o.ns) return { ns: o.ns, op: o.op, key: o.key, value: o.value };
      if (o.op === 'add') return { ns: 'items', op: 'set', key: o.id, value: o.record };
      if (o.op === 'del') return { ns: 'items', op: 'del', key: o.id };
      return null;
    }
    // ---- op-replay merge across the namespaces (pure; no wall-clock, no tombstones).
    function applyOps(state, ops){
      var out = cloneState(state);
      for (var i = 0; i < (ops || []).length; i++){
        var o = normalizeOp(ops[i]);
        if (!o || NS.indexOf(o.ns) < 0) continue;
        var map = out[o.ns];
        if (o.op === 'set') map[o.key] = o.value;
        else if (o.op === 'del') delete map[o.key];
      }
      return out;
    }
    // ---- sync engine: pull → apply pending ops → PATCH. On a CONFLICT, re-pull, re-apply, retry.
    //
    // This used to say "PATCH with If-Match(etag) … on 412 re-pull". Both halves were wrong, and
    // verified wrong against the live API:
    //
    //   * GitHub's gist API does not support If-Match. Sending one is not ignored — it is a 400.
    //     So the compare-and-swap this design was built around was never possible, and the only
    //     reason sync worked at all is that the request adapter quietly dropped the header.
    //   * GitHub signals "you based this write on a stale version" with 409 Conflict, not 412. So
    //     this retry — the entire point of the engine — NEVER FIRED. A concurrent edit surfaced to
    //     the user as 同步失败：409 with their stars stranded in the queue, when the code was fully
    //     equipped to re-pull, replay the ops, and win on the next attempt.
    //
    // The good news, also verified: because GitHub rejects the stale write, no update is ever lost.
    // The conflict is real, it is detected server-side, and it is recoverable. Recover from it.
    function makeSync(deps){
      var request = deps.request;                        // (kind, opts) -> {ok,status,etag,body}
      async function flush(ops){
        // Always read immediately before writing. A `pulled` state handed in from page-load could be
        // minutes stale, and with last-write-wins that is a licence to destroy everything another
        // device did in the meantime.
        var g = await request('GET');
        var base = g.body, baseVersion = g.version, etag = g.etag;
        for (var attempt = 0; attempt < 5; attempt++){
          var merged = applyOps(base, ops);
          var res = await request('PATCH', { body: merged });     // no If-Match — GitHub 400s on one
          if (res.ok){
            // LAST-WRITE-WINS DAMAGE CONTROL. GitHub accepted the write unconditionally. If the commit
            // we just made does not sit on top of the revision we read, another device wrote into that
            // window and we have just silently overwritten them. git still has their commit: fetch the
            // revision we landed on (our parent), replay our ops on top of THAT, and write again.
            if (baseVersion && res.parent && res.parent !== baseVersion){
              var lost = await request('GET_REV', { version: res.parent });   // what we just destroyed
              base = lost.body;                                               // rebuild on top of it
              baseVersion = res.version;                                      // we are now the head
              continue;
            }
            return { state: merged, etag: res.etag };
          }
          // 409 = two writes hitting the gist's git lock at once. Transient, not a version check —
          // never rely on it to prevent a lost update. 412 is kept for a backend that does real CAS.
          if (res.status === 409 || res.status === 412){
            var re = await request('GET'); base = re.body; baseVersion = re.version; etag = re.etag; continue;
          }
          var perr = new Error('sync PATCH failed: ' + res.status); perr.status = res.status; throw perr;
        }
        throw new Error('sync: too many conflicts');
      }
      return { flush: flush };
    }
    // ---- self-heal wrapper: a cached gist id can go stale; on 404 drop it, re-resolve, retry ONCE.
    function makeSyncEngine(deps){
      var resolve = deps.resolve;   // (force) -> Promise<gid>
      var makeReq = deps.makeReq;   // (gid) -> request(kind, opts)
      async function withHeal(run){
        var gid = await resolve(false);
        try { return await run(makeReq(gid)); }
        catch (e){
          if (!(e && e.status === 404)) throw e;
          var fresh = await resolve(true);
          return await run(makeReq(fresh));
        }
      }
      function push(ops){ return withHeal(function(req){ return makeSync({ request: req }).flush(ops); }); }
      function pull(){ return withHeal(function(req){ return req('GET'); }); }
      return { push: push, pull: pull };
    }
    // ---- optional client-side encryption (AES-GCM, PBKDF2). Unused wiring; kept as-is.
    function makeCrypto(subtle, getRandom){
      var enc = new TextEncoder(), dec = new TextDecoder();
      function b64(buf){ var b = new Uint8Array(buf), s = ''; for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); }
      function unb64(str){ var s = atob(str), b = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; }
      async function keyFrom(pass, salt){
        var base = await subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
        return subtle.deriveKey({ name: 'PBKDF2', salt: salt, iterations: 150000, hash: 'SHA-256' },
          base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      }
      async function encrypt(pass, text){
        var salt = getRandom(16), iv = getRandom(12), key = await keyFrom(pass, salt);
        var ct = await subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, enc.encode(text));
        return { v: 1, alg: 'AES-GCM', salt: b64(salt), iv: b64(iv), ct: b64(ct) };
      }
      async function decrypt(pass, blob){
        var key = await keyFrom(pass, unb64(blob.salt));
        var pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(blob.iv) }, key, unb64(blob.ct));
        return dec.decode(pt);
      }
      return { encrypt: encrypt, decrypt: decrypt };
    }
    // ---- sync-dot state: 'off' | 'err' | 'wait' | 'ok'
    function syncStatus(s){
      s = s || {};
      if (!s.hasToken) return 'off';
      if (s.lastErr) return 'err';
      if (s.pending > 0) return 'wait';
      return 'ok';
    }
    // ---- canonical term text. ONE definition, TWO consumers that must differ on one point:
    // srs.js's clozeCore strips only, because its output has to stay a VERBATIM substring of the
    // sentence surface; vocab.js's termId additionally NFKC-folds, because 第４段階 and 第4段階 are
    // one card but are not the same span of text. Folding inside clozeCore would silently shrink
    // clozePick's coverage (第４段階→第4段階, （笑）→(笑), １つ→1つ) with no error anywhere.
    // tools/test_vocab.mjs pins both the agreement and the divergence.
    // ★ is the 重点 MARKER, never part of the term — and build_page puts it INSIDE the chip span
    // and AFTER the text, as a nested star span, so a leading-anchored strip caught 1 of 5,977
    // starred chips across the 45 built pages. (Do NOT paste the literal chip markup into a
    // comment here: propagate.py's _CHIP_RE rewrites that shape ANYWHERE in the page and would
    // splice an xref <a> into this script. Its uniqueness assert catches it, loudly.) Measured
    // fallout: 0 of those 5,977 were a verbatim substring of their own sentence, so 重点 lines —
    // the ones an analyst flagged as most important — were the LEAST likely to get a cloze card
    // (43.1% vs 61.4% overall). Stripping the star anywhere takes 重点 to 77.0%. The marker of
    // importance was the cause of the degradation. Strip it everywhere the term is read.
    function stripStar(t){ return String(t == null ? '' : t).replace(/★/g, '').trim(); }
    function stripPlaceholders(t){
      return stripStar(t)
        .replace(/^[〜～~…\/\s]+/, '').replace(/[〜～~…\/\s]+$/, '').trim();
    }
    // Sentence surface: readings and tags stripped. Duplicated from srs.js's surfaceOf ON PURPOSE
    // — srs.js is not loaded on study pages, and vocabCardTypes must answer IDENTICALLY on a study
    // page and on favorites.html or reconcile adds the cloze card on one surface and deletes it on
    // the other, forever, through the synced op log. test_vocab.mjs pins the two implementations
    // output-equal, the same way it pins clozeCore against stripPlaceholders.
    function surfaceOf(html){
      return String(html == null ? '' : html).replace(/<rt>[\s\S]*?<\/rt>/g, '').replace(/<[^>]+>/g, '');
    }
    function normTerm(t){
      var s = stripPlaceholders(t);
      return s.normalize ? s.normalize('NFKC') : s;
    }
    return { tsToSec: tsToSec, secToMmss: secToMmss, assignFavIds: assignFavIds, pageKey: pageKey,
             stripStar: stripStar, stripPlaceholders: stripPlaceholders, normTerm: normTerm,
             surfaceOf: surfaceOf,
             stripFuri: stripFuri, sanitizeField: sanitizeField, ankiCard: ankiCard,
             migrate: migrate, serialize: serialize, applyOps: applyOps,
             makeSync: makeSync, makeSyncEngine: makeSyncEngine,
             makeCrypto: makeCrypto, syncStatus: syncStatus };
  }
  /*<</fav-pure>>*/

  /*<<account-pure>>*/
  // Account replay keeps canonical server state separate from optimistic operations.
  function ACCOUNT_PURE(){
    var names = ['items', 'srs', 'notes', 'progress', 'checkpoints', 'vocab', 'vsrs', 'activity', 'preferences', 'reading', 'completed'];
    function clone(x){ return JSON.parse(JSON.stringify(x)); }
    function empty(){ var x = {}; names.forEach(function(n){ x[n] = {}; }); return x; }
    function validKey(k){ return typeof k === 'string' && k.length > 0 && k.length <= 512 && ['__proto__','constructor','prototype'].indexOf(k) < 0; }
    function isCard(v){
      return !!(v&&typeof v==='object'&&['due','ivl','ease','reps','lapses'].every(function(k){return Number.isFinite(v[k]);})&&
        v.due>=0&&v.ivl>=0&&v.ivl<=365000&&v.ease>=1.3&&v.ease<=3&&
        Number.isInteger(v.reps)&&v.reps>=0&&Number.isInteger(v.lapses)&&v.lapses>=0);
    }
    function preferenceKey(k){ return ['playbackRate','followMode','furigana','translations','cnMask','sentenceControls','toolbarArrangement','playerInteraction','uiLocale','theme','studyMode','shadowStyle'].indexOf(k) >= 0; }
    function preferenceValue(k,v){
      if(k==='studyMode')return ['listen','shadow','dictate'].indexOf(v)>=0;
      if(k==='shadowStyle')return ['loop','run'].indexOf(v)>=0;
      if(k==='uiLocale')return ['zh','en','ja'].indexOf(v)>=0;
      if(k==='theme')return ['auto','light','dark'].indexOf(v)>=0;
      if(k==='playbackRate')return Number.isFinite(v)&&v>=.25&&v<=3;
      if(k==='followMode')return ['off','on','sticky'].indexOf(v)>=0;
      if(k==='sentenceControls')return ['original','bottom','below'].indexOf(v)>=0;
      if(k==='playerInteraction')return ['buttons','tap'].indexOf(v)>=0;
      if(k==='toolbarArrangement')return ['a','b','c'].indexOf(v)>=0;
      if(k==='furigana'||k==='translations')return typeof v==='boolean';
      return k==='cnMask'&&Number.isInteger(v)&&v>=0&&v<=2;
    }
    var uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    function checkpointValue(v){
      return !!(v&&typeof v==='object'&&!Array.isArray(v)&&typeof v.page==='string'&&/^[a-zA-Z0-9_-]+\.html$/.test(v.page)&&v.page.length<=512&&
        typeof v.id==='string'&&v.id.length>0&&v.id.length<=512&&Number.isFinite(v.sec)&&v.sec>=0&&Number.isSafeInteger(v.at)&&v.at>=0&&
        typeof v.deviceId==='string'&&uuid.test(v.deviceId)&&typeof v.device==='string'&&v.device.length>0&&v.device.length<=80);
    }
    function pageValue(ns,v){
      return !!(v&&typeof v==='object'&&!Array.isArray(v)&&Number.isSafeInteger(v.at)&&v.at>=0&&
        (ns==='reading'?typeof v.id==='string'&&v.id.length>0&&v.id.length<=512:typeof v.done==='boolean'));
    }
    function valid(o){
      if (!o || names.indexOf(o.ns) < 0 || !validKey(o.key)) return false;
      if (['progress','reading','completed'].indexOf(o.ns)>=0 && !/^[a-zA-Z0-9_-]+\.html$/.test(o.key))return false;
      if (o.ns==='checkpoints'&&!uuid.test(o.key))return false;
      if (o.ns==='preferences'&&!preferenceKey(o.key))return false;
      if (o.op === 'review') return (o.ns === 'srs' || o.ns === 'vsrs') && ['again','hard','good','easy'].indexOf(o.grade) >= 0 && Number.isSafeInteger(o.at) && o.at >= 0 && o.at <= Math.floor(Date.now()/1000)+300;
      if (o.op === 'del') return true;
      if (o.op !== 'set' && o.op !== 'import') return false;
      if((o.ns==='srs'||o.ns==='vsrs')&&!isCard(o.value))return false;
      if(o.ns==='checkpoints'&&!checkpointValue(o.value))return false;
      if(o.ns==='preferences'&&!preferenceValue(o.key,o.value))return false;
      if((o.ns==='reading'||o.ns==='completed')&&!pageValue(o.ns,o.value))return false;
      try { return o.value !== undefined && new TextEncoder().encode(JSON.stringify(o.value)).length <= 65536; } catch(e){ return false; }
    }
    // Identical scheduler to SRS_PURE; usable during boot before srs.js has loaded.
    function schedule(card, grade, now){
      var c = card || { due: now, ivl: 0, ease: 2.5, reps: 0, lapses: 0 };
      var ease = c.ease, ivl = c.ivl, reps = c.reps, lapses = c.lapses;
      function clamp(e){ return Math.max(1.3, Math.min(3.0, e)); }
      if (grade === 'again') return { due: now, ivl: 0, ease: clamp(ease - .20), reps: 0, lapses: lapses + 1 };
      var n;
      if (grade === 'hard'){ ease = clamp(ease - .15); n = reps === 0 ? 1 : Math.max(ivl + 1, Math.round(ivl * 1.2)); }
      else if (grade === 'easy'){ ease = clamp(ease + .15); n = reps === 0 ? 3 : Math.round(ivl * ease * 1.3); }
      else { ease = clamp(ease); n = reps === 0 ? 1 : Math.round(ivl * ease); }
      return { due: now + n * 86400, ivl: n, ease: ease, reps: reps + 1, lapses: lapses };
    }
    function replay(base, pending){
      var x = clone(base || empty());
      names.forEach(function(ns){ if(!x[ns])x[ns]={}; });
      (pending || []).forEach(function(o){
        if (!valid(o)) return;
        var m = x[o.ns];
        if (o.acked && o.overlay){if(o.overlay.op==='del')delete m[o.key];else m[o.key]=clone(o.overlay.value);}
        else if (o.op === 'del') delete m[o.key];
        else if (o.op === 'review') m[o.key] = schedule(m[o.key], o.grade, o.at);
        else if (o.op === 'set' || !Object.prototype.hasOwnProperty.call(m,o.key)) m[o.key] = clone(o.value);
      });
      return x;
    }
    function needsUpgrade(doc){
      return doc.cacheVersion!==7 || doc.appliedCursor!==doc.cursor || !doc.base || (doc.ops||[]).some(function(o){return typeof o.attempted!=='boolean';}) || names.some(function(ns){return !Object.prototype.hasOwnProperty.call(doc.base,ns);});
    }
    function upgrade(doc){
      var missing=!doc.base || names.some(function(ns){return !Object.prototype.hasOwnProperty.call(doc.base,ns);});
      // Old readers consumed revisions for namespaces or preference keys they rejected.
      var old=doc.cacheVersion!==7 || (doc.appliedCursor!==undefined&&doc.appliedCursor!==doc.cursor);
      if(old || missing || (doc.appliedCursor!==undefined && doc.appliedCursor!==doc.cursor)){doc.cursor=0;doc.complete=false;}
      // Old readers did not persist dispatch intent; even a failed reply can
      // represent an accepted write. Never cancel their unknown outcomes.
      (doc.ops||[]).forEach(function(o){if(old||typeof o.attempted!=='boolean')o.attempted=true;});
      doc.base = doc.base || empty();
      names.forEach(function(ns){ if(!doc.base[ns])doc.base[ns]={}; });
      doc.cacheVersion=7;doc.appliedCursor=doc.cursor;return doc;
    }
    function applyReply(doc, reply, sent, known){
      upgrade(doc);
      var delivered = new Set(sent.map(function(o){return o.id;}));
      var ack = new Set((reply.acked || []).filter(function(id){return delivered.has(id);})), covered=new Set(known||[]);
      var accepted=doc.ops.filter(function(o){return !o.acked&&ack.has(o.id);});
      if(accepted.length){
        // A paginated reply can acknowledge a write before replay reaches its row.
        var visible=replay(doc.base,doc.ops.filter(function(o){return o.acked||ack.has(o.id);}));
        doc.ops=doc.ops.map(function(o){if(o.acked||!ack.has(o.id))return o;var held=clone(o);held.acked=true;held.overlay=Object.prototype.hasOwnProperty.call(visible[o.ns],o.key)?{op:'set',value:clone(visible[o.ns][o.key])}:{op:'del'};return held;});
      }
      // A delayed response must never roll a newer shared base backwards.
      if (reply.cursor >= doc.cursor){
        (reply.changes || []).forEach(function(c){
          if (!valid({ns:c.ns,key:c.key,op:c.deleted?'del':'set',value:c.value})) return;
          if (c.deleted) delete doc.base[c.ns][c.key]; else doc.base[c.ns][c.key] = clone(c.value);
        });
        doc.cursor = reply.cursor;doc.appliedCursor=reply.cursor;doc.complete = !reply.more;
        // Only a complete request made after an acknowledgement can cover its row.
        if(!reply.more)doc.ops=doc.ops.filter(function(o){return !o.acked||(!ack.has(o.id)&&!covered.has(o.id));});
      }
      if(doc.ops.some(function(o){return o.acked;}))doc.complete=false;
      return doc;
    }
    // Compact assignments, never events or attempted operations. Birth evidence
    // is local metadata and never changes the surviving wire ID/payload.
    function compactPositions(ops){
      var seen=Object.create(null),out=[];
      for(var i=0;i<ops.length;i++){
        var op=ops[i],position=['progress','reading','checkpoints'].indexOf(op.ns)>=0,key=op.ns+'\u0000'+op.key;
        var assignment=position||['notes','preferences','completed'].indexOf(op.ns)>=0;
        if(!assignment||op.op!=='set'||op.acked||op.attempted===true||(!position&&op.attempted!==false)){delete seen[key];out.push(op);continue;}
        if(seen[key]!==undefined){var previous=out[seen[key]];if(previous.newCheckpoint){op=clone(op);op.newCheckpoint=true;}out[seen[key]]=null;}
        seen[key]=out.length;out.push(op);
      }
      return out.filter(function(o){return o!==null;});
    }
    function compactQueue(doc,transactional){
      doc.ops=compactPositions(doc.ops);
      if(!transactional||!doc.complete)return doc;
      var groups=Object.create(null),remove=new Set();
      doc.ops.forEach(function(o,i){if(o.ns==='checkpoints')(groups[o.key]||(groups[o.key]=[])).push(i);});
      Object.keys(groups).forEach(function(key){
        var indexes=groups[key],first=doc.ops[indexes[0]],last=doc.ops[indexes[indexes.length-1]];
        if(Object.prototype.hasOwnProperty.call(doc.base.checkpoints,key)||!first.newCheckpoint||first.op!=='set'||last.op!=='del')return;
        if(indexes.every(function(i){var o=doc.ops[i];return o.attempted===false&&!o.acked&&(o.op==='set'||o.op==='del');}))indexes.forEach(function(i){remove.add(i);});
      });
      doc.ops=doc.ops.filter(function(o,i){return !remove.has(i);});return doc;
    }
    function outbound(ops){
      var out = [], bytes = 100;
      for (var i=0;i<ops.length && out.length<4;i++){
        if(ops[i].acked)continue;
        var size = new TextEncoder().encode(JSON.stringify(ops[i])).length + 1;
        if (bytes + size > 450000) break;
        var wire=clone(ops[i]);delete wire.attempted;delete wire.newCheckpoint;
        bytes += size; out.push(wire);
      }
      return out;
    }
    return { empty: empty, clone: clone, valid: valid, replay: replay, schedule: schedule, needsUpgrade: needsUpgrade, upgrade: upgrade, applyReply: applyReply, compactPositions: compactPositions, compactQueue:compactQueue, outbound: outbound };
  }
  /*<</account-pure>>*/

  // ---- online-only: https or localhost; NOT file:// (Chrome reports file:// AS secure).
  var loc = window.location || {};
  if (!(loc.protocol === 'https:' || loc.hostname === 'localhost' || loc.hostname === '127.0.0.1')) return;
  var P = FAV_PURE(), AP = ACCOUNT_PURE(), accountOrigin = loc.hostname.split('.')[0] === 'lang';

  var K = { store: 'langfav:v1', srs: 'langfav:srs', notes: 'langfav:notes',
            progress: 'langfav:progress', checkpoints: 'langfav:checkpoints', vocab: 'langfav:vocab', vsrs: 'langfav:vsrs',
            activity: 'langfav:activity', preferences: 'langfav:preferences',
            reading: 'langfav:reading', completed: 'langfav:completed',
            ops: 'langfav:ops', tok: 'langfav:tok', gid: 'langfav:gid' };
  var NS = ['items', 'srs', 'notes', 'progress', 'checkpoints', 'vocab', 'vsrs', 'activity', 'preferences', 'reading', 'completed'];
  function readJSON(k, d){ try { var s = localStorage.getItem(k); return s ? JSON.parse(s) : d; } catch (e){ return d; } }
  function writeJSON(k, v){ try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e){ return false; } }

  function safeStudyHTML(html){
    var template=document.createElement('template');template.innerHTML=String(html||'');
    var out=document.createElement('div'),allowed=['ruby','rt','rp','span','em','strong','b','i','br'];
    var discard=['script','style','iframe','object','embed','svg','math','img','video','audio','link','meta','base','form','input','button','textarea','select'];
    function visit(node,parent){
      if(node.nodeType===3){parent.appendChild(document.createTextNode(node.textContent));return;}
      if(node.nodeType!==1)return;
      var tag=node.localName.toLowerCase();if(discard.indexOf(tag)>=0)return;
      var target=parent;
      if(allowed.indexOf(tag)>=0){
        target=document.createElement(tag);
        var cls=node.getAttribute('class');
        if(tag==='span'&&cls&&cls.length<=128&&/^[a-zA-Z0-9_ -]+$/.test(cls))target.setAttribute('class',cls);
        parent.appendChild(target);
      }
      Array.from(node.childNodes).forEach(function(child){visit(child,target);});
    }
    Array.from(template.content.childNodes).forEach(function(node){visit(node,out);});return out.innerHTML;
  }
  function cleanValue(ns,value){
    var x=AP.clone(value);
    if(x&&typeof x==='object'&&!Array.isArray(x)){
      if(ns==='items'&&x.jp_html!=null)x.jp_html=safeStudyHTML(String(x.jp_html));
      if(ns==='vocab'&&x.src!=null)x.src=safeStudyHTML(String(x.src));
      if((ns==='items'||ns==='vocab')&&(typeof x.page!=='string'||!/^[a-zA-Z0-9_-]+\.html$/.test(x.page)))x.page='';
    }
    return x;
  }
  function cleanState(input){
    var x=AP.empty(),maps=P.migrate(input);
    NS.forEach(function(ns){Object.keys(maps[ns]||{}).forEach(function(key){
      if(AP.valid({ns:ns,key:key,op:'set',value:maps[ns][key]}))x[ns][key]=cleanValue(ns,maps[ns][key]);
    });});return x;
  }
  var state = { items: readJSON(K.store, {}), srs: readJSON(K.srs, {}),
                notes: readJSON(K.notes, {}), progress: readJSON(K.progress, {}), checkpoints: readJSON(K.checkpoints, {}),
                vocab: readJSON(K.vocab, {}), vsrs: readJSON(K.vsrs, {}),
                activity: readJSON(K.activity, {}), preferences: readJSON(K.preferences, {}),
                reading: readJSON(K.reading, {}), completed: readJSON(K.completed, {}) };
  state=cleanState(state);
  var favs = state.items;                // alias kept for the capture UI
  var ops  = readJSON(K.ops, []);        // pending, not-yet-synced ops
  var changeHooks = [];
  var available = false, user = readJSON('langstudy:identity', null), owner = user && user.id;
  if(typeof owner!=='string'||!owner){user=null;owner=null;}
  var activeKey = 'langstudy:active', storageFailed = false, hydrated = !owner;
  var durable = Promise.resolve(), optimistic = [], dbPromise = null;
  if (owner){ setState(AP.empty()); ops = []; }
  function active(){ return !owner || readJSON(activeKey, owner) === owner; }
  function identityId(){
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    // UUID v4 uses cryptographic randomness, also available on older browsers.
    var b = new Uint8Array(16); window.crypto.getRandomValues(b); b[6] = (b[6]&15)|64; b[8] = (b[8]&63)|128;
    var h = Array.from(b,function(v){return ('0'+v.toString(16)).slice(-2);}).join('');
    return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20);
  }
  function freshDoc(){ return AP.upgrade({ base: AP.empty(), cursor: 0, ops: [], complete: false }); }
  function openDB(){
    if (!dbPromise) dbPromise = new Promise(function(resolve){
      if (!window.indexedDB){ resolve(null); return; }
      var r; try { r = window.indexedDB.open('lang-study',1); } catch(e){ resolve(null); return; }
      r.onupgradeneeded = function(){ r.result.createObjectStore('accounts'); };
      r.onsuccess = function(){ resolve(r.result); };
      r.onerror = r.onblocked = function(){ resolve(null); };
    });
    return dbPromise;
  }
  function prefix(id){ return 'langstudy:account:'+encodeURIComponent(id)+':'; }
  // Fallback writes immutable per-operation/per-cursor keys. A stale tab cannot
  // replace another tab's queue or cached base with a whole localStorage snapshot.
  function localDoc(id){
    var p = prefix(id), doc = freshDoc(), current = false;
    for (var i=0;i<localStorage.length;i++){
      var k = localStorage.key(i);
      if (k && k.indexOf(p+'base:')===0){
        var d = readJSON(k,null), modern = k.indexOf(p+'base:v7:')===0 || !!(d&&d.cacheVersion===7);
        // Old tabs can still write higher cursors after ignoring new maps or keys.
        if(d && ((modern&&!current)||(modern===current&&d.cursor>=doc.cursor))){doc.base=d.base;doc.cursor=d.cursor;doc.complete=!!d.complete;doc.cacheVersion=d.cacheVersion;doc.appliedCursor=d.appliedCursor;doc.localKey=k;current=modern;}
      }
      if (k && k.indexOf(p+'op:')===0){ var o=readJSON(k,null); if(o && !localStorage.getItem(p+'ack:'+o.id)){o.attempted=true;doc.ops.push(o);} }
    }
    doc.ops.sort(function(a,b){ return a.order-b.order || a.id.localeCompare(b.id); });
    return doc;
  }
  async function transaction(id, mutate){
    var db = await openDB();
    if (!db){
      var old = localDoc(id), upgraded=AP.needsUpgrade(old), doc=AP.upgrade(AP.clone(old));
      if(mutate)doc=mutate(doc);
      if (mutate || upgraded){
        var p = prefix(id), keep = new Set(doc.ops.map(function(o){return o.id;}));
        try {
          var snapshotKey=p+'base:v7:'+doc.cursor,snapshot=JSON.stringify({base:doc.base,cursor:doc.cursor,complete:doc.complete,cacheVersion:doc.cacheVersion,appliedCursor:doc.appliedCursor});
          try {localStorage.setItem(snapshotKey,snapshot);}
          catch(e){
            // setItem replaces atomically: reuse the selected snapshot's space
            // when a second full copy exceeds quota, without deleting its backup.
            if(e.name!=='QuotaExceededError'||!old.localKey)throw e;
            snapshotKey=old.localKey;localStorage.setItem(snapshotKey,snapshot);
          }
          // Compact only after the new canonical data is durable. Immutable
          // operation keys and acknowledgement markers remain independent.
          var stale=[];
          for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);if(k&&k!==snapshotKey&&(k===old.localKey||(k.indexOf(p+'base:v7:')===0&&Number(k.slice((p+'base:v7:').length))<=old.cursor)))stale.push(k);}
          stale.forEach(function(k){localStorage.removeItem(k);});
          doc.localKey=snapshotKey;
          // A superseded position remains recoverable until its replacement is
          // durable. A quota failure must never erase the last offline point.
          doc.ops.forEach(function(o){ localStorage.setItem(p+'op:'+o.id,JSON.stringify(o)); });
          old.ops.forEach(function(o){if(!keep.has(o.id)){localStorage.setItem(p+'ack:'+o.id,'1');localStorage.removeItem(p+'op:'+o.id);}});
        } catch(e){ storageFailed = true;useDoc(id,AP.upgrade(AP.clone(old)));throw e; }
      }
      return doc;
    }
    return new Promise(function(resolve,reject){
      var tx = db.transaction('accounts','readwrite'), store = tx.objectStore('accounts'), r = store.get(id), doc;
      r.onsuccess = function(){ doc=r.result||freshDoc();var upgraded=AP.needsUpgrade(doc);doc=AP.upgrade(doc);if(mutate)doc=AP.compactQueue(mutate(doc),true);if(mutate||upgraded)store.put(doc,id); };
      tx.oncomplete = function(){ resolve(doc); };
      tx.onerror = tx.onabort = function(){ storageFailed=true;reject(tx.error||new Error('study storage unavailable')); };
    });
  }
  function useDoc(id, doc){
    if (owner!==id || !active()) return;
    hydrated=!!doc.complete;ops = doc.ops; var ids = new Set(ops.map(function(o){return o.id;}));
    setState(AP.replay(cleanState(doc.base),ops.concat(optimistic.filter(function(o){return !ids.has(o.id);})).map(function(o){
      var x=AP.clone(o);if(x.value!==undefined)x.value=cleanValue(x.ns,x.value);if(x.overlay&&x.overlay.op==='set')x.overlay.value=cleanValue(x.ns,x.overlay.value);return x;
    })));
  }
  function persistAccount(op){
    var id = owner; optimistic=AP.compactPositions(optimistic.concat(op));
    durable = durable.then(function(){
      // A newer synchronous position can supersede a write before its disk job
      // starts. Avoid hundreds of redundant transactions during queue recovery.
      var pending=optimistic.find(function(o){return o.id===op.id;});if(!pending)return null;
      return transaction(id,function(doc){if(!doc.ops.some(function(o){return o.id===op.id;}))doc.ops.push(pending);doc.ops=AP.compactPositions(doc.ops);return doc;});
    }).then(function(doc){
      optimistic = optimistic.filter(function(o){return o.id!==op.id;});if(!doc)return;useDoc(id,doc);
      try { localStorage.setItem('langstudy:changed',identityId()); } catch(e){}
    }).catch(function(){storageFailed=true;lastErr=true;fireChange();});
  }
  var lastErr = false;

  function persist(){
    if (owner) return;
    writeJSON(K.store, state.items); writeJSON(K.srs, state.srs);
    writeJSON(K.notes, state.notes); writeJSON(K.progress, state.progress); writeJSON(K.checkpoints, state.checkpoints);
    writeJSON(K.vocab, state.vocab); writeJSON(K.vsrs, state.vsrs);
    writeJSON(K.activity, state.activity);
    writeJSON(K.preferences, state.preferences); writeJSON(K.reading, state.reading); writeJSON(K.completed, state.completed);
  }
  function setState(next){ state = next; favs = state.items; }
  function queueOp(op){
    if (owner){
      op = AP.clone(op); op.id=identityId(); op.order=sequence=Math.max(sequence+1,Date.now()*1000);
      op.attempted=false;persistAccount(op); return;
    }
    if(op.op==='import')op.op='set'; // guest imports use the legacy operation vocabulary
    if (op && op.ns && op.key != null){                  // coalesce same ns+key: a key's synced state = its last op (bounds a long session's queue)
      for (var i = ops.length - 1; i >= 0; i--) if (ops[i].ns === op.ns && ops[i].key === op.key) ops.splice(i, 1);
    }
    ops.push(op); writeJSON(K.ops, ops);
  }
  function fireChange(){ reflect(); for (var i = 0; i < changeHooks.length; i++){ try { changeHooks[i](); } catch (e){} } }
  var batching = false, sequence = 0;
  // batch: apply many writes, then fire ONE change + ONE flush (avoids O(N) render/flush storms, e.g. srs reconcile).
  function batch(fn){ batching = true; try { fn(); } finally { batching = false; } fireChange(); scheduleFlush(); }

  function addFav(record){ if(record) setKey('items',record.id,record); }
  function removeFav(id){ delKey('items',id); }
  // generic namespace API for srs.js / notes.js / progress.js
  function getNS(ns){ return state[ns] || {}; }
  // record that the user reviewed TODAY (local date) — the streak signal for the 今日学习 home.
  // Op-replay is last-write-wins per key, but the streak only reads a day's PRESENCE, so a
  // same-day write from another device can never break the streak (the key still exists).
  function todayStr(){ var d = new Date(), p = function(n){ return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }
  function stampToday(){ var s = todayStr(); setKey('activity', s, (getNS('activity')[s] || 0) + 1); }
  function setKey(ns, key, value, opts){
    var op = { ns: ns, op: opts && opts.import ? 'import' : 'set', key: key, value: value };
    if (!AP.valid(op) || !active()) return false;
    if(op.op==='set'&&['notes','preferences','progress','reading','completed'].indexOf(ns)>=0&&JSON.stringify(state[ns][key])===JSON.stringify(cleanValue(ns,value)))return true;
    if(ns==='checkpoints'&&opts&&opts.newCheckpoint&&op.op==='set')op.newCheckpoint=true;
    // Guest preferences have a synchronous persistence contract. Commit the one
    // namespace atomically before changing memory or the legacy sync queue; a
    // rejected choice must leave the prior durable data available for retry.
    // Signed-in writes keep their existing optimistic asynchronous account queue.
    if (!owner && ns==='preferences'){
      var nextPreferences=Object.assign({},state.preferences);nextPreferences[key]=cleanValue(ns,value);
      if(!writeJSON(K.preferences,nextPreferences))return false;
    }
    if (owner && (ns==='srs'||ns==='vsrs') && !state[ns][key]) op.op='import';
    op.value=cleanValue(ns,value);state[ns][key] = AP.clone(op.value); queueOp(op); persist();
    if (!batching){fireChange();if(!(opts&&opts.defer))scheduleFlush();} return true;
  }
  function delKey(ns, key, opts){
    var op = { ns: ns, op: 'del', key: key };
    if (!AP.valid(op) || !active() || state[ns][key] == null) return false;
    delete state[ns][key]; queueOp(op); persist();if(!batching){fireChange();if(!(opts&&opts.defer))scheduleFlush();}return true;
  }
  function review(ns,key,grade,at){
    var op = { ns: ns, key: key, op: 'review', grade: grade, at: at == null ? Math.floor(Date.now()/1000) : at };
    if(!AP.valid(op)||!active())return false;
    if(!owner){setKey(ns,key,AP.schedule(state[ns][key],grade,op.at));return true;}
    state[ns][key]=AP.schedule(state[ns][key],grade,op.at);queueOp(op);fireChange();scheduleFlush();return true;
  }

  // ---------- sync (opt-in): localStorage cache ⇄ private Gist (source of truth) ----------
  var FILE = 'lang-favorites.json';
  function token(){ try { return localStorage.getItem(K.tok) || ''; } catch (e){ return ''; } }
  async function api(method, path, body){
    return fetch('https://api.github.com' + path, {
      method: method,
      headers: { 'Authorization': 'Bearer ' + token(), 'Accept': 'application/vnd.github+json',
                 'X-GitHub-Api-Version': '2022-11-28' },
      body: body ? JSON.stringify(body) : undefined
    });
  }
  async function findGist(){
    var gid = null; try { gid = localStorage.getItem(K.gid); } catch (e){}
    if (gid) return gid;
    var r = await api('GET', '/gists?per_page=100'); if (!r.ok){ var le = new Error('gist list ' + r.status); le.status = r.status; throw le; }
    var hit = (await r.json()).filter(function(g){ return g.files && g.files[FILE]; })[0];
    if (hit){ try { localStorage.setItem(K.gid, hit.id); } catch (e){} return hit.id; }
    var files = {}; files[FILE] = { content: JSON.stringify(P.serialize({})) };
    var c = await api('POST', '/gists', { description: 'lang-analysis favorites (do not delete)', public: false, files: files });
    if (!c.ok){ var ce = new Error('gist create ' + c.status); ce.status = c.status; throw ce; }
    var g = await c.json(); try { localStorage.setItem(K.gid, g.id); } catch (e){} return g.id;
  }
  function makeRequest(gid){
    // A gist is a git repo, and that is the only concurrency primitive this API gives us. There is no
    // If-Match (sending one is a 400) and no version precondition on PATCH — writes are LAST-WRITE-WINS.
    // But every revision is a commit, and `history[0].version` is the head. So a write's PARENT tells us
    // which revision we actually landed on top of. If that is not the revision we read, another device
    // wrote in between and we just destroyed it — and we can fetch exactly what we destroyed, because
    // git kept it. See makeSync.flush.
    async function readAt(path){
      var r = await api('GET', path); if (!r.ok){ var ge = new Error('gist get ' + r.status); ge.status = r.status; throw ge; }
      var etag = r.headers.get('ETag'); var g = await r.json();
      var f = g.files && g.files[FILE]; var content = f ? f.content : '';
      if (f && f.truncated && f.raw_url) content = await (await fetch(f.raw_url)).text();
      var parsed; try { parsed = content ? JSON.parse(content) : {}; }
      catch (e){ throw new Error('refusing to overwrite: gist parse failed'); }  // never treat as empty
      var h = g.history || [];
      return { ok: true, etag: etag, version: h[0] && h[0].version, body: P.migrate(parsed) };
    }
    return async function(kind, opts){
      if (kind === 'GET') return readAt('/gists/' + gid);
      if (kind === 'GET_REV') return readAt('/gists/' + gid + '/' + opts.version);   // a past revision
      var files = {}; files[FILE] = { content: JSON.stringify(P.serialize(opts.body)) };
      var r2 = await api('PATCH', '/gists/' + gid, { files: files });
      if (!r2.ok) return { ok: false, status: r2.status };
      var g2 = await r2.json(); var h2 = g2.history || [];
      return { ok: true, status: r2.status, etag: r2.headers.get('ETag'),
               version: h2[0] && h2[0].version,      // the commit we just made
               parent:  h2[1] && h2[1].version,      // ...and what it landed on top of
               body: opts.body };
    };
  }
  function dropGid(){ try { localStorage.removeItem(K.gid); } catch (e){} }
  function resolveGid(force){ if (force) dropGid(); return findGist(); }
  function engine(){ return P.makeSyncEngine({ resolve: resolveGid, makeReq: makeRequest }); }

  var flushing = false, dirtyAgain = false, timer = null, timerAt=0, retryAt=0, retryFailures=0;
  async function legacyFlush(){
    if (!token()) return { ok: false, reason: 'no-token' };
    if (!navigator.onLine) return { ok: false, reason: 'offline' };
    if (flushing){ dirtyAgain = true; return { ok: false, reason: 'busy' }; }
    flushing = true;
    try {
      var pending = readJSON(K.ops, []);
      if (!pending.length) return { ok: true, count: favCount(), pushed: 0 };
      var out = await engine().push(pending);              // self-heals a stale gid on 404
      var remaining=readJSON(K.ops,[]).filter(function(o){return !pending.some(function(p){return JSON.stringify(p)===JSON.stringify(o);});});
      setState(cleanState(P.applyOps(out.state,remaining))); persist(); writeJSON(K.ops, remaining); ops = remaining;
      lastErr = false; fireChange();
      return { ok: true, count: favCount(), pushed: pending.length };
    } catch (e){                                            // keep ops queued; retry on next trigger
      if (e && e.status) lastErr = true;
      fireChange();
      return { ok: false, status: e && e.status, error: String((e && e.message) || e) };
    } finally { flushing = false; if (dirtyAgain){ dirtyAgain = false; scheduleFlush(); } }
  }
  function scheduleFlush(){
    var now=Date.now(),at=Math.max(now+1200,retryAt);
    if(timer&&timerAt<=at)return;
    if(timer)clearTimeout(timer);timerAt=at;
    timer=setTimeout(function(){timer=null;timerAt=0;doFlush({automatic:true});},Math.max(0,at-now));
  }
  function retryLater(response){
    retryFailures++;var delay=Math.min(60000,1000*Math.pow(2,Math.min(retryFailures,6)));
    var header=response&&response.headers&&response.headers.get('Retry-After'),serverDelay=0;
    if(header){var seconds=Number(header);serverDelay=Number.isFinite(seconds)?seconds*1000:Date.parse(header)-Date.now();}
    retryAt=Date.now()+Math.max(delay+Math.floor(Math.random()*Math.min(1000,delay*.2)),serverDelay||0);
    if(timer){clearTimeout(timer);timer=null;}scheduleFlush();
  }
  async function legacyPull(){
    if (!token()) return { ok: false, reason: 'no-token' };
    if (!navigator.onLine) return { ok: false, reason: 'offline' };
    try {
      var r = await engine().pull();                        // self-heals a stale gid on 404
      setState(cleanState(P.applyOps(r.body, readJSON(K.ops, []))));     // gist truth + our un-pushed ops
      persist(); lastErr = false; fireChange();
      if (ops.length) scheduleFlush();
      return { ok: true, count: favCount() };
    } catch (e){ if (e && e.status) lastErr = true; fireChange(); return { ok: false, status: e && e.status, error: String((e && e.message) || e) }; }
  }

  // ---------- account API: verified identity, durable queue and canonical deltas ----------
  async function detectBackend(){
    if(available)return true;
    try {var r=await fetch('/api/account/config',{credentials:'same-origin',cache:'no-store'});
      if(r.ok){var cfg=await r.json();available=!!(cfg&&typeof cfg.passkeysEnabled==='boolean'&&typeof cfg.emailEnabled==='boolean');}
    } catch(e){}
    if(!available && owner)lastErr=true;
    return available;
  }
  async function refreshSession(){
    if(!await detectBackend()) return user;
    var marker=readJSON(activeKey,null);
    try {
      var r = await fetch('/api/auth/get-session',{credentials:'same-origin',cache:'no-store'});
      if(!r.ok) throw new Error('session unavailable');
      var session = await r.json();
      if(session!==null && (!session || !session.user || !session.session))throw new Error('invalid session');
      var next = session && session.user;
      if(next && (typeof next.id!=='string'||!next.id)) throw new Error('invalid session');
      await durable;
      var currentMarker=readJSON(activeKey,null),verifiedOwner=next&&next.id;
      if(currentMarker!==marker && currentMarker!==verifiedOwner){lastErr=true;fireChange();return user;}
      user = next ? {id:next.id,email:next.email||''} : null;
      var nextOwner=user&&user.id;
      if(owner!==nextOwner){setState(AP.empty());ops=[];hydrated=!nextOwner;}
      owner=nextOwner;optimistic=[];
      writeJSON('langstudy:identity',user);writeJSON(activeKey,owner);
      if(owner){useDoc(owner,await transaction(owner));}
      else {setState(guestState());ops=readJSON(K.ops,[]);}
      lastErr=false;fireChange();return user;
    } catch(e){ lastErr=true;fireChange();return user; } // offline keeps cached identity
  }
  // Only call after a successful server sign-out; an ordinary failed session
  // lookup must keep the cached offline identity instead.
  async function clearSession(){
    await durable;user=null;owner=null;hydrated=true;optimistic=[];
    writeJSON('langstudy:identity',null);writeJSON(activeKey,null);
    setState(guestState());ops=readJSON(K.ops,[]);lastErr=false;fireChange();return null;
  }
  function guestState(){
    var maps={items:readJSON(K.store,{})};NS.forEach(function(ns){if(ns!=='items')maps[ns]=readJSON(K[ns],{});});return cleanState(maps);
  }
  function result(ok,reason,status){return {ok:ok,reason:reason||'',status:status||storeStatus()};}
  function pendingCount(){return owner?new Set(ops.concat(optimistic).filter(function(o){return !o.acked;}).map(function(o){return o.id;})).size:readJSON(K.ops,[]).length;}
  function storeStatus(){
    if((owner||token()) && navigator.onLine===false)return 'offline';
    if(!active()||storageFailed||lastErr)return 'err';
    if(owner)return pendingCount()?'wait':'ok';
    if(available)return 'off';
    return P.syncStatus({hasToken:!!token(),lastErr:lastErr,pending:pendingCount()});
  }
  async function doFlush(options){
    if(!available && (owner||accountOrigin)){if(await detectBackend())await refreshSession();}
    if(!available){ if(owner||accountOrigin)return result(false,'backend-unavailable');return legacyFlush(); }
    if(!owner)return result(false,'signed-out');
    if(!active())return result(false,'account-changed');
    if(navigator.onLine===false)return result(false,'offline');
    if(options&&options.automatic&&Date.now()<retryAt){scheduleFlush();return result(false,'backoff');}
    if(flushing){dirtyAgain=true;return result(false,'busy');}
    flushing=true;var id=owner;
    if(timer){clearTimeout(timer);timer=null;timerAt=0;}
    try{
      if(navigator.locks&&navigator.locks.request)return await navigator.locks.request('langstudy:sync:'+id,{ifAvailable:true},function(lock){if(lock)return flushAccount(id);scheduleFlush();return result(false,'busy');});
      return await flushAccount(id);
    }catch(e){lastErr=true;retryLater();fireChange();return result(false,'network-error');
    }finally{flushing=false;if(dirtyAgain){dirtyAgain=false;scheduleFlush();}}
  }
  async function flushAccount(id){
    try {
      await durable;if(storageFailed)return result(false,'storage-unavailable');
      var doc=await transaction(id,function(current){current.ops=AP.compactPositions(current.ops);return current;}), snapshot=new Set(doc.ops.map(function(o){return o.id;})), sent=AP.outbound(doc.ops), pages=0, more, remaining;
      // Only this snapshot's immutable IDs can be acknowledged; later writes survive.
      do {
        if(owner!==id||!active())return result(false,'account-changed');
        // A durable intent precedes fetch, including a lost/failed response.
        // Re-read atomically: a newer assignment can supersede a selected write
        // before its dispatch; only IDs still present may leave this outbox.
        var selected=new Set(sent.map(function(o){return o.id;}));
        if(selected.size){
          doc=await transaction(id,function(latest){latest.ops.forEach(function(o){if(selected.has(o.id)&&!o.acked)o.attempted=true;});return latest;});
          sent=AP.outbound(doc.ops.filter(function(o){return selected.has(o.id)&&!o.acked;}));
        }
        var covered=doc.ops.filter(function(o){return o.acked;}).map(function(o){return o.id;});
        var r=await fetch('/api/study/sync',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-Study-Owner':id},body:JSON.stringify({cursor:doc.cursor,ops:sent})});
        if(!r.ok){lastErr=true;if(r.status===429||r.status>=500)retryLater(r);fireChange();return result(false,r.status===409?'account-changed':'server-error',r.status);}
        var reply=await r.json();
        if(!Number.isSafeInteger(reply.cursor)||reply.cursor<0||!Array.isArray(reply.changes)||!Array.isArray(reply.acked))throw new Error('invalid sync reply');
        reply.changes=reply.changes.map(function(c){var x=AP.clone(c);if(!x.deleted&&x.value!==undefined)x.value=cleanValue(x.ns,x.value);return x;});
        doc=await transaction(id,function(latest){return AP.applyReply(latest,reply,sent,covered);});
        if(owner!==id||!active())return result(false,'account-changed');
        useDoc(id,doc);more=reply.more;remaining=doc.ops.filter(function(o){return snapshot.has(o.id);});
        if(sent.length && !reply.acked.some(function(ack){return sent.some(function(o){return o.id===ack;});}))throw new Error('sync did not acknowledge operations');
        sent=more?[]:AP.outbound(remaining);pages++;
        if(pages>1000)throw new Error('too many sync pages');
      } while(more||sent.length);
      retryAt=0;retryFailures=0;lastErr=false;fireChange();if(doc.ops.length)scheduleFlush();return result(true);
    } catch(e){lastErr=true;retryLater();fireChange();return result(false,'network-error');}
  }
  async function pullOnLoad(){return available||owner||accountOrigin?doFlush():legacyPull();}
  async function importState(data){
    if(!data||typeof data!=='object'||Array.isArray(data))throw new Error('invalid backup');
    if(!active())throw new Error('account changed');
    var x=P.migrate(data),incoming=AP.empty(),count=0;
    // Validate and sanitize every record before queuing any part of a backup.
    NS.forEach(function(ns){
      if(!x[ns]||typeof x[ns]!=='object'||Array.isArray(x[ns]))throw new Error('invalid namespace');
      Object.keys(x[ns]).forEach(function(k){
        if(!AP.valid({ns:ns,key:k,op:'import',value:x[ns][k]}))throw new Error('invalid backup record: '+ns);
        incoming[ns][k]=cleanValue(ns,x[ns][k]);
      });
    });
    batch(function(){NS.forEach(function(ns){Object.keys(incoming[ns]).forEach(function(k){
      if(!Object.prototype.hasOwnProperty.call(state[ns],k)&&setKey(ns,k,incoming[ns][k],{import:true}))count++;
    });});});
    await durable;return {ok:!storageFailed,count:count};
  }
  async function importGuest(){return importState(P.serialize(P.applyOps(guestState(),readJSON(K.ops,[]))));}
  async function importGist(tok){
    var t=tok||token();if(!t)throw new Error('GitHub token required for import');
    async function read(path){var r=await fetch('https://api.github.com'+path,{headers:{Authorization:'Bearer '+t,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'}});if(!r.ok)throw new Error('GitHub import failed ('+r.status+')');return r.json();}
    var hit=null;
    for(var page=1;page<=100&&!hit;page++){
      var list=await read('/gists?per_page=100&page='+page);
      hit=list.filter(function(g){return g.files&&g.files[FILE];})[0];if(list.length<100)break;
    }
    if(!hit)throw new Error('No lang-favorites.json backup found');
    var gist=await read('/gists/'+encodeURIComponent(hit.id)),file=gist.files&&gist.files[FILE];
    if(!file)throw new Error('Gist backup missing');
    var text=file.content;
    if(file.truncated){
      var url=new URL(file.raw_url);if(url.protocol!=='https:'||url.hostname!=='gist.githubusercontent.com')throw new Error('Invalid Gist backup URL');
      var raw=await fetch(url.href);if(!raw.ok)throw new Error('Gist backup unavailable');text=await raw.text();
    }
    return importState(JSON.parse(text)); // read only: never creates or patches a Gist
  }
  async function initialize(){
    if(owner){try{useDoc(owner,await transaction(owner));fireChange();}catch(e){storageFailed=true;fireChange();}}
    await detectBackend();
    if(available){await refreshSession();if(owner)await doFlush();}
    else if(!owner&&!accountOrigin)await legacyPull();
  }

  // ---------- capture UI (study pages only: where .u cards exist) ----------
  var cards = [].slice.call(document.querySelectorAll('.u'));
  var IDS = [], filterBtn = null, favEmpty = null;
  // The chain itself is P.pageKey (pure core, duplicated verbatim from page_tools.js). This wrapper
  // is ONLY the DOM read — keep it that way: the two modules diverged precisely because each owned
  // its own copy of the ordering.
  function pageYt(){
    var el = document.getElementById('clip'); if (!el) return '';
    return P.pageKey({ youtube:  el.getAttribute('data-youtube-id'),
                       video:    el.getAttribute('data-video-id'),
                       episode:  el.getAttribute('data-episode-id'),
                       bilibili: el.getAttribute('data-bilibili-id'),
                       page:     el.getAttribute('data-bilibili-page'),
                       src:      el.getAttribute('src') });
  }
  function cnText(card){
    var el = card.querySelector('.u-cn'); if (!el) return '';
    var c = el.cloneNode(true); var lbl = c.querySelector('.lbl'); if (lbl) lbl.remove();
    return c.textContent.trim();
  }
  function pointsOf(card){
    return [].slice.call(card.querySelectorAll('.u-points li')).map(function(li){
      var chip = li.querySelector('.chip');
      var cat = chip ? ([].slice.call(chip.classList).filter(function(x){ return x !== 'chip' && x !== 'star'; })[0] || '') : '';
      return { cat: cat, term: chip ? P.stripStar(chip.textContent) : '', note: li.children[1] ? li.children[1].textContent.trim() : '' };
    });
  }
  function recordFor(card, id){
    var jp = card.querySelector('.u-jp'), ts = card.querySelector('.ts');
    var sec = ts ? P.tsToSec(ts.textContent) : 0;
    return { id: id, yt: pageYt(), page: (location.pathname.split('/').pop() || ''), mmss: P.secToMmss(sec), sec: sec,
             jp_html: jp ? jp.innerHTML : '', cn: cnText(card), points: pointsOf(card),
             page_title: (document.title || ''), added_at: Date.now() };
  }
  function favCount(){ return Object.keys(favs).length; }
  function reflect(){
    if (!cards.length) return;
    cards.forEach(function(card, i){
      var on = !!favs[IDS[i]], b = card.querySelector('.fav-btn');
      if(card.classList.contains('faved')!==on)card.classList.toggle('faved', on);
      if(b&&b.getAttribute('aria-pressed')!==String(on))b.setAttribute('aria-pressed',String(on));
    });
    var label='只看收藏 ('+favCount()+')';if(filterBtn&&filterBtn.textContent!==label)filterBtn.textContent=label;
    var empty=!(document.body.classList.contains('fav-only')&&favCount()===0);if(favEmpty&&favEmpty.hidden!==empty)favEmpty.hidden=empty;
  }
  if (cards.length){
    var YT = pageYt();
    var IDS0 = P.assignFavIds(YT, cards.map(function(c){ var t = c.querySelector('.ts'); return t ? t.textContent : ''; }));
    IDS = IDS0;
    var BOOKMARK = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">' +
      '<path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z"/></svg>';
    cards.forEach(function(card, i){
      var id = IDS[i]; card.dataset.favId = id;
      var meta = card.querySelector('.u-meta') || card;
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'fav-btn'; b.setAttribute('aria-label', '收藏这句'); b.title = '收藏这句';
      b.innerHTML = BOOKMARK;
      b.addEventListener('click', function(){ favs[id] ? removeFav(id) : addFav(recordFor(card, id)); });
      meta.appendChild(b);
    });
    filterBtn = document.createElement('button');
    filterBtn.id = 'favFilter'; filterBtn.type = 'button'; filterBtn.setAttribute('aria-pressed', 'false');
    filterBtn.addEventListener('click', function(){
      var on = document.body.classList.toggle('fav-only');
      filterBtn.setAttribute('aria-pressed', on ? 'true' : 'false'); reflect();
    });
    var furiBar = document.querySelector('.furi-bar'); if (furiBar) furiBar.appendChild(filterBtn);
    favEmpty = document.createElement('p'); favEmpty.id = 'favEmpty'; favEmpty.hidden = true;
    favEmpty.textContent = '还没有收藏。点句子的书签图标即可收藏，稍后在收藏页复习。';
    var anchor = document.querySelector('.legend') || furiBar;
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(favEmpty, anchor);
    reflect();
    var gotoHash = function(){
      var m = (location.hash || '').match(/fav=([^&]+)/); if (!m) return;
      var id = decodeURIComponent(m[1]);
      var card = document.querySelector('.u[data-fav-id="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
      if (!card) return;
      card.scrollIntoView({ block: 'center', behavior: 'smooth' });
      card.classList.remove('fav-jump'); void card.offsetWidth; card.classList.add('fav-jump');
    };
    window.addEventListener('hashchange', gotoHash);
    if (/fav=/.test(location.hash || '')) setTimeout(gotoHash, 300);
  }

  // ---------- triggers: pull on load, push eagerly before backgrounding ----------
  window.addEventListener('online', function(){retryAt=0;retryFailures=0;scheduleFlush();});
  document.addEventListener('visibilitychange', function(){ if (document.hidden) doFlush({automatic:true}); });
  window.addEventListener('pagehide', function(){ doFlush({automatic:true}); });
  window.addEventListener('storage',function(e){
    if(e.key===activeKey){fireChange();return;}
    if(owner && active() && (e.key==='langstudy:changed'||(e.key&&e.key.indexOf(prefix(owner))===0))){
      var id=owner;durable=durable.then(function(){return transaction(id);}).then(function(doc){useDoc(id,doc);fireChange();}).catch(function(){lastErr=true;});
    }
  });
  document.addEventListener('visibilitychange',function(){if(!document.hidden && active()){refreshSession().then(function(){return doFlush({automatic:true});});}});

  // Optional host acknowledgement. Existing commands remain optimistic; this
  // barrier observes their real durable chain without inventing another store.
  async function whenDurable(){
    var id=owner;await durable;
    if(owner!==id||!active())throw new Error('account-changed');
    if(id){if(storageFailed)throw new Error('study storage unavailable');return;}
    // Legacy guest persistence historically swallows quota errors. Recommit and
    // read back every authoritative map and queue before a host closes an editor.
    persist();writeJSON(K.ops,ops);
    for(var i=0;i<NS.length;i++){
      var ns=NS[i],key=ns==='items'?K.store:K[ns];
      if(JSON.stringify(readJSON(key,null))!==JSON.stringify(state[ns]))throw new Error('study storage unavailable');
    }
    if(JSON.stringify(readJSON(K.ops,null))!==JSON.stringify(ops))throw new Error('study storage unavailable');
  }

  // ---------- public surface ----------
  window.LangFav = {
    whenDurable: whenDurable,
    all: function(){ return favs; },
    count: favCount,
    status: storeStatus, pendingCount: pendingCount,
    account: function(){return user;}, isCurrentOwner: active, hydrated: function(){return !owner||hydrated;}, backendAvailable: function(){return available;},
    refreshSession: refreshSession, clearSession: clearSession, importGuest: importGuest, importState: importState, importGist: importGist,
    exportState: function(){return AP.clone(P.serialize(state));}, review: review,
    remove: removeFav,
    add: addFav,
    getNS: getNS, setKey: setKey, delKey: delKey, batch: batch, stampToday: stampToday,
    setToken: function(t){ try { t ? localStorage.setItem(K.tok, t) : localStorage.removeItem(K.tok); } catch (e){} lastErr = false; fireChange(); },
    hasToken: function(){ return !!token(); },
    forgetGist: function(){ try { localStorage.removeItem(K.gid); } catch (e){} },
    sync: doFlush, pull: pullOnLoad, pure: P,
    onChange: function(fn){ if (typeof fn === 'function') changeHooks.push(fn); }
  };
  window.LangFav.ready = initialize();
})();
