// MBM Life — service worker (v565, closes the "served without consent" gap)
//
// PURPOSE: a new worker CAN activate without SKIP_WAITING once all clients
// of the OLD worker are closed — standard spec behavior, cannot be
// suppressed from inside a worker script. So activation alone must NEVER
// change what content is served. The version the USER EXPLICITLY ACCEPTED
// is tracked in IndexedDB, and — as of v565 — its actual BYTES live in one
// FIXED-NAME cache bucket (ACCEPTED_SHELL_CACHE, never a versioned name).
//
// v564 BUG (found by Bahman, confirmed by re-reading this file): serving
// was keyed to `caches.open(accepted || CACHE_NAME)` where `accepted` was a
// VERSIONED cache name read from IndexedDB. If that exact named cache was
// missing the requested entry for ANY reason (Cache Storage eviction under
// browser storage pressure, a naming skew across app updates, or any other
// gap between IndexedDB's record and what Cache Storage actually still
// holds) AND this worker was not itself the accepted version, the code fell
// through to a raw fetch(req) — a live network request that returns
// whatever is CURRENTLY deployed, i.e. exactly the unaccepted content the
// whole mechanism exists to withhold. The code's own comment called this
// "fail closed"; it was actually fail-OPEN — a network fetch is not a
// safe fallback here, it is the one response that must never be served
// without explicit consent.
//
// v565 FIX: stop keying storage to a versioned name at all. ONE fixed
// cache bucket (ACCEPTED_SHELL_CACHE) holds whatever content the user has
// actually accepted, full stop — it is written in exactly two places: (a)
// the SKIP_WAITING handler, in direct response to the user's own "Update
// now" tap, and (b) a true first-ever load, when nothing has been accepted
// yet (self-heal, not an upgrade — there is nothing to protect the user
// FROM on a first load). If a fetch ever finds this bucket missing the
// entry for any other reason, it now falls back to THIS WORKER'S OWN
// already-installed cache (CACHE_NAME, populated entirely at install time,
// before any user interaction) instead of the network — worst case the
// user sees their own currently-controlling worker's shell again, never a
// silently-newer one.
//
// SCOPE: only ever intercepts the app shell itself (navigation requests
// and the root/index.html document). Firebase/Firestore, Google Maps,
// Nominatim, and every other network request pass straight through
// untouched — this file has no way to interfere with Family sync or any
// other live data.

const CACHE_NAME = 'mbm-life-shell-v591'; // this worker's OWN version identity — bump together with APP_VERSION every release
const ACCEPTED_SHELL_CACHE = 'mbm-life-accepted-shell'; // v565: fixed name, NEVER versioned — see header
const SHELL_URLS = ['./', './index.html'];
const DB_NAME = 'mbm-life-sw-meta';
const STORE_NAME = 'meta';
const ACCEPTED_KEY = 'acceptedVersion';

function openMetaDB(){
  return new Promise((resolve,reject)=>{
    const req=indexedDB.open(DB_NAME,1);
    req.onupgradeneeded=()=>{ req.result.createObjectStore(STORE_NAME); };
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });
}
async function getAcceptedVersion(){
  try{
    const db=await openMetaDB();
    return await new Promise((resolve,reject)=>{
      const tx=db.transaction(STORE_NAME,'readonly');
      const req=tx.objectStore(STORE_NAME).get(ACCEPTED_KEY);
      req.onsuccess=()=>resolve(req.result||null);
      req.onerror=()=>reject(req.error);
    });
  }catch(e){ return null; }
}
async function setAcceptedVersion(v){
  const db=await openMetaDB();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(STORE_NAME,'readwrite');
    tx.objectStore(STORE_NAME).put(v,ACCEPTED_KEY);
    tx.oncomplete=()=>resolve();
    tx.onerror=()=>reject(tx.error);
  });
}
// v565: copy this worker's own already-cached shell into the fixed
// ACCEPTED_SHELL_CACHE bucket. Used in exactly two places (see header) —
// never called just because a worker happened to activate.
async function acceptOwnShell(){
  const own=await caches.open(CACHE_NAME);
  const accepted=await caches.open(ACCEPTED_SHELL_CACHE);
  await Promise.all(SHELL_URLS.map(async(url)=>{
    const res=await own.match(url);
    if(res) await accepted.put(url,res.clone());
  }));
}

