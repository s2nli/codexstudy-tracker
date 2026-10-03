






if ('serviceWorker' in navigator) {
  let _swReloadingAlready = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (_swReloadingAlready) return; 
    _swReloadingAlready = true;
    window.location.reload();
  });
  
  
  navigator.serviceWorker.getRegistration().then(reg => {
    if (!reg) return;
    reg.update().catch(()=>{});
    setInterval(() => reg.update().catch(()=>{}), 60 * 60 * 1000); 
  }).catch(()=>{});
}

let SUPABASE_URL = null;
let SUPABASE_ANON_KEY = null;
let TURNSTILE_SITE_KEY = null;

let sb = null;
let currentUser = null;
let isSaving = false;
let saveQueue = false;
let _appInitialized = false; 

function _shouldShowOnboarding(userId, profileStatus) {
  if (profileStatus === 'error' || profileStatus === 'no_client') return false; 
  if (window.userProfile.onboarding_done) return false;  
  return true;                                     
}

function _withTimeout(promise, ms, label){
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error((label || 'Request') + ' timed out')), ms))
  ]);
}

// ── Online/offline banner ──
// Reassures the user their work isn't lost (save() always writes to
// localStorage first, regardless of network — see save()), and pushes any
// pending changes the moment the connection comes back, since _syncToServer
// only fires from save()/flushSave() and wouldn't otherwise retry on its own
// after a failed attempt until the user edits something again.
let _backOnlineHideTimer = null;
function _updateNetworkBanner(isOnline){
  const el = document.getElementById('network-banner');
  if(!el) return;
  clearTimeout(_backOnlineHideTimer);
  if(!isOnline){
    el.className = 'show offline';
    el.textContent = "You're offline — your progress is saved on this device and will sync once you're back online.";
  } else {
    el.className = 'show online';
    el.textContent = "Back online — syncing your data\u2026";
    if(sb && currentUser && typeof flushSave === 'function') flushSave();
    _backOnlineHideTimer = setTimeout(() => { el.className = ''; }, 3000);
  }
}
window.addEventListener('online', () => _updateNetworkBanner(true));
window.addEventListener('offline', () => _updateNetworkBanner(false));
if(!navigator.onLine) _updateNetworkBanner(false);

// Everything needed to render the authenticated dashboard (nav, all
// .page renderers, sync engine, settings, onboarding, badges, feedback —
// formerly a static <script src="dashboard-controller.js"> tag plus the
// full app.js bundle, loaded unconditionally on every single page view)
// now lives in one lazy-loaded file, fetched only once we actually know
// the visitor has a session. A landing-page visit that never logs in
// never downloads or parses any of it. loadScript() is the small helper
// already defined in index.html (used for Chart.js/jsPDF) — same
// dedupe-via-querySelector behavior, so calling this twice in one
// session (e.g. sign out then back in) is safe.
let _dashboardBundleLoaded = false;
let _dashboardBundlePromise = null;
function loadDashboardBundle() {
  if (_dashboardBundleLoaded) return Promise.resolve();
  if (_dashboardBundlePromise) return _dashboardBundlePromise; // already in flight — share it, don't double-inject
  _dashboardBundlePromise = loadScript('/dashboard-bundle.generated.js').then(() => {
    _dashboardBundleLoaded = true;
  });
  return _dashboardBundlePromise;
}

