/* =========================================================================
   Dashboard v3 – Client-Shell & Router (Issue v3-A)
   - Echtes Multi-Page innerhalb der SPA-Shell
   - History-API mit Hash-Fallback
   - Jede Route lädt ihre Daten beim Öffnen (hier Grundgerüst-Platzhalter)
   - Einheitliche Lade-/Leer-/Fehlerzustände als wiederverwendbare Komponente
   ========================================================================= */
(function () {
  'use strict';

  var BASE = '/v3';

  /* ---- Icons (schlanke Inline-SVGs, framework-frei) --------------------- */
  function icon(paths) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';
  }
  var ICONS = {
    heute:        icon('<path d="M3 12l9-8 9 8"/><path d="M5 10v9h14v-9"/><path d="M9 19v-5h6v5"/>'),
    guv:          icon('<path d="M4 19V5"/><path d="M4 19h16"/><path d="M7 15l4-5 3 3 4-6"/>'),
    lager:        icon('<path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4"/><path d="M12 11v10"/>'),
    slots:        icon('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>'),
    monitoring:   icon('<path d="M3 12h4l2 6 4-14 2 8h6"/>'),
    onboarding:   icon('<circle cx="9" cy="8" r="3.2"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0"/><path d="M18 7v6"/><path d="M15 10h6"/>'),
    automaten:    icon('<rect x="5" y="2.5" width="14" height="19" rx="2"/><path d="M8.5 6h3"/><path d="M8.5 9.5h3"/><path d="M8.5 13h3"/><circle cx="16" cy="17.5" r="1"/>'),
    einstellungen:icon('<circle cx="12" cy="12" r="3"/><path d="M19.4 12a7.4 7.4 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7.3 7.3 0 0 0-2-1.2l-.3-2.5H9.3L9 3.7a7.3 7.3 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.5a7.4 7.4 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-1a7.3 7.3 0 0 0 2 1.2l.3 2.5h4.1l.3-2.5a7.3 7.3 0 0 0 2-1.2l2.3 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2Z"/>'),
  };

  /* ---- Routen-Definition (einzige Quelle der Wahrheit) ----------------- */
  var ROUTES = [
    { path: '/',              key: 'heute',         nav: 'Heute',        eyebrow: 'Cockpit',          title: 'Heute',                lead: 'Der Gesamtzustand auf einen Blick – die wichtigsten Kennzahlen und die dringendsten Handlungsbedarfe.' },
    { path: '/guv',           key: 'guv',           nav: 'GuV',          eyebrow: 'Wirtschaftlichkeit', title: 'GuV & KPI',          lead: 'Umsatz, Deckungsbeitrag und Marge über frei wählbare Zeiträume – Monat, Quartal, Jahr oder eigener Zeitraum.' },
    { path: '/lager',         key: 'lager',         nav: 'Bestand',      eyebrow: 'Lager',            title: 'Bestand & MHD',        lead: 'Bestände und Mindesthaltbarkeit übersichtlich als Karten – kritische Chargen schnell erkennen.' },
    { path: '/slots',         key: 'slots',         nav: 'Sortiment',    eyebrow: 'Bestückung',       title: 'Sortiment & Slots',    lead: 'Sortiment je Automat und der grafische Etagen-Slot-Editor zum Platzieren der Produkte.' },
    { path: '/monitoring',    key: 'monitoring',    nav: 'Monitoring',   eyebrow: 'Betrieb',          title: 'Monitoring',           lead: 'Betriebs- und Zustandsüberwachung – Auffälligkeiten über alle Automaten hinweg früh bemerken.' },
    { path: '/onboarding',    key: 'onboarding',    nav: 'Onboarding',   eyebrow: 'Neuprodukte',      title: 'Produkt-Onboarding',   lead: 'Neue Produkte geführt aufnehmen und direkt einem Slot zuordnen.' },
    { path: '/automaten',     key: 'automaten',     nav: 'Automaten',    eyebrow: 'Stammdaten',       title: 'Automaten',            lead: 'Automaten- und Standortprofile im Blick – von hier direkt in die Slot-Ansicht springen.' },
    { path: '/einstellungen', key: 'einstellungen', nav: 'Einstellungen',eyebrow: 'System',           title: 'Einstellungen',        lead: 'Anzeige, Schwellenwerte und Stammdaten des Cockpits verwalten.' },
  ];

  var ROUTE_BY_PATH = {};
  ROUTES.forEach(function (r) { ROUTE_BY_PATH[r.path] = r; });

  /* ---- DOM-Referenzen -------------------------------------------------- */
  var viewEl, titleEl, navSide, navBottom;
  var loadToken = 0;

  /* ---- Zustands-Komponente (Lade / Leer / Fehler) ---------------------- */
  var STATE_ICON = {
    loading: '<span class="v3-spinner" role="presentation"></span>',
    empty:   icon('<path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4"/><path d="M12 11v10"/>'),
    error:   icon('<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>'),
  };
  function renderState(kind, opts) {
    opts = opts || {};
    var title = opts.title || (kind === 'loading' ? 'Wird geladen …' : kind === 'empty' ? 'Keine Daten' : 'Etwas ist schiefgelaufen');
    var msg = opts.message || '';
    var action = '';
    if (kind === 'error' && opts.onRetry) {
      action = '<button type="button" class="v3-btn v3-btn--brand" data-retry>Erneut versuchen</button>';
    }
    return '' +
      '<div class="v3-state v3-state--' + kind + '" data-state="' + kind + '" role="status" aria-live="polite">' +
        '<span class="v3-state__badge">' + (STATE_ICON[kind] || '') + '</span>' +
        '<p class="v3-state__title">' + title + '</p>' +
        (msg ? '<p class="v3-state__msg">' + msg + '</p>' : '') +
        action +
      '</div>';
  }

  function pageHead(route) {
    return '' +
      '<header class="v3-page__head">' +
        '<p class="v3-page__eyebrow">' + route.eyebrow + '</p>' +
        '<h1 class="v3-page__title">' + route.title + '</h1>' +
        '<p class="v3-page__lead">' + route.lead + '</p>' +
      '</header>';
  }

  /* ---- HTML-Escape --------------------------------------------------------- */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ---- Cockpit-Seite (Heute / /) ----------------------------------------- */
  var COCKPIT_LINKS = {
    'warnings-open': '/monitoring',
    'mhd-risk':      '/lager',
    'low-stock':     '/lager',
    'economics':     '/guv',
  };

  function renderCockpitSkeleton() {
    return '<div class="v3-cockpit">' +
      '<div class="v3-cockpit-skel-kpis">' +
        '<div class="v3-cockpit-skel-kpi v3-skel"></div>' +
        '<div class="v3-cockpit-skel-kpi v3-skel"></div>' +
        '<div class="v3-cockpit-skel-kpi v3-skel"></div>' +
        '<div class="v3-cockpit-skel-kpi v3-skel"></div>' +
      '</div>' +
      '<div class="v3-skel" style="height:96px;border-radius:18px"></div>' +
      '<div>' +
        '<div class="v3-skel" style="height:16px;width:100px;border-radius:6px;margin-bottom:12px"></div>' +
        '<div class="v3-skel" style="height:66px;border-radius:12px;margin-bottom:8px"></div>' +
        '<div class="v3-skel" style="height:66px;border-radius:12px;margin-bottom:8px"></div>' +
        '<div class="v3-skel" style="height:66px;border-radius:12px"></div>' +
      '</div>' +
    '</div>';
  }

  function renderCockpitPage(data) {
    var kpis         = data.kpis         || [];
    var ampelState   = data.ampelState   || 'green';
    var topPriorities = data.topPriorities || [];

    /* KPI strip */
    var kpiHtml = kpis.map(function (kpi) {
      var mod = kpi.key === 'warnings' && kpi.value > 0 ? ' v3-cockpit-kpi--crit' :
                (kpi.key === 'mhd-risk' || kpi.key === 'low-stock') && kpi.value > 0 ? ' v3-cockpit-kpi--warn' : '';
      var valStr = kpi.unit === 'EUR'
        ? kpi.value.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : String(kpi.value);
      return '<div class="v3-cockpit-kpi' + mod + '">' +
        '<span class="v3-cockpit-kpi__label">' + esc(kpi.label) + '</span>' +
        '<span class="v3-cockpit-kpi__value">' + esc(valStr) +
          (kpi.unit ? '<span class="v3-cockpit-kpi__unit"> ' + esc(kpi.unit) + '</span>' : '') +
        '</span>' +
      '</div>';
    }).join('');

    /* Ampel */
    var ampelClass = 'v3-cockpit-ampel--' + (ampelState === 'red' ? 'red' : ampelState === 'yellow' ? 'yellow' : 'green');
    var ampelLabel = ampelState === 'red' ? 'Kritisch' : ampelState === 'yellow' ? 'Warnung' : 'Alles OK';
    var ampelTitle = ampelState === 'red' ? 'Systeme kritisch' : ampelState === 'yellow' ? 'Hinweise vorhanden' : 'Systeme stabil';
    var ampelMsg   = ampelState === 'red'
      ? 'Dringende Eingriffe erforderlich—offene Fehler prüfen.'
      : ampelState === 'yellow'
      ? 'Einzelne Bereiche benötigen Aufmerksamkeit.'
      : 'Alle Systeme laufen stabil. Kein sofortiger Handlungsbedarf.';
    var ampelHtml = '<div class="v3-cockpit-ampel ' + ampelClass + '">' +
      '<div class="v3-cockpit-ampel__orb"><div class="v3-cockpit-ampel__dot"></div></div>' +
      '<div class="v3-cockpit-ampel__body">' +
        '<div class="v3-cockpit-ampel__state">' + esc(ampelLabel) + '</div>' +
        '<p class="v3-cockpit-ampel__title">' + esc(ampelTitle) + '</p>' +
        '<p class="v3-cockpit-ampel__msg">' + esc(ampelMsg) + '</p>' +
      '</div>' +
    '</div>';

    /* Actions */
    var actionsInner;
    if (topPriorities.length === 0) {
      actionsInner = '<div class="v3-cockpit-empty">' +
        '<div class="v3-cockpit-empty__icon">&#10003;</div>' +
        '<p style="margin:0 0 4px;font-weight:600;color:var(--v3-ok)">Kein Handlungsbedarf</p>' +
        '<p style="margin:0">Alle Automaten laufen reibungslos.</p>' +
      '</div>';
    } else {
      actionsInner = '<ul class="v3-cockpit-action-list">' +
        topPriorities.map(function (p) {
          var mod   = p.severity === 'critical' ? 'v3-cockpit-action--critical' :
                      p.severity === 'warning'  ? 'v3-cockpit-action--warning'  : 'v3-cockpit-action--info';
          var badge = p.severity === 'critical' ? 'Kritisch' : p.severity === 'warning' ? 'Warnung' : 'Info';
          var dest  = COCKPIT_LINKS[p.id] || '/';
          var href  = dest === '/' ? BASE : BASE + dest;
          return '<li><a class="v3-cockpit-action ' + mod + '" href="' + href + '" data-route-link="' + dest + '">' +
            '<div class="v3-cockpit-action__body">' +
              '<div class="v3-cockpit-action__top">' +
                '<span class="v3-cockpit-action__badge">' + esc(badge) + '</span>' +
                '<span class="v3-cockpit-action__title">' + esc(p.title) + '</span>' +
              '</div>' +
              '<div class="v3-cockpit-action__msg">' + esc(p.message) + '</div>' +
            '</div>' +
            '<div class="v3-cockpit-action__arrow">&#8594;</div>' +
          '</a></li>';
        }).join('') +
      '</ul>';
    }

    return '<div class="v3-cockpit">' +
      '<div class="v3-cockpit-kpis">' + kpiHtml + '</div>' +
      '<div class="v3-cockpit__lower">' +
        ampelHtml +
        '<div class="v3-cockpit-actions">' +
          '<div class="v3-cockpit-actions__head">' +
            '<span class="v3-cockpit-actions__title">Jetzt handeln</span>' +
          '</div>' +
          actionsInner +
        '</div>' +
      '</div>' +
    '</div>';
  }

  /* ---- Daten-Lader pro Seite ------------------------------------------- */
  function fetchJson(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) { throw new Error(r.status); }
      return r.json();
    });
  }

  function loadPage(route) {
    if (route.path === '/') {
      return Promise.all([
        fetchJson('/api/v2/overview'),
        fetchJson('/api/v2/monitoring'),
      ]).then(function (results) {
        var ov  = results[0] && results[0].data ? results[0].data : {};
        var mon = results[1] && results[1].data ? results[1].data : {};
        /* buildCockpitData runs server-side; here we reconstruct the shape from API */
        var kpis = [
          { key: 'warnings',  label: 'Offene Warnungen', value: (ov.metrics && ov.metrics.openWarningsCount) || 0, unit: null  },
          { key: 'mhd-risk',  label: 'MHD-Risiko',       value: (ov.metrics && ov.metrics.mhdRiskCount)      || 0, unit: null  },
          { key: 'low-stock', label: 'Niedriger Bestand', value: (ov.metrics && ov.metrics.lowStockCount)     || 0, unit: null  },
          { key: 'revenue',   label: 'Umsatz heute',      value: (ov.metrics && ov.metrics.revenueNetToday)   || 0, unit: 'EUR' },
        ];
        var ampels = (mon.ampels || []);
        var ampelState = 'green';
        for (var i = 0; i < ampels.length; i++) {
          if (ampels[i].state === 'red')    { ampelState = 'red'; break; }
          if (ampels[i].state === 'yellow') { ampelState = 'yellow'; }
        }
        var topPriorities = (ov.priorities || []).slice(0, 3);
        return { status: 'ok', cockpit: { kpis: kpis, ampelState: ampelState, topPriorities: topPriorities } };
      }).catch(function () {
        return { status: 'error' };
      });
    }
    return new Promise(function (resolve) {
      setTimeout(function () { resolve({ status: 'ok', route: route }); }, 260);
    });
  }

  function placeholderContent(route) {
    return '' +
      '<section class="v3-card" aria-label="Vorschau ' + route.title + '">' +
        '<p class="v3-state__title" style="margin:0 0 6px">In Vorbereitung</p>' +
        '<p class="v3-state__msg" style="margin:0 0 18px">Diese Seite erhält ihre Inhalte in einem der folgenden Schritte. ' +
          'Das Grundgerüst, die Navigation und die Zustände stehen bereits.</p>' +
        '<div class="v3-skel-grid" aria-hidden="true">' +
          '<div class="v3-skel"></div><div class="v3-skel"></div><div class="v3-skel"></div>' +
        '</div>' +
      '</section>';
  }

  /* ---- Rendering einer Route ------------------------------------------- */
  function renderRoute(route) {
    var token = ++loadToken;

    // Titel / aktive Navigation sofort aktualisieren
    document.title = route.title + ' · Dashboard v3 · Faltrix';
    if (titleEl) { titleEl.textContent = route.nav; }
    setActiveNav(route.path);

    // 1) Ladezustand — Cockpit zeigt eigenes Skeleton, andere Seiten den Standard-Spinner
    viewEl.setAttribute('aria-busy', 'true');
    viewEl.innerHTML = route.path === '/'
      ? pageHead(route) + renderCockpitSkeleton()
      : pageHead(route) + renderState('loading', { title: route.title + ' wird geladen …' });
    viewEl.scrollIntoView ? window.scrollTo(0, 0) : null;

    // 2) Daten der Seite laden, dann Inhalt / Leer / Fehler
    loadPage(route).then(function (result) {
      if (token !== loadToken) { return; } // veralteter Ladevorgang – verwerfen
      viewEl.setAttribute('aria-busy', 'false');
      if (result.status === 'error') {
        viewEl.innerHTML = pageHead(route) +
          renderState('error', { message: 'Die Daten für „' + route.title + '" konnten nicht geladen werden.', onRetry: true });
        bindRetry(route);
      } else if (result.status === 'empty') {
        viewEl.innerHTML = pageHead(route) +
          renderState('empty', { message: 'Für „' + route.title + '" liegen aktuell keine Einträge vor.' });
      } else if (route.path === '/' && result.cockpit) {
        viewEl.innerHTML = pageHead(route) + renderCockpitPage(result.cockpit);
      } else {
        viewEl.innerHTML = pageHead(route) + placeholderContent(route);
      }
    }).catch(function () {
      if (token !== loadToken) { return; }
      viewEl.setAttribute('aria-busy', 'false');
      viewEl.innerHTML = pageHead(route) +
        renderState('error', { message: 'Unerwarteter Fehler beim Laden.', onRetry: true });
      bindRetry(route);
    });
  }

  function bindRetry(route) {
    var btn = viewEl.querySelector('[data-retry]');
    if (btn) { btn.addEventListener('click', function () { renderRoute(route); }); }
  }

  function renderNotFound() {
    ++loadToken;
    document.title = 'Seite nicht gefunden · Dashboard v3';
    if (titleEl) { titleEl.textContent = 'Nicht gefunden'; }
    setActiveNav(null);
    viewEl.setAttribute('aria-busy', 'false');
    viewEl.innerHTML = renderState('empty', {
      title: 'Seite nicht gefunden',
      message: 'Diese Adresse gehört zu keinem Bereich des Cockpits.',
    });
  }

  /* ---- Navigation aufbauen --------------------------------------------- */
  function navItemHtml(r) {
    var href = r.path === '/' ? BASE : BASE + r.path;
    return '<a class="v3-navitem" data-route-link="' + r.path + '" href="' + href + '">' +
      '<span class="v3-navitem__icon">' + (ICONS[r.key] || '') + '</span>' +
      '<span class="v3-navitem__label">' + r.nav + '</span></a>';
  }

  function buildNav() {
    var html = ROUTES.map(navItemHtml).join('');
    if (navSide) { navSide.innerHTML = html; }
    if (navBottom) { navBottom.innerHTML = html; }
  }

  function setActiveNav(path) {
    var links = document.querySelectorAll('[data-route-link]');
    for (var i = 0; i < links.length; i++) {
      var match = links[i].getAttribute('data-route-link') === path;
      if (match) { links[i].setAttribute('aria-current', 'page'); }
      else { links[i].removeAttribute('aria-current'); }
    }
  }

  /* ---- Routing: History-API + Hash-Fallback ---------------------------- */
  function usesHashFallback() {
    // Hash-Routing greift, sobald eine Hash-Route vorliegt oder die History-API
    // nicht verfügbar ist (sehr alte Umgebungen / file://).
    return (location.hash && location.hash.indexOf('#/') === 0) ||
      !(window.history && typeof window.history.pushState === 'function');
  }

  function normalizePath(p) {
    if (!p) { return '/'; }
    p = p.replace(/\/+$/, '') || '/';
    return p;
  }

  function currentRoute() {
    if (location.hash && location.hash.indexOf('#/') === 0) {
      return normalizePath(location.hash.slice(1));
    }
    var p = location.pathname;
    if (p === BASE || p === BASE + '/') { return '/'; }
    if (p.indexOf(BASE + '/') === 0) { return normalizePath(p.slice(BASE.length)); }
    return '/';
  }

  function navigate(path, opts) {
    opts = opts || {};
    path = normalizePath(path);
    if (usesHashFallback()) {
      var hash = '#' + path;
      if (location.hash !== hash) { location.hash = hash; }
      else { dispatch(); }
      return;
    }
    var url = path === '/' ? BASE : BASE + path;
    if (opts.replace) { history.replaceState({ path: path }, '', url); }
    else { history.pushState({ path: path }, '', url); }
    dispatch();
  }

  function dispatch() {
    var path = currentRoute();
    var route = ROUTE_BY_PATH[path];
    if (route) { renderRoute(route); }
    else { renderNotFound(); }
    focusMain();
  }

  function focusMain() {
    var main = document.getElementById('v3-main');
    if (main && typeof main.focus === 'function') {
      try { main.focus({ preventScroll: true }); } catch (e) { main.focus(); }
    }
  }

  function onNavClick(e) {
    var link = e.target.closest && e.target.closest('[data-route-link]');
    if (!link) { return; }
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) { return; }
    e.preventDefault();
    navigate(link.getAttribute('data-route-link'));
  }

  /* ---- Bootstrap ------------------------------------------------------- */
  function init() {
    viewEl = document.querySelector('[data-view]');
    titleEl = document.querySelector('[data-page-title]');
    navSide = document.querySelector('[data-nav="side"]');
    navBottom = document.querySelector('[data-nav="bottom"]');
    if (!viewEl) { return; }

    buildNav();
    document.addEventListener('click', onNavClick);
    window.addEventListener('popstate', dispatch);
    window.addEventListener('hashchange', dispatch);

    dispatch();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Für Tests / spätere Module: kontrollierte Schnittstelle offenlegen.
  window.DashboardV3 = {
    routes: ROUTES,
    navigate: navigate,
    renderState: renderState,
    currentRoute: currentRoute,
  };
})();