self.addEventListener('install',(event)=>{
  // Deliberately NO self.skipWaiting() call here — a newly-installed
  // worker sits in 'waiting' until explicitly told to take over.
  event.waitUntil((async()=>{
    const cache=await caches.open(CACHE_NAME);
    await Promise.all(SHELL_URLS.map((url)=>
      fetch(url,{cache:'reload'}).then((res)=>{ if(res&&res.ok) return cache.put(url,res); }).catch(()=>{})
    ));
    // Only a TRUE first-ever install (no accepted version recorded at
    // all yet) self-heals the accepted-shell bucket from its own fetch —
    // this is NOT an unauthorized upgrade, there is nothing accepted yet
    // to protect the user from. Any later install must NOT touch
    // ACCEPTED_SHELL_CACHE just by existing.
    const accepted=await getAcceptedVersion();
    if(!accepted){
      try{ await setAcceptedVersion(CACHE_NAME); await acceptOwnShell(); }catch(e){}
    }
  })());
});

self.addEventListener('activate',(event)=>{
  event.waitUntil((async()=>{
    await self.clients.claim();
    // v565: only two caches are ever worth keeping now — the fixed
    // ACCEPTED_SHELL_CACHE (whatever the user actually accepted) and this
    // worker's OWN versioned cache (its install-time snapshot, used only
    // as a same-worker fallback, see fetch handler below). No other named
    // cache can ever be the "accepted" one anymore, so there is nothing
    // else to protect by name — simpler and no longer dependent on
    // IndexedDB's record staying in sync with Cache Storage's actual keys.
    const keep=new Set([ACCEPTED_SHELL_CACHE, CACHE_NAME]);
    const names=await caches.keys();
    await Promise.all(names.filter((n)=>!keep.has(n)).map((n)=>caches.delete(n)));
  })());
});

// The ONLY way a waiting worker's version is ever accepted: an explicit
// message from the page, sent exactly when the user taps "Update now".
self.addEventListener('message',(event)=>{
  if(event.data && event.data.type==='SKIP_WAITING'){
    event.waitUntil((async()=>{
      try{ await acceptOwnShell(); await setAcceptedVersion(CACHE_NAME); }catch(e){}
      self.skipWaiting();
    })());
  }
});

function isShellRequest(request){
  if(request.mode==='navigate') return true;
  try{
    const url=new URL(request.url);
    if(url.origin!==self.location.origin) return false; // never touch cross-origin (Firebase/Maps/Nominatim/etc.)
    // v570-2 (Bahman, real report — new index.html uploaded, app never
    // offered the update): a request carrying a query string is the
    // update-check's own cache-busted fetch (fetchRemoteVersion), never a
    // real navigation — real navigations to '/' or '/index.html' don't
    // carry one. That fetch exists specifically to see the TRUE current
    // server content, so it must never be intercepted and answered from
    // the cached shell (which is exactly what {ignoreSearch:true} below
    // was doing to it) — excluded here, it now reaches the network like
    // any other honest fetch.
    if(url.search) return false;
    return url.pathname==='/' || url.pathname.endsWith('/index.html');
  }catch(e){ return false; }
}

self.addEventListener('fetch',(event)=>{
  const req=event.request;
  if(req.method!=='GET' || !isShellRequest(req)) return; // let the browser handle everything else normally

  event.respondWith((async()=>{
    // v565: always read/write the ONE fixed accepted-shell bucket — never
    // a versioned name. A cache-busted request (fetchRemoteVersion's own
    // update-check fetch, which deliberately appends a random query string
    // to defeat HTTP caching) still matches here because {ignoreSearch:true}
    // explicitly ignores the query string for this lookup — that fetch only
    // ever reads a version string out of the response text; it must never
    // be treated as "the accepted content changed".
    const acceptedCache=await caches.open(ACCEPTED_SHELL_CACHE);
    const acceptedHit=await acceptedCache.match(req,{ignoreSearch:true});
    if(acceptedHit) return acceptedHit;

    const accepted=await getAcceptedVersion();
    if(!accepted || accepted===CACHE_NAME){
      // We ARE the accepted version (or nothing has ever been accepted —
      // true first load) and the fixed bucket somehow doesn't have this
      // entry yet. Fetch it once, serve it, and self-heal the bucket so
      // this doesn't repeat.
      try{
        const res=await fetch(req);
        if(res && res.ok){
          const copy=res.clone();
          acceptedCache.put(req,copy).catch(()=>{});
        }
        return res;
      }catch(e){
        const own=await caches.open(CACHE_NAME);
        return (await own.match('./index.html')) || Response.error();
      }
    }
    // We are NOT the accepted version, and the accepted-shell bucket is
    // missing this entry — this should be rare now (it's only written by
    // acceptOwnShell(), never left to skew), but if it ever happens, the
    // ONLY safe fallback is THIS WORKER'S OWN cache, populated entirely at
    // install time before any user interaction — never a fresh network
    // fetch, which would silently serve unaccepted content again (the
    // exact v564 bug).
    const own=await caches.open(CACHE_NAME);
    const ownHit=await own.match(req,{ignoreSearch:true});
    if(ownHit) return ownHit;
    return (await own.match('./index.html')) || Response.error();
  })());
});