// LOGIN REMOVED: the app no longer shows a login/signup screen and no longer
// talks to Supabase Auth. It boots straight into the dashboard and keeps all
// data in this browser's localStorage (save() already always wrote there).
// The name initSupabase is kept only because the DOMContentLoaded handler
// below calls it.
async function initSupabase(){
  sb = null;
  currentUser = null;
  _appInitialized = true;
  if(window.jtSplash) window.jtSplash.setProgress(55, 'Loading your data');
  try {
    await loadDashboardBundle();
    await loadUserData();                       // localStorage only (no sb/currentUser)
    const profileStatus = await loadUserProfile(); // localStorage only
    if(window.jtSplash) window.jtSplash.setProgress(90, 'Almost ready');
    if(_shouldShowOnboarding(null, profileStatus)){
      hideSplash();
      document.getElementById('landing')?.classList.add('hidden');
      showOnboarding();
    } else {
      showApp(window.userProfile.username || 'Aspirant', '');
    }
  } catch(err){
    console.warn('Failed to start app', err);
    _appInitialized = false;
    hideSplash();
    showConfigError('Couldn\u2019t load the app. Check your connection and try again.');
  }
}

let authTab = 'login';
let _authSlideAnimating = false;

// ── Turnstile (CAPTCHA) ──
// Rendered lazily the first time the auth modal opens (landingOpenAuth),
// not on page load — no reason to spend a challenge on someone who never
// clicks Sign In. Silently does nothing if TURNSTILE_SITE_KEY isn't
// configured yet (see /api/config), so shipping this doesn't require the
// env var to be set first — same optional-feature pattern as PostHog.
let _turnstileWidgetIds = { login: null, signup: null };
let _turnstileTokens = { login: null, signup: null };
let _turnstileRenderAttempts = 0;

function _renderTurnstileWidgets(){
  if(!TURNSTILE_SITE_KEY) return;
  if(typeof window.turnstile === 'undefined'){
    // The script tag is async — on a slow connection it may not have
    // finished loading yet by the time the modal first opens.
    if(_turnstileRenderAttempts++ < 20) setTimeout(_renderTurnstileWidgets, 250);
    return;
  }
  ['login','signup'].forEach(mode => {
    if(_turnstileWidgetIds[mode] !== null) return; 
    const el = document.getElementById('turnstile-' + mode);
    if(!el) return;
    _turnstileWidgetIds[mode] = window.turnstile.render(el, {
      sitekey: TURNSTILE_SITE_KEY,
      theme: 'dark',
      callback: (token) => { _turnstileTokens[mode] = token; },
      'expired-callback': () => { _turnstileTokens[mode] = null; },
      'error-callback': () => { _turnstileTokens[mode] = null; },
    });
  });
}

function _resetTurnstile(mode){
  _turnstileTokens[mode] = null;
  if(TURNSTILE_SITE_KEY && typeof window.turnstile !== 'undefined' && _turnstileWidgetIds[mode] !== null){
    try { window.turnstile.reset(_turnstileWidgetIds[mode]); } catch(e) {}
  }
}

// ── Client-side login attempt backoff ──
// Cosmetic/UX layer only — Supabase Auth (and now Turnstile) are the real
// enforcement. This just stops someone from mashing the Sign In button and
// gives a clear "wait a bit" message instead of a wall of server errors.
// Resets on page reload by design; not meant to survive a refresh.
const _loginAttemptState = {}; // email(lowercased) -> { count, blockedUntil }
const LOGIN_ATTEMPT_LIMIT = 5;
const LOGIN_ATTEMPT_COOLDOWN_MS = 60 * 1000;

function _checkLoginBackoff(email){
  const rec = _loginAttemptState[email];
  if(!rec || !rec.blockedUntil) return { blocked: false };
  const remainingMs = rec.blockedUntil - Date.now();
  if(remainingMs <= 0){ delete _loginAttemptState[email]; return { blocked: false }; }
  return { blocked: true, remainingSec: Math.ceil(remainingMs / 1000) };
}

function _recordLoginFailure(email){
  const rec = _loginAttemptState[email] || { count: 0, blockedUntil: null };
  rec.count++;
  if(rec.count >= LOGIN_ATTEMPT_LIMIT){
    rec.blockedUntil = Date.now() + LOGIN_ATTEMPT_COOLDOWN_MS;
    rec.count = 0; 
  }
  _loginAttemptState[email] = rec;
}

function _clearLoginFailures(email){ delete _loginAttemptState[email]; }


