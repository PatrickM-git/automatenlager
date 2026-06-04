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
    einstellungen:icon('<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>'),
    export:       icon('<path d="M12 3v12"/><path d="M8 11l4 4 4-4"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>'),
    print:        icon('<path d="M6 9V3h12v6"/><rect x="6" y="13" width="12" height="8" rx="1"/><path d="M6 17H4a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-2"/>'),
  };

  /* ---- Routen-Definition (einzige Quelle der Wahrheit) ----------------- */
  // #29: `cap` = Fähigkeit, die der Reiter mindestens braucht (Komfort-Sichtbarkeit;
  // die Autorität liegt serverseitig in #28). Heute/Bestand/Sortiment/Monitoring/
  // Automaten = betrieb.lesen; GuV = finanzen.lesen; Onboarding = bestand.schreiben;
  // Einstellungen = system.verwalten.
  var ROUTES = [
    { path: '/',              key: 'heute',         nav: 'Heute',        cap: 'betrieb.lesen',     eyebrow: 'Cockpit',          title: 'Heute',                lead: 'Der Gesamtzustand auf einen Blick – die wichtigsten Kennzahlen und die dringendsten Handlungsbedarfe.' },
    { path: '/guv',           key: 'guv',           nav: 'GuV',          cap: 'finanzen.lesen',    eyebrow: 'Wirtschaftlichkeit', title: 'GuV & KPI',          lead: 'Umsatz, Deckungsbeitrag und Marge über frei wählbare Zeiträume – Monat, Quartal, Jahr oder eigener Zeitraum.' },
    { path: '/lager',         key: 'lager',         nav: 'Bestand',      cap: 'betrieb.lesen',     eyebrow: 'Lager',            title: 'Bestand & MHD',        lead: 'Alle aktiven Lagerchargen mit Mindesthaltbarkeit und Menge – sortierbar nach MHD und Bestand.' },
    { path: '/slots',         key: 'slots',         nav: 'Sortiment',    cap: 'betrieb.lesen',     eyebrow: 'Bestückung',       title: 'Sortiment & Slots',    lead: 'Sortiment je Automat und der grafische Etagen-Slot-Editor zum Platzieren der Produkte.' },
    { path: '/monitoring',    key: 'monitoring',    nav: 'Monitoring',   cap: 'betrieb.lesen',     eyebrow: 'Betrieb',          title: 'Monitoring',           lead: 'Betriebs- und Zustandsüberwachung – Auffälligkeiten über alle Automaten hinweg früh bemerken.' },
    { path: '/onboarding',    key: 'onboarding',    nav: 'Onboarding',   cap: 'bestand.schreiben', eyebrow: 'Neuprodukte',      title: 'Produkt-Onboarding',   lead: 'Neue Produkte geführt aufnehmen und direkt einem Slot zuordnen.' },
    { path: '/automaten',     key: 'automaten',     nav: 'Automaten',    cap: 'betrieb.lesen',     eyebrow: 'Stammdaten',       title: 'Automaten',            lead: 'Automaten- und Standortprofile im Blick – von hier direkt in die Slot-Ansicht springen.' },
    { path: '/einstellungen', key: 'einstellungen', nav: 'Einstellungen',cap: 'system.verwalten',  eyebrow: 'System',           title: 'Einstellungen',        lead: 'Anzeige, Schwellenwerte und Stammdaten des Cockpits verwalten.' },
  ];

  var ROUTE_BY_PATH = {};
  ROUTES.forEach(function (r) { ROUTE_BY_PATH[r.path] = r; });

  /* ---- #29 Fähigkeits-Sichtbarkeit ------------------------------------- */
  // Vom Server (/api/dashboard → viewer.capabilities) gelieferte Fähigkeiten.
  // null = noch unbekannt (Lade-/Fehlerfall) → fail-open: alles sichtbar, denn die
  // Sicherheitsgrenze ist serverseitig (#28). Sichtbarkeit ist nur Komfort.
  var _viewerCaps = null;
  function setViewerCaps(caps) { _viewerCaps = Array.isArray(caps) ? caps.slice() : null; }
  function viewerCan(cap) {
    if (_viewerCaps == null || !cap) { return true; }
    return _viewerCaps.indexOf(cap) !== -1;
  }

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
    'warnings-open': '/lager',
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

  /* Warnungs-Severity → Badge-Text */
  function warnBadge(sev) {
    return sev === 'critical' ? 'Kritisch' : sev === 'warning' ? 'Warnung' : 'Info';
  }
  /* Liste der offenen Warnungen (ausklappbar in der Cockpit-Karte). */
  function cockpitWarningsList(warnings) {
    if (!warnings || !warnings.length) { return ''; }
    var items = warnings.map(function (w) {
      var sev = String(w.severity || 'info').toLowerCase();
      var cls = sev === 'critical' ? 'v3-warnrow--crit' : sev === 'warning' ? 'v3-warnrow--warn' : 'v3-warnrow--info';
      return '<li class="v3-warnrow ' + cls + '">' +
        '<span class="v3-warnrow__badge">' + esc(warnBadge(sev)) + '</span>' +
        '<span class="v3-warnrow__msg">' + esc(w.message || w.warning_type || '') + '</span>' +
      '</li>';
    }).join('');
    return '<ul class="v3-warnlist">' + items + '</ul>';
  }

  function renderCockpitPage(data) {
    var kpis         = data.kpis         || [];
    var ampelState   = data.ampelState   || 'green';
    var topPriorities = data.topPriorities || [];
    var warnings      = data.warnings     || [];

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
          /* "Offene Warnungen": statt Link auf eine Seite, die sie nicht listet,
             direkt ausklappbar mit der konkreten Warnungs-Liste. */
          if (p.id === 'warnings-open' && warnings.length) {
            return '<li><details class="v3-cockpit-action v3-cockpit-action--details ' + mod + '">' +
              '<summary class="v3-cockpit-action__sum">' +
                '<div class="v3-cockpit-action__body">' +
                  '<div class="v3-cockpit-action__top">' +
                    '<span class="v3-cockpit-action__badge">' + esc(badge) + '</span>' +
                    '<span class="v3-cockpit-action__title">' + esc(p.title) + '</span>' +
                  '</div>' +
                  '<div class="v3-cockpit-action__msg">' + esc(p.message) + '</div>' +
                '</div>' +
                '<div class="v3-cockpit-action__chev">&#9662;</div>' +
              '</summary>' +
              cockpitWarningsList(warnings) +
            '</details></li>';
          }
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

  /* ---- Monitoring-Seite (/monitoring) ------------------------------------ */
  /* Client-Spiegel von lib/monitoring-view.js – der Browser kann das CommonJS-
     Modul nicht requiren; die kanonische Logik ist dort getestet. */
  var _monState = { filter: 'all', mon: null, cases: [], canEdit: false };

  var MON_STATE_META = {
    red:    { label: 'Kritisch', title: 'Betrieb kritisch',  msg: 'Mindestens ein Bereich ist kritisch – bitte zuerst die roten Ampeln prüfen.' },
    yellow: { label: 'Warnung',  title: 'Hinweise vorhanden', msg: 'Einzelne Bereiche zeigen Warnungen. Kein Stillstand, aber im Blick behalten.' },
    green:  { label: 'OK',       title: 'Betrieb stabil',     msg: 'Alle überwachten Bereiche laufen stabil.' },
  };
  var MON_CASE_TYPE = {
    mdb_proposal:       { label: 'MDB-Vorschlag',      cls: '' },
    unknown_product:    { label: 'Unbekanntes Produkt', cls: 'unknown' },
    correction_warning: { label: 'Korrektur-Warnung',   cls: 'warning' },
  };

  function monClientView(mon, cases, filter) {
    mon = mon || {};
    var ampelsAll = mon.ampels || [];
    var counts = { red: 0, yellow: 0, green: 0 };
    var worst = 0; var sev = { red: 3, yellow: 2, green: 1 };
    for (var i = 0; i < ampelsAll.length; i++) {
      var st = ampelsAll[i] && ampelsAll[i].state;
      if (st === 'red' || st === 'yellow' || st === 'green') {
        counts[st]++; if (sev[st] > worst) { worst = sev[st]; }
      }
    }
    var overallState = worst === 3 ? 'red' : worst === 2 ? 'yellow' : 'green';
    var activeFilter = (filter && filter !== 'all') ? filter : 'all';
    var ampels = activeFilter === 'all' ? ampelsAll
      : ampelsAll.filter(function (a) { return a && a.state === activeFilter; });
    return {
      overallState: overallState, counts: counts, total: ampelsAll.length,
      distribution: [
        { state: 'red', count: counts.red },
        { state: 'yellow', count: counts.yellow },
        { state: 'green', count: counts.green },
      ],
      ampels: ampels, activeFilter: activeFilter,
      correction: { openCount: (cases || []).length, cases: cases || [] },
    };
  }

  function renderMonCount(state, label, count) {
    return '<div class="v3-mon-count v3-mon-count--' + state + '">' +
      '<span class="v3-mon-count__num">' + count + '</span>' +
      '<span class="v3-mon-count__label">' + esc(label) + '</span></div>';
  }

  function renderMonDistSvg(distribution, total) {
    var W = 100, segs = '', x = 0;
    var colors = { red: 'var(--crit)', yellow: 'var(--warn)', green: 'var(--ok)' };
    if (total <= 0) {
      segs = '<rect x="0" y="0" width="100" height="14" fill="var(--paper-deep)"/>';
    } else {
      for (var i = 0; i < distribution.length; i++) {
        var w = (distribution[i].count / total) * W;
        if (w <= 0) { continue; }
        segs += '<rect x="' + x.toFixed(2) + '" y="0" width="' + w.toFixed(2) + '" height="14" fill="' + colors[distribution[i].state] + '"/>';
        x += w;
      }
    }
    return '<svg class="v3-mon-distbar" viewBox="0 0 100 14" preserveAspectRatio="none" role="img" aria-label="Verteilung der Status-Ampeln">' +
      '<defs><clipPath id="v3-mon-clip"><rect x="0" y="0" width="100" height="14" rx="7"/></clipPath></defs>' +
      '<g clip-path="url(#v3-mon-clip)">' + segs + '</g></svg>';
  }

  function renderMonFilter(view) {
    var defs = [
      { key: 'all', label: 'Alle', count: view.total, dot: null },
      { key: 'red', label: 'Kritisch', count: view.counts.red, dot: 'red' },
      { key: 'yellow', label: 'Warnung', count: view.counts.yellow, dot: 'yellow' },
      { key: 'green', label: 'OK', count: view.counts.green, dot: 'green' },
    ];
    return '<div class="v3-mon-filter" role="group" aria-label="Status filtern">' +
      defs.map(function (d) {
        return '<button type="button" class="v3-mon-chip" data-mon-filter="' + d.key + '" aria-pressed="' + (view.activeFilter === d.key) + '">' +
          (d.dot ? '<span class="v3-mon-chip__dot v3-mon-chip__dot--' + d.dot + '"></span>' : '') +
          esc(d.label) + ' <span class="v3-mon-chip__count">' + d.count + '</span></button>';
      }).join('') + '</div>';
  }

  function renderMonAmpel(a) {
    var cls = (a.state === 'red' || a.state === 'yellow' || a.state === 'green') ? a.state : 'green';
    return '<div class="v3-mon-ampel v3-mon-ampel--' + cls + '">' +
      '<span class="v3-mon-ampel__dot"></span>' +
      '<div class="v3-mon-ampel__main">' +
        '<p class="v3-mon-ampel__label">' + esc(a.label || a.key || '—') + '</p>' +
        '<p class="v3-mon-ampel__msg">' + esc(a.message || '') + '</p>' +
      '</div></div>';
  }

  function renderMonListWrap(view) {
    var list = view.ampels.length === 0
      ? '<div class="v3-mon-cases-empty">Keine Ampeln in dieser Auswahl.</div>'
      : '<div class="v3-mon-list">' + view.ampels.map(renderMonAmpel).join('') + '</div>';
    return renderMonFilter(view) + list;
  }

  function renderMonCaseCard(c) {
    var t = MON_CASE_TYPE[c.case_type] || { label: c.case_type || 'Fall', cls: '' };
    var typeCls = 'v3-mon-case__type' + (t.cls ? ' v3-mon-case__type--' + t.cls : '');
    var meta = [];
    if (c.machine_id) { meta.push('Automat ' + esc(c.machine_id)); }
    if (c.mdb_code != null && c.mdb_code !== '') { meta.push('MDB ' + esc(c.mdb_code)); }
    var actions = _monState.canEdit
      ? '<button type="button" class="v3-btn v3-btn--brand" data-mon-suggest="' + esc(c.case_id) + '">Vorschlag ansehen</button>'
      : '<span class="v3-mon-case__meta">Nur Admins können Korrekturen bestätigen.</span>';
    return '<article class="v3-mon-case">' +
      '<div class="v3-mon-case__head">' +
        '<span class="' + typeCls + '">' + esc(t.label) + '</span>' +
        (meta.length ? '<span class="v3-mon-case__meta">' + meta.join(' · ') + '</span>' : '') +
      '</div>' +
      '<p class="v3-mon-case__msg">' + esc(c.message || c.nayax_report || '') + '</p>' +
      '<div class="v3-mon-case__actions">' + actions + '</div>' +
      '<div class="v3-mon-case__suggest-host"></div>' +
    '</article>';
  }

  function renderMonCorrection(correction) {
    var head =
      '<div class="v3-mon-section__head">' +
        '<h2 class="v3-mon-section__title">Offene Korrekturfälle</h2>' +
        '<span class="v3-mon-section__count">' + correction.openCount + '</span>' +
      '</div>';
    var body = correction.openCount === 0
      ? '<div class="v3-mon-cases-empty">Keine offenen Korrekturfälle – sauber!</div>'
      : '<div class="v3-mon-cases">' + correction.cases.map(renderMonCaseCard).join('') + '</div>';
    return '<section class="v3-mon-section" aria-label="Korrekturfälle">' + head + body + '</section>';
  }

  function renderMonitoringPage(view) {
    var ov = MON_STATE_META[view.overallState];
    var board =
      '<div class="v3-mon-board">' +
        '<div class="v3-mon-overall v3-mon-overall--' + view.overallState + '">' +
          '<div class="v3-mon-overall__orb"><div class="v3-mon-overall__dot"></div></div>' +
          '<div>' +
            '<div class="v3-mon-overall__state">' + esc(ov.label) + '</div>' +
            '<p class="v3-mon-overall__title">' + esc(ov.title) + '</p>' +
            '<p class="v3-mon-overall__msg">' + esc(ov.msg) + '</p>' +
          '</div>' +
        '</div>' +
        '<div class="v3-mon-dist">' +
          '<div class="v3-mon-counts">' +
            renderMonCount('red', 'Kritisch', view.counts.red) +
            renderMonCount('yellow', 'Warnung', view.counts.yellow) +
            renderMonCount('green', 'OK', view.counts.green) +
          '</div>' +
          renderMonDistSvg(view.distribution, view.total) +
        '</div>' +
      '</div>';
    return board +
      '<div data-mon-listwrap>' + renderMonListWrap(view) + '</div>' +
      renderMonCorrection(view.correction);
  }

  function monFindCase(caseId) {
    for (var i = 0; i < _monState.cases.length; i++) {
      if (String(_monState.cases[i].case_id) === String(caseId)) { return _monState.cases[i]; }
    }
    return null;
  }

  function monLoadSuggestion(btn) {
    var caseId = btn.getAttribute('data-mon-suggest');
    var card = btn.closest('.v3-mon-case');
    var host = card && card.querySelector('.v3-mon-case__suggest-host');
    if (!host) { return; }
    if (host.getAttribute('data-open') === '1') { host.innerHTML = ''; host.removeAttribute('data-open'); return; }
    host.setAttribute('data-open', '1');
    host.innerHTML = '<div class="v3-mon-case__suggest"><p>Vorschlag wird geladen …</p></div>';
    fetchJson('/api/v2/correction-action/suggest?case_id=' + encodeURIComponent(caseId)).then(function (res) {
      var products = (res && res.products) || [];
      var suggestion = (res && res.suggestion) || {};
      var suggestedId = suggestion.suggested_product_id != null ? String(suggestion.suggested_product_id) : '';
      var opts = products.map(function (p) {
        var pid = String(p.product_id);
        return '<option value="' + esc(pid) + '"' + (pid === suggestedId ? ' selected' : '') + '>' + esc(p.name) + '</option>';
      }).join('');
      host.innerHTML =
        '<div class="v3-mon-case__suggest">' +
          (suggestion.suggested_product_name
            ? '<p>Systemvorschlag: <span class="v3-mon-case__suggested">' + esc(suggestion.suggested_product_name) + '</span></p>'
            : '<p>Bitte das korrekte Produkt wählen:</p>') +
          '<select class="v3-mon-case__select" data-mon-product aria-label="Korrektes Produkt">' + opts + '</select>' +
          '<button type="button" class="v3-btn v3-btn--brand" data-mon-confirm="' + esc(caseId) + '">Korrektur bestätigen</button>' +
          '<p class="v3-mon-case__result" hidden></p>' +
        '</div>';
      var cBtn = host.querySelector('[data-mon-confirm]');
      if (cBtn) { cBtn.addEventListener('click', function () { monConfirm(caseId, host); }); }
    }).catch(function () {
      host.innerHTML = '<div class="v3-mon-case__suggest"><p class="v3-mon-case__result is-err">Vorschlag konnte nicht geladen werden.</p></div>';
    });
  }

  function monConfirm(caseId, host) {
    var c = monFindCase(caseId);
    if (!c) { return; }
    var sel = host.querySelector('[data-mon-product]');
    var confirmedId = sel && sel.value !== '' ? Number(sel.value) : null;
    var result = host.querySelector('.v3-mon-case__result');
    var btn = host.querySelector('[data-mon-confirm]');
    if (btn) { btn.disabled = true; }
    postJson('/api/v2/correction-action/confirm', {
      case_id: c.case_id, case_type: c.case_type, machine_id: c.machine_id, mdb_code: c.mdb_code,
      old_product_id: c.product_id, slot_assignment_id: c.slot_assignment_id, confirmed_product_id: confirmedId,
    }).then(function (r) {
      if (!result) { return; }
      result.hidden = false;
      if (r.ok && r.json && r.json.ok) {
        result.className = 'v3-mon-case__result is-ok';
        result.textContent = 'Korrektur ausgelöst (' + (r.json.status_ref || 'ok') + ').';
      } else {
        result.className = 'v3-mon-case__result is-err';
        result.textContent = (r.json && r.json.error && r.json.error.message) || 'Bestätigung fehlgeschlagen.';
        if (btn) { btn.disabled = false; }
      }
    }).catch(function () {
      if (result) { result.hidden = false; result.className = 'v3-mon-case__result is-err'; result.textContent = 'Netzwerkfehler bei der Bestätigung.'; }
      if (btn) { btn.disabled = false; }
    });
  }

  function bindMonFilter() {
    var wrap = viewEl.querySelector('[data-mon-listwrap]');
    if (!wrap) { return; }
    var chips = wrap.querySelectorAll('[data-mon-filter]');
    for (var i = 0; i < chips.length; i++) {
      chips[i].addEventListener('click', function () {
        _monState.filter = this.getAttribute('data-mon-filter');
        var view = monClientView(_monState.mon, _monState.cases, _monState.filter);
        wrap.innerHTML = renderMonListWrap(view);
        bindMonFilter();
      });
    }
  }

  function bindMonitoringControls() {
    bindMonFilter();
    var sBtns = viewEl.querySelectorAll('[data-mon-suggest]');
    for (var j = 0; j < sBtns.length; j++) {
      sBtns[j].addEventListener('click', function () { monLoadSuggestion(this); });
    }
  }

  /* ---- Automaten-Seite (/automaten) -------------------------------------- */
  /* Client-Spiegel von lib/automaten-view.js (kanonische Logik dort getestet). */
  var _slotsFocus = null;
  var AUTO_STATUS = { aktiv: 'Aktiv', geplant: 'Geplant', inaktiv: 'Inaktiv' };

  function automatenClientView(machines, locations) {
    machines = machines || []; locations = locations || [];
    var locByMachine = {};
    for (var i = 0; i < locations.length; i++) {
      var ids = locations[i].machine_ids || [];
      for (var k = 0; k < ids.length; k++) {
        var key = String(ids[k] == null ? '' : ids[k]).trim();
        if (key && !locByMachine[key]) { locByMachine[key] = locations[i]; }
      }
    }
    var unassigned = 0;
    var builtMachines = machines.map(function (m) {
      var loc = locByMachine[String(m.machine_id == null ? '' : m.machine_id).trim()] || null;
      var isActive = m.active !== false;
      if (!loc && isActive) { unassigned++; }
      return {
        machine_id: m.machine_id,
        active: isActive,
        label: (m.label && String(m.label).trim()) || String(m.machine_id || ''),
        area: m.area || null, type: m.type || null, position: m.position || null, nickname: m.nickname || null,
        location_name: loc ? loc.name : null,
        location_status: loc ? loc.status : null,
      };
    });
    var activeMachines = builtMachines.filter(function (m) { return m.active; });
    var retiredMachines = builtMachines.filter(function (m) { return !m.active; });
    var builtLocations = locations.map(function (l) {
      return {
        location_id: l.location_id != null ? l.location_id : null,
        location_key: l.location_key || null,
        name: l.name, status: l.status || null,
        machineCount: (l.machine_ids || []).length,
      };
    });
    return {
      machines: activeMachines, retiredMachines: retiredMachines, locations: builtLocations,
      total: activeMachines.length, locationsTotal: builtLocations.length, unassignedCount: unassigned,
    };
  }

  function renderAutoCard(m, isAdmin) {
    var attrs = [];
    if (m.area) { attrs.push(esc(m.area)); }
    if (m.type) { attrs.push(esc(m.type)); }
    if (m.position) { attrs.push(esc(m.position)); }
    if (m.nickname) { attrs.push(esc(m.nickname)); }
    var locChip = m.location_name
      ? '<span class="v3-auto-loc-chip v3-auto-loc-chip--' + (m.location_status || 'none') + '">' + esc(m.location_name) + '</span>'
      : '<span class="v3-auto-loc-chip v3-auto-loc-chip--none">Ohne Standort</span>';
    var jump = '<button type="button" class="v3-btn v3-auto-card__jump" data-auto-jump="' + esc(m.machine_id) + '">Zur Slot-Ansicht <span aria-hidden="true">&#8594;</span></button>';
    // Admin: aktiv -> aussondern; ausgesondert -> reaktivieren.
    var adminAction = '';
    if (isAdmin) {
      adminAction = m.active
        ? '<button type="button" class="v3-auto-card__retire" data-auto-retire="' + esc(m.machine_id) + '" data-auto-name="' + esc(m.label) + '">Aussondern</button>'
        : '<button type="button" class="v3-btn v3-auto-card__reactivate" data-auto-reactivate="' + esc(m.machine_id) + '">Reaktivieren</button>';
    }
    return '<article class="v3-auto-card' + (m.active ? '' : ' v3-auto-card--retired') + '">' +
      '<div class="v3-auto-card__top">' +
        '<span class="v3-auto-card__id">' + esc(m.machine_id) + '</span>' + locChip +
      '</div>' +
      '<p class="v3-auto-card__label">' + esc(m.label) + (m.active ? '' : ' <span class="v3-auto-card__retiredtag">ausgesondert</span>') + '</p>' +
      (attrs.length ? '<div class="v3-auto-card__attrs">' + attrs.map(function (a) { return '<span class="v3-auto-attr">' + a + '</span>'; }).join('') + '</div>' : '') +
      '<div class="v3-auto-card__actions">' + (m.active ? jump : '') + adminAction + '</div>' +
    '</article>';
  }

  function renderAutoLocationCard(l, isAdmin) {
    var del = (isAdmin && l.location_key)
      ? '<button type="button" class="v3-auto-loc-card__del" data-auto-loc-del="' + esc(l.location_key) +
        '" data-auto-loc-name="' + esc(l.name) + '" data-auto-loc-count="' + l.machineCount + '">Löschen</button>'
      : '';
    return '<article class="v3-auto-loc-card">' +
      '<div class="v3-auto-loc-card__top">' +
        '<span class="v3-auto-loc-card__name">' + esc(l.name) + '</span>' +
        '<span class="v3-auto-loc-chip v3-auto-loc-chip--' + (l.status || 'none') + '">' + esc(AUTO_STATUS[l.status] || l.status || '—') + '</span>' +
      '</div>' +
      '<p class="v3-auto-loc-card__meta">' + l.machineCount + ' Automat' + (l.machineCount === 1 ? '' : 'en') + '</p>' +
      (del ? '<div class="v3-auto-loc-card__actions">' + del + '</div>' : '') +
    '</article>';
  }

  // Admin-only: Formulare zum Anlegen von Standort + Automat (Memory: v3-konsistent).
  function automatenAdminForms(view) {
    if (!view.isAdmin) { return ''; }
    var locOpts = (view.locationOptions || []).map(function (o) {
      return '<option value="' + esc(o.key) + '">' + esc(o.name) + '</option>';
    }).join('');
    function field(label, name, ph, req, type) {
      return '<label class="v3-auto-field"><span>' + label + (req ? ' *' : '') + '</span>' +
        '<input type="' + (type || 'text') + '" name="' + name + '"' + (req ? ' required' : '') +
        ' placeholder="' + esc(ph || '') + '"></label>';
    }
    var standortForm =
      '<form class="v3-auto-form" data-auto-formel="standort" hidden>' +
        field('Name', 'name', 'z. B. DPFA Chemnitz', true) +
        field('Art', 'location_type', 'z. B. bildung, büro, gewerbe') +
        field('Notiz', 'notes', 'optional') +
        '<div class="v3-auto-form__actions"><button type="submit" class="v3-btn v3-btn--brand">Standort anlegen</button>' +
          '<span class="v3-auto-form__msg" data-auto-msg="standort"></span></div>' +
      '</form>';
    // #3: Nayax-Geräte als natives Combobox (datalist) — Tippfilter + scrollbar,
    // freier Text bleibt möglich; leer -> reines Freitextfeld.
    var devices = view.nayaxDevices || [];
    var deviceOpts = devices.map(function (d) {
      return '<option value="' + esc(d.machineId) + '">' + esc(d.label) + '</option>';
    }).join('');
    var hasDevices = devices.length > 0;
    var machineKeyField =
      '<label class="v3-auto-field"><span>Automaten-/Nayax-Nr *</span>' +
        '<input type="text" name="machine_key" required ' + (hasDevices ? 'list="nayaxDeviceList" ' : '') +
        'placeholder="' + (hasDevices ? 'Nayax-Gerät wählen oder Nr tippen' : 'z. B. 457107529') + '"></label>' +
      (hasDevices ? '<datalist id="nayaxDeviceList">' + deviceOpts + '</datalist>' : '');
    var automatForm =
      '<form class="v3-auto-form" data-auto-formel="automat" hidden>' +
        machineKeyField +
        field('Bezeichnung', 'name', 'z. B. Snackautomat Foyer', true) +
        '<label class="v3-auto-field"><span>Standort *</span><select name="location_key" required>' +
          (locOpts ? '<option value="">— wählen —</option>' + locOpts
                   : '<option value="">Bitte zuerst einen Standort anlegen</option>') +
        '</select></label>' +
        field('Etage/Bereich', 'area', 'z. B. 2.OG') +
        field('Typ', 'type', 'z. B. Kombi, Snack') +
        field('Spitzname', 'nickname', 'optional') +
        '<div class="v3-auto-form__actions"><button type="submit" class="v3-btn v3-btn--brand">Automat anlegen</button>' +
          '<span class="v3-auto-form__msg" data-auto-msg="automat"></span></div>' +
      '</form>';
    return '<div class="v3-auto-admin">' +
      '<div class="v3-auto-admin__bar">' +
        '<button type="button" class="v3-btn v3-auto-admin__toggle" data-auto-form="standort">+ Neuer Standort</button>' +
        '<button type="button" class="v3-btn v3-auto-admin__toggle" data-auto-form="automat">+ Neuer Automat</button>' +
      '</div>' + standortForm + automatForm +
    '</div>';
  }

  function renderAutomatenPage(view) {
    var summary =
      '<div class="v3-auto-summary">' +
        '<div class="v3-auto-stat"><span class="v3-auto-stat__num">' + view.total + '</span><span class="v3-auto-stat__label">Automaten</span></div>' +
        '<div class="v3-auto-stat"><span class="v3-auto-stat__num">' + view.locationsTotal + '</span><span class="v3-auto-stat__label">Standorte</span></div>' +
        '<div class="v3-auto-stat"><span class="v3-auto-stat__num">' + view.unassignedCount + '</span><span class="v3-auto-stat__label">Ohne Standort</span></div>' +
      '</div>';
    var isAdmin = !!view.isAdmin;
    var machines = view.machines.length === 0
      ? '<div class="v3-mon-cases-empty">Noch keine aktiven Automaten.</div>'
      : '<div class="v3-auto-grid">' + view.machines.map(function (m) { return renderAutoCard(m, isAdmin); }).join('') + '</div>';
    var retired = view.retiredMachines || [];
    var retiredSection = retired.length === 0 ? '' :
      '<section class="v3-auto-section">' +
        '<div class="v3-mon-section__head"><button type="button" class="v3-auto-retired-toggle" data-auto-retired-toggle aria-expanded="false">' +
          '<h2 class="v3-mon-section__title">Ausgesonderte Automaten</h2>' +
          '<span class="v3-mon-section__count">' + retired.length + '</span><span class="v3-auto-retired-caret" aria-hidden="true">▾</span></button></div>' +
        '<div class="v3-auto-grid" data-auto-retired-grid hidden>' + retired.map(function (m) { return renderAutoCard(m, isAdmin); }).join('') + '</div>' +
      '</section>';
    var locations = view.locations.length === 0 ? '' :
      '<section class="v3-auto-section">' +
        '<div class="v3-mon-section__head"><h2 class="v3-mon-section__title">Standorte</h2>' +
          '<span class="v3-mon-section__count">' + view.locationsTotal + '</span></div>' +
        '<div class="v3-auto-loc-grid">' + view.locations.map(function (l) { return renderAutoLocationCard(l, isAdmin); }).join('') + '</div>' +
      '</section>';
    return summary + automatenAdminForms(view) + machines + retiredSection + locations;
  }

  function automatenJump(machineId) {
    _slotsFocus = machineId;
    navigate('/slots');
  }

  function bindAutomatenControls() {
    var btns = viewEl.querySelectorAll('[data-auto-jump]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener('click', function () { automatenJump(this.getAttribute('data-auto-jump')); });
    }
    // Admin: Formular-Toggles (genau eines offen) + Anlegen.
    var toggles = viewEl.querySelectorAll('[data-auto-form]');
    for (var t = 0; t < toggles.length; t++) {
      toggles[t].addEventListener('click', function () {
        var which = this.getAttribute('data-auto-form');
        var forms = viewEl.querySelectorAll('[data-auto-formel]');
        for (var f = 0; f < forms.length; f++) {
          var fel = forms[f];
          if (fel.getAttribute('data-auto-formel') === which) { fel.hidden = !fel.hidden; }
          else { fel.hidden = true; }
        }
      });
    }
    var formEls = viewEl.querySelectorAll('[data-auto-formel]');
    for (var g = 0; g < formEls.length; g++) {
      formEls[g].addEventListener('submit', submitAutomatenForm);
    }
    // Ausgesonderte-Sektion ein-/ausklappen.
    var rt = viewEl.querySelector('[data-auto-retired-toggle]');
    if (rt) {
      rt.addEventListener('click', function () {
        var grid = viewEl.querySelector('[data-auto-retired-grid]');
        if (grid) { grid.hidden = !grid.hidden; this.setAttribute('aria-expanded', grid.hidden ? 'false' : 'true'); }
      });
    }
    // Automat aussondern (mit Rückfrage).
    bindClick('[data-auto-retire]', function (el) {
      var name = el.getAttribute('data-auto-name') || el.getAttribute('data-auto-retire');
      if (!window.confirm('Automat „' + name + '" aussondern?\n\nEr verschwindet aus den aktiven Ansichten (Slot, Sortiment), die Verkaufs-/GuV-Historie bleibt vollständig erhalten. Reaktivieren ist jederzeit möglich.')) { return; }
      autoPost('/api/v2/machines/active', { machine_key: el.getAttribute('data-auto-retire'), active: false }, el);
    });
    // Automat reaktivieren.
    bindClick('[data-auto-reactivate]', function (el) {
      autoPost('/api/v2/machines/active', { machine_key: el.getAttribute('data-auto-reactivate'), active: true }, el);
    });
    // Standort löschen (mit Rückfrage; Guard serverseitig).
    bindClick('[data-auto-loc-del]', function (el) {
      var name = el.getAttribute('data-auto-loc-name') || '';
      var count = Number(el.getAttribute('data-auto-loc-count') || 0);
      if (count > 0) {
        window.alert('Standort „' + name + '" hat noch ' + count + ' Automat' + (count === 1 ? '' : 'en') + '.\nBitte zuerst die Automaten umziehen oder aussondern.');
        return;
      }
      if (!window.confirm('Standort „' + name + '" wirklich löschen? Das kann nicht rückgängig gemacht werden.')) { return; }
      autoPost('/api/v2/locations', { location_key: el.getAttribute('data-auto-loc-del') }, el, 'DELETE');
    });
  }

  function bindClick(sel, fn) {
    var els = viewEl.querySelectorAll(sel);
    for (var i = 0; i < els.length; i++) {
      els[i].addEventListener('click', function () { fn(this); });
    }
  }

  // POST/DELETE + Refresh; bei Fehler eine kurze Meldung (alert), sonst stilles Reload.
  function autoPost(url, data, el, method) {
    if (el) { el.disabled = true; }
    fetch(url, { method: method || 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (res.ok && res.j && res.j.ok) { dispatch(); }
        else { window.alert((res.j && res.j.error && res.j.error.message) || 'Aktion fehlgeschlagen.'); if (el) { el.disabled = false; } }
      })
      .catch(function () { window.alert('Netzwerkfehler.'); if (el) { el.disabled = false; } });
  }

  function submitAutomatenForm(e) {
    e.preventDefault();
    var form = e.currentTarget;
    var which = form.getAttribute('data-auto-formel');
    var msg = viewEl.querySelector('[data-auto-msg="' + which + '"]');
    var submitBtn = form.querySelector('button[type="submit"]');
    var data = {};
    var fd = new FormData(form);
    fd.forEach(function (v, k) { var s = String(v).trim(); if (s) { data[k] = s; } });
    if (which === 'standort') { data.status = 'aktiv'; }
    var url = which === 'standort' ? '/api/v2/locations' : '/api/v2/machines';
    if (submitBtn) { submitBtn.disabled = true; }
    if (msg) { msg.textContent = 'Speichern …'; msg.className = 'v3-auto-form__msg'; }
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (res.ok && res.j && res.j.ok) {
          if (msg) { msg.textContent = 'Angelegt ✓'; msg.className = 'v3-auto-form__msg is-ok'; }
          window.setTimeout(function () { dispatch(); }, 500);
        } else {
          var m = (res.j && res.j.error && res.j.error.message) || 'Anlegen fehlgeschlagen.';
          if (msg) { msg.textContent = m; msg.className = 'v3-auto-form__msg is-err'; }
          if (submitBtn) { submitBtn.disabled = false; }
        }
      })
      .catch(function () {
        if (msg) { msg.textContent = 'Netzwerkfehler.'; msg.className = 'v3-auto-form__msg is-err'; }
        if (submitBtn) { submitBtn.disabled = false; }
      });
  }

  function slotsApplyFocus() {
    if (!_slotsFocus) { return; }
    var raw = _slotsFocus; _slotsFocus = null;
    var sel = (window.CSS && CSS.escape) ? CSS.escape(raw) : String(raw).replace(/"/g, '\\"');
    var target = viewEl.querySelector('[data-slots-stage-machine="' + sel + '"]');
    if (!target) { return; }
    try { target.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) { target.scrollIntoView(); }
    target.classList.add('is-jump-target');
    window.setTimeout(function () { target.classList.remove('is-jump-target'); }, 1600);
  }

  /* ---- Onboarding-Seite (/onboarding) — Routing-Cockpit ------------------ */
  /* Domänenkorrekt: Stammdaten (Name/Preis/MwSt) + Lagerchargen (MHD) gehören
     WF2 bzw. dem Wareneingang und entstehen über WF1 (Rechnung) -> WF2 (Freigabe).
     Diese Seite ERFASST keine Stammdaten, sie macht die Pipeline sichtbar und
     routet jede Stufe zum richtigen Werkzeug (Freigabe -> WF2-Formular,
     slot_offen -> Slot-Zuordnung). Client-Spiegel von lib/onboarding-flow.js. */
  var _onbState = { data: null, canEdit: false };

  function onbFunnelClient(data) {
    data = data || {};
    var by = data.products_by_status || {};
    var approvals = Array.isArray(data.pending_approvals) ? data.pending_approvals : [];
    var unknown = Array.isArray(data.unknown_products) ? data.unknown_products : [];
    function cnt(k) { return (by[k] || []).length; }
    var approvalsCount = approvals.length;
    var nayaxPendingCount = cnt('bereit_fur_moma');
    var verkaufsbereitCount = cnt('verkaufsbereit');
    return {
      stages: [
        { key: 'approvals',      label: 'Freigabe offen',          count: approvalsCount },
        { key: 'nayax_pending',  label: 'Nayax-Verknüpfung offen', count: nayaxPendingCount },
        { key: 'verkaufsbereit', label: 'Verkaufsbereit',          count: verkaufsbereitCount },
      ],
      approvals: approvals.slice(), approvalsCount: approvalsCount,
      nayaxPendingCount: nayaxPendingCount, verkaufsbereitCount: verkaufsbereitCount,
      unknownProducts: unknown.slice(), unknownCount: unknown.length,
      wf2FormUrl: data.wf2_form_url || '',
    };
  }

  function renderOnbUpload(canEdit) {
    if (!canEdit) {
      return '<section class="v3-card v3-onb-card">' +
        '<h2 class="v3-onb-card__title">Rechnung erfassen</h2>' +
        '<p class="v3-onb-card__lead">Das Hochladen von Rechnungen ist Admins vorbehalten.</p>' +
      '</section>';
    }
    var uploadIcon = icon('<path d="M12 16V4"/><path d="M7 9l5-5 5 5"/><path d="M4 20h16"/>');
    return '<section class="v3-card v3-onb-card">' +
      '<h2 class="v3-onb-card__title">Rechnung erfassen</h2>' +
      '<p class="v3-onb-card__lead">Rechnung als PDF oder Foto hochladen – <b>WF1</b> liest sie automatisch aus und uebergibt sie an die Freigabe (WF2).</p>' +
      '<div class="v3-onb-upload">' +
        '<label class="v3-onb-upload__drop" for="v3-onb-file">' +
          '<span class="v3-onb-upload__icon">' + uploadIcon + '</span>' +
          '<span class="v3-onb-upload__cta"><b>Datei waehlen</b> oder Kamera</span>' +
          '<span class="v3-onb-upload__file" data-onb-filename>PDF, JPG oder PNG &middot; max. 10 MB</span>' +
          '<input id="v3-onb-file" class="v3-onb-upload__input" type="file" accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg" data-onb-file>' +
        '</label>' +
        '<div class="v3-onb-upload__actions">' +
          '<button type="button" class="v3-btn v3-btn--brand" data-onb-upload disabled>Hochladen &amp; verarbeiten</button>' +
        '</div>' +
        '<p class="v3-onb-upload__result" data-onb-upload-result hidden></p>' +
        '<p class="v3-onb-upload__drive">Alternativ: am Handy teilen &#8594; in den Drive-Ordner &bdquo;Rechnungseingang&ldquo; legen.</p>' +
      '</div>' +
    '</section>';
  }

  function renderOnbStatus(funnel) {
    var tiles = funnel.stages.map(function (s) {
      return '<div class="v3-onb-stat v3-onb-stat--' + s.key + '">' +
        '<span class="v3-onb-stat__num">' + s.count + '</span>' +
        '<span class="v3-onb-stat__label">' + esc(s.label) + '</span></div>';
    }).join('');
    return '<div class="v3-onb-status">' + tiles + '</div>';
  }

  function renderOnbApprovals(funnel) {
    if (funnel.approvalsCount === 0) { return ''; }
    var hasForm = !!funnel.wf2FormUrl;
    var items = funnel.approvals.map(function (a) {
      var meta = [a.supplier_name, a.invoice_date].filter(Boolean).map(esc).join(' · ');
      var action = hasForm
        ? '<a class="v3-btn v3-btn--brand" href="' + esc(funnel.wf2FormUrl) + '" target="_blank" rel="noopener noreferrer">Im WF2-Formular freigeben</a>'
        : '<span class="v3-onb-note">WF2-Formular-URL nicht konfiguriert.</span>';
      return '<div class="v3-onb-approval">' +
        '<div class="v3-onb-approval__main">' +
          '<span class="v3-onb-approval__nr">Rechnung ' + esc(a.invoice_number || a.invoice_key || '—') + '</span>' +
          (meta ? '<span class="v3-onb-approval__meta">' + meta + '</span>' : '') +
        '</div>' +
        '<span class="v3-onb-approval__open">' + (a.open_items || 0) + ' offen</span>' +
        action +
      '</div>';
    }).join('');
    return '<section class="v3-card v3-onb-card">' +
      '<div class="v3-mon-section__head"><h2 class="v3-mon-section__title">Rechnungen freigeben (WF2)</h2>' +
        '<span class="v3-mon-section__count">' + funnel.approvalsCount + '</span></div>' +
      '<p class="v3-onb-card__lead">Offene Rechnungsposten – hier legt WF2 das Produkt mit Stammdaten und Lagercharge (inkl. MHD) an.</p>' +
      '<div class="v3-onb-approvals">' + items + '</div>' +
    '</section>';
  }

  function renderOnbUnknown(funnel) {
    var unknown = funnel.unknownProducts;
    if (!unknown || unknown.length === 0) { return ''; }
    var hasForm = !!funnel.wf2FormUrl;
    return '<section class="v3-card v3-onb-card">' +
      '<div class="v3-mon-section__head"><h2 class="v3-mon-section__title">Unbekannte Nayax-Produkte</h2>' +
        '<span class="v3-mon-section__count">' + unknown.length + '</span></div>' +
      '<p class="v3-onb-card__lead">Verkäufe ohne Produktzuordnung. Sie lösen sich auf, sobald das Produkt über eine Rechnung (WF1 &#8594; WF2) angelegt und der Nayax-Name zugeordnet ist' +
        (hasForm ? ' &#8211; dafür unten das WF2-Formular öffnen.' : '.') + '</p>' +
      '<div class="v3-onb-unknown">' +
        unknown.map(function (u) {
          return '<div class="v3-onb-unknown__item">' +
            '<span class="v3-onb-unknown__key">' + esc(u.product_key) + '</span>' +
            '<span class="v3-onb-unknown__tx">' + (u.tx_count || 0) + ' Verkäufe</span>' +
          '</div>';
        }).join('') +
      '</div>' +
      (hasForm
        ? '<div class="v3-onb-unknown__cta"><a class="v3-btn v3-btn--brand" href="' + esc(funnel.wf2FormUrl) + '" target="_blank" rel="noopener noreferrer">WF2-Formular öffnen</a></div>'
        : '') +
    '</section>';
  }

  function renderOnboardingPage(payload) {
    _onbState.data = payload.data || {};
    _onbState.canEdit = !!payload.canEdit;
    var funnel = onbFunnelClient(_onbState.data);
    return renderOnbUpload(_onbState.canEdit) +
      renderOnbStatus(funnel) +
      renderOnbApprovals(funnel) +
      renderOnbUnknown(funnel);
  }

  function onbUploadFileChosen(input) {
    var nameEl = viewEl.querySelector('[data-onb-filename]');
    var btn = viewEl.querySelector('[data-onb-upload]');
    var file = input.files && input.files[0];
    if (file) {
      if (nameEl) { nameEl.textContent = file.name; nameEl.classList.add('is-set'); }
      if (btn) { btn.disabled = false; }
    } else {
      if (nameEl) { nameEl.textContent = 'PDF, JPG oder PNG'; nameEl.classList.remove('is-set'); }
      if (btn) { btn.disabled = true; }
    }
  }

  function onbUpload(btn) {
    var input = viewEl.querySelector('[data-onb-file]');
    var result = viewEl.querySelector('[data-onb-upload-result]');
    var file = input && input.files && input.files[0];
    if (!file) { return; }
    var fd = new FormData(); fd.append('target', 'invoice'); fd.append('file', file, file.name);
    var label = btn.textContent; btn.disabled = true; btn.textContent = 'Wird hochgeladen ...';
    function show(cls, msg) {
      if (result) { result.hidden = false; result.className = 'v3-onb-upload__result ' + cls; result.textContent = msg; }
    }
    fetch('/api/v2/uploads/invoice', { method: 'POST', body: fd })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, json: j }; }); })
      .then(function (r) {
        if (r.ok && r.json && r.json.ok) {
          show('is-ok', 'Rechnung "' + file.name + '" hochgeladen – WF1 verarbeitet sie jetzt.');
          if (input) { input.value = ''; }
          var nameEl = viewEl.querySelector('[data-onb-filename]');
          if (nameEl) { nameEl.textContent = 'PDF, JPG oder PNG'; nameEl.classList.remove('is-set'); }
          btn.textContent = label;
        } else {
          show('is-err', (r.json && r.json.error && r.json.error.message) || 'Upload fehlgeschlagen.');
          btn.disabled = false; btn.textContent = label;
        }
      })
      .catch(function () { show('is-err', 'Netzwerkfehler beim Upload.'); btn.disabled = false; btn.textContent = label; });
  }

  function bindOnboardingControls() {
    var fileInput = viewEl.querySelector('[data-onb-file]');
    if (fileInput) { fileInput.addEventListener('change', function () { onbUploadFileChosen(this); }); }
    var uploadBtn = viewEl.querySelector('[data-onb-upload]');
    if (uploadBtn) { uploadBtn.addEventListener('click', function () { onbUpload(this); }); }
  }

  /* ---- Daten-Lader pro Seite ------------------------------------------- */
  function fetchJson(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) { throw new Error(r.status); }
      return r.json();
    });
  }

  function postJson(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (r) {
      return r.json().then(function (json) { return { ok: r.ok, status: r.status, json: json }; });
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
          { key: 'low-stock', label: 'Leere Slots', value: (ov.metrics && ov.metrics.lowStockCount)     || 0, unit: null  },
          { key: 'revenue',   label: 'Umsatz heute',      value: (ov.metrics && ov.metrics.revenueGrossToday) || 0, unit: 'EUR' },
        ];
        var ampels = (mon.ampels || []);
        var ampelState = 'green';
        for (var i = 0; i < ampels.length; i++) {
          if (ampels[i].state === 'red')    { ampelState = 'red'; break; }
          if (ampels[i].state === 'yellow') { ampelState = 'yellow'; }
        }
        var topPriorities = (ov.priorities || []).slice(0, 3);
        return { status: 'ok', cockpit: { kpis: kpis, ampelState: ampelState, topPriorities: topPriorities, warnings: (ov.warnings || []) } };
      }).catch(function () {
        return { status: 'error' };
      });
    }
    if (route.path === '/lager') {
      /* Sortiment-Slots zusätzlich laden: liefert die quartilbasierte Drehzahl-
         Klasse je Slot (machine_id+mdb_code). Single Source of Truth ist der
         Sortiment-Endpunkt; hier wird sie nur per Join an die MHD-Karten geheftet.
         Fällt der Join aus, bleiben die Karten ohne Drehzahl-Badge (graceful). */
      return Promise.all([
        fetchJson('/api/v2/inventory-mhd'),
        fetchJson('/api/v2/assortment-slots').catch(function () { return {}; }),
        fetchJson('/api/dashboard').catch(function () { return {}; }),
      ]).then(function (results) {
        var res    = results[0];
        var viewer = (results[2] && results[2].viewer) || {};
        _lagerCanEdit = !!viewer.canTriggerActions;
        var batches = (res && res.data && res.data.allBatches) || [];
        if (batches.length === 0) { return { status: 'empty' }; }
        return { status: 'ok', lager: { batches: batches } };
      }).catch(function () {
        return { status: 'error' };
      });
    }
    if (route.path === '/guv') {
      return loadGuvData(_guvQuery)
        .then(function (data) { return { status: 'ok', guv: data }; })
        .catch(function () { return { status: 'error' }; });
    }
    if (route.path === '/slots') {
      return Promise.all([
        fetchJson('/api/v2/assortment-slots'),
        fetchJson('/api/v2/products/catalog?q='),
        fetchJson('/api/dashboard').catch(function () { return {}; }),
      ]).then(function (results) {
        var slots   = (results[0] && results[0].data && results[0].data.slots) || [];
        var search  = (results[1] && results[1].results) || [];
        var viewer  = (results[2] && results[2].viewer) || {};
        if (slots.length === 0) { return { status: 'empty' }; }
        return {
          status: 'ok',
          slots: {
            machines: groupSlotsByMachine(slots),
            palette:  slotBuildPalette(search),
            canEdit:  !!viewer.canTriggerActions,
          },
        };
      }).catch(function () { return { status: 'error' }; });
    }
    if (route.path === '/monitoring') {
      return Promise.all([
        fetchJson('/api/v2/monitoring'),
        fetchJson('/api/v2/correction-cases').catch(function () { return { cases: [] }; }),
        fetchJson('/api/dashboard').catch(function () { return {}; }),
      ]).then(function (results) {
        var mon    = (results[0] && results[0].data) ? results[0].data : {};
        var cases  = (results[1] && results[1].cases) || [];
        var viewer = (results[2] && results[2].viewer) || {};
        _monState.mon = mon;
        _monState.cases = cases;
        _monState.canEdit = !!viewer.canTriggerActions;
        _monState.filter = 'all';
        return { status: 'ok', monitoring: monClientView(mon, cases, 'all') };
      }).catch(function () { return { status: 'error' }; });
    }
    if (route.path === '/automaten') {
      return Promise.all([
        fetchJson('/api/v2/machine-profiles'),
        fetchJson('/api/v2/locations').catch(function () { return { data: [] }; }),
        fetchJson('/api/v2/nayax-devices').catch(function () { return { data: [] }; }),
      ]).then(function (results) {
        var machines  = (results[0] && results[0].data) || [];
        var locations = (results[1] && results[1].data) || [];
        var devices   = (results[2] && results[2].data) || [];
        var isAdmin   = !!(results[0] && results[0].is_admin);
        var view = automatenClientView(machines, locations);
        view.isAdmin = isAdmin;
        // Nayax-Geräte fürs Anlege-Combobox: nur noch nicht angelegte vorschlagen.
        view.nayaxDevices = devices.filter(function (d) { return !d.alreadyCreated; });
        // Standort-Optionen für das "Neuer Automat"-Dropdown (key + Name).
        view.locationOptions = locations.map(function (l) {
          return { key: l.location_key || l.location_id, name: l.name };
        }).filter(function (o) { return o.key; });
        // Gästen ohne Profile/Standorte trotzdem die leere Seite (mit Hinweis) zeigen;
        // Admins immer (sie sollen anlegen können).
        if (!isAdmin && machines.length === 0 && locations.length === 0) { return { status: 'empty' }; }
        return { status: 'ok', automaten: view };
      }).catch(function () { return { status: 'error' }; });
    }
    if (route.path === '/onboarding') {
      return Promise.all([
        fetchJson('/api/v2/onboarding'),
        fetchJson('/api/dashboard').catch(function () { return {}; }),
      ]).then(function (results) {
        var data   = (results[0] && results[0].data) || {};
        var viewer = (results[1] && results[1].viewer) || {};
        return { status: 'ok', onboarding: { data: data, canEdit: !!viewer.canTriggerActions } };
      }).catch(function () { return { status: 'error' }; });
    }
    if (route.path === '/einstellungen') {
      return fetchJson('/api/v2/settings/definitions').then(function (res) {
        var defs = res && res.definitions ? res.definitions : null;
        if (!defs) { return { status: 'error' }; }
        return { status: 'ok', settings: defs, canEdit: !!(res && res.canEdit) };
      }).catch(function () { return { status: 'error' }; });
    }
    return new Promise(function (resolve) {
      setTimeout(function () { resolve({ status: 'ok', route: route }); }, 260);
    });
  }

  /* ---- Lager-Seite (Bestand & MHD / /lager) ----------------------------- */

  /* Berechnet Dringlichkeit-Farbe und MHD-Balken-Füllstand */
  function mhdUrgency(mhdDate) {
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var mhd   = new Date(mhdDate + 'T00:00:00');
    var days  = Math.round((mhd - today) / 86400000);
    var pct   = days <= 0 ? 100 : days >= 30 ? 8 : Math.round((1 - days / 30) * 92 + 8);
    var label = days < 0  ? 'Abgelaufen (' + Math.abs(days) + ' Tage)' :
                days === 0 ? 'Läuft heute ab' :
                days === 1 ? 'Noch 1 Tag' :
                'Noch ' + days + ' Tage';
    return { days: days, pct: pct, label: label };
  }

  /* Drehzahl-/Slow-Mover-Klassen (Quelle: lib/slow-mover.js → SLOW_MOVER).
     Reihenfolge = Filter-Reihenfolge. „normal" bleibt ohne Badge (Grundzustand),
     ist aber filterbar. */
  var TURNOVER_CLASSES = [
    { key: 'renner',         label: 'Renner',         short: 'Renner'   },
    { key: 'normal',         label: 'Normal',         short: 'Normal'   },
    { key: 'langsam_dreher', label: 'Langsam-Dreher', short: 'Langsam'  },
    { key: 'ladenhueter',    label: 'Ladenhüter',     short: 'Ladenh.'  },
    { key: 'ek_fehlt',       label: 'EK fehlt',       short: 'EK?'      },
    { key: 'neu',            label: 'Neu',            short: 'Neu'      },
  ];
  var TURNOVER_LABEL = {};
  var TURNOVER_SHORT = {};
  TURNOVER_CLASSES.forEach(function (c) { TURNOVER_LABEL[c.key] = c.label; TURNOVER_SHORT[c.key] = c.short; });

  /* Klassen-Badge (v3-badge--turnover-<key>). „normal"/leer → kein Badge.
     compact=true nutzt das Kurzlabel (für enge Slot-Zellen). */
  function turnoverBadge(key, compact) {
    if (!key || key === 'normal') { return ''; }
    var label = TURNOVER_LABEL[key] || key;
    var text  = compact ? (TURNOVER_SHORT[key] || label) : label;
    var extra = compact ? ' v3-slot__turnover' : '';
    return '<span class="v3-badge v3-badge--turnover v3-badge--turnover-' + esc(key) + extra + '"' +
      ' title="Drehzahl: ' + esc(label) + '">' + esc(text) + '</span>';
  }

  function renderLagerCard(card) {
    var sev   = card.severity || 'info';
    var mod   = sev === 'critical' ? ' v3-lager-card--crit' : sev === 'warning' ? ' v3-lager-card--warn' : ' v3-lager-card--info';
    var bMod  = sev === 'critical' ? 'v3-badge--crit' : sev === 'warning' ? 'v3-badge--warn' : 'v3-badge--info';
    var bTxt  = sev === 'critical' ? 'Kritisch' : sev === 'warning' ? 'Warnung' : 'OK';
    // Drehzahl-Klasse als Badge (renner/langsam_dreher/ladenhueter). Fällt auf das
    // alte slow_mover_class-Feld zurück, falls turnover_class (noch) fehlt.
    var turnoverKey = card.turnover_class || (card.slow_mover_class ? 'langsam_dreher' : null);
    var slow  = turnoverBadge(turnoverKey, false);
    var vMod  = sev === 'critical' ? ' v3-lager-card__stat-value--crit' : sev === 'warning' ? ' v3-lager-card__stat-value--warn' : '';
    var urg   = card.mhd_date ? mhdUrgency(card.mhd_date) : { pct: 0, label: '—' };
    var expiryBar = card.mhd_date
      ? '<div class="v3-lager-card__expiry">' +
          '<div class="v3-lager-card__expiry-track">' +
            '<div class="v3-lager-card__expiry-fill" style="width:' + urg.pct + '%"></div>' +
          '</div>' +
          '<span class="v3-lager-card__expiry-label">' + esc(urg.label) + '</span>' +
        '</div>'
      : '';
    // Aussortieren-Knopf (admin-only). Bucht die Charge aus (status=ausgesondert,
    // remaining_qty=0) — entfernt MHD-abgelaufene/entnommene Ware aus dem Bestand.
    var writeOffBtn = (_lagerCanEdit && card.batch_key)
      ? '<div class="v3-lager-card__actions">' +
          '<button type="button" class="v3-lager-card__writeoff" data-writeoff-btn' +
            ' data-batch-key="' + esc(card.batch_key) + '"' +
            ' data-product-name="' + esc(card.product_name) + '"' +
            ' data-remaining="' + esc(String(card.remaining_qty)) + '">Aussortieren</button>' +
        '</div>'
      : '';
    return '<article class="v3-lager-card' + mod + '">' +
      '<div class="v3-lager-card__head">' +
        '<span class="v3-lager-card__product">' + esc(card.product_name) + '</span>' +
        '<div class="v3-lager-card__badges">' +
          '<span class="v3-badge ' + bMod + '">' + bTxt + '</span>' +
          slow +
        '</div>' +
      '</div>' +
      '<div class="v3-lager-card__stats">' +
        '<div>' +
          '<div class="v3-lager-card__stat-label">MHD</div>' +
          '<div class="v3-lager-card__stat-value' + vMod + '">' + esc(card.mhd_date || '—') + '</div>' +
        '</div>' +
        '<div>' +
          '<div class="v3-lager-card__stat-label">Bestand</div>' +
          '<div class="v3-lager-card__stat-value">' + esc(String(card.remaining_qty)) + ' Stk.</div>' +
        '</div>' +
        '<div>' +
          '<div class="v3-lager-card__stat-label">Automat</div>' +
          '<div class="v3-lager-card__stat-value">' + esc(card.machine_name || card.machine_id || '—') + '</div>' +
        '</div>' +
        '<div>' +
          '<div class="v3-lager-card__stat-label">Slot</div>' +
          '<div class="v3-lager-card__stat-value">' + esc(card.mdb_code || '—') + '</div>' +
        '</div>' +
      '</div>' +
      expiryBar +
      writeOffBtn +
    '</article>';
  }

  function renderBarChartSvg(cards) {
    if (!cards || cards.length === 0) {
      return '<p class="v3-lager-chart-empty">Keine Daten</p>';
    }
    var items = cards
      .slice()
      .sort(function (a, b) { return b.remaining_qty - a.remaining_qty; })
      .slice(0, 8);
    var max = items[0].remaining_qty || 1;
    var ROW = 32, PAD_LEFT = 96, PAD_RIGHT = 42, BAR_MAX = 140;
    var h = items.length * ROW + 8;
    var rows = items.map(function (c, i) {
      var barW  = Math.max(4, Math.round((c.remaining_qty / max) * BAR_MAX));
      var sev   = c.severity || 'info';
      var cls   = sev === 'critical' ? 'v3-chart-bar--crit' : sev === 'warning' ? 'v3-chart-bar--warn' : 'v3-chart-bar--info';
      var y     = i * ROW + 4;
      var label = c.product_name.length > 12 ? c.product_name.slice(0, 11) + '…' : c.product_name;
      return '<g role="img" aria-label="' + esc(c.product_name) + ': ' + c.remaining_qty + '">' +
        '<text class="v3-chart-label" x="' + (PAD_LEFT - 6) + '" y="' + (y + 13) + '" text-anchor="end" font-size="11">' + esc(label) + '</text>' +
        '<rect class="v3-chart-bar ' + cls + '" x="' + PAD_LEFT + '" y="' + (y + 2) + '" width="' + barW + '" height="18" rx="4"/>' +
        '<text class="v3-chart-value" x="' + (PAD_LEFT + barW + 5) + '" y="' + (y + 14) + '" font-size="11">' + esc(String(c.remaining_qty)) + '</text>' +
      '</g>';
    }).join('');
    var totalW = PAD_LEFT + BAR_MAX + PAD_RIGHT;
    return '<svg viewBox="0 0 ' + totalW + ' ' + h + '" aria-label="Restmengen im Überblick" role="img" ' +
      'style="width:100%;display:block;overflow:visible">' + rows + '</svg>';
  }

  /* Summary KPI strip for lager page */
  function renderLagerKpis(summary) {
    var total = summary.total || 0;
    var crit  = summary.critical || 0;
    var warn  = summary.warning  || 0;
    function kpi(label, value, mod) {
      return '<div class="v3-cockpit-kpi' + (mod ? ' v3-cockpit-kpi--' + mod : '') + '">' +
        '<span class="v3-cockpit-kpi__label">' + label + '</span>' +
        '<span class="v3-cockpit-kpi__value">' + value + '</span>' +
      '</div>';
    }
    return '<div class="v3-cockpit-kpis" style="margin-bottom:18px">' +
      kpi('Einträge gesamt', total, '') +
      kpi('Kritisch', crit, crit > 0 ? 'crit' : '') +
      kpi('Warnung', warn, warn > 0 ? 'warn' : '') +
    '</div>';
  }

  /* Filter-Bar HTML — machines + products populated from data */
  function renderLagerBar(cards) {
    var machines = {}, products = {};
    cards.forEach(function (c) {
      if (c.machine_id) machines[c.machine_id] = c.machine_name || c.machine_id;
      if (c.product_id) products[c.product_id] = c.product_name;
    });
    var machOpts = '<option value="">Alle Automaten</option>' +
      Object.keys(machines).sort().map(function (id) {
        return '<option value="' + esc(id) + '">' + esc(machines[id]) + '</option>';
      }).join('');
    var prodOpts = '<option value="">Alle Produkte</option>' +
      Object.keys(products).sort(function (a, b) {
        return products[a].localeCompare(products[b]);
      }).map(function (id) {
        return '<option value="' + esc(id) + '">' + esc(products[id]) + '</option>';
      }).join('');
    var turnoverChips = TURNOVER_CLASSES.map(function (c) {
      return '<button class="v3-chip v3-chip--turnover-' + esc(c.key) + '" data-lager-turnover="' + esc(c.key) + '"' +
        ' aria-pressed="false">' + esc(c.label) + '</button>';
    }).join('');
    return '<div class="v3-lager-bar" role="search" aria-label="Bestand filtern">' +
      '<div class="v3-lager-bar__group">' +
        '<span class="v3-lager-bar__label">Dringlichkeit</span>' +
        '<button class="v3-chip v3-chip--active" data-lager-sev="" aria-pressed="true">Alle</button>' +
        '<button class="v3-chip v3-chip--crit" data-lager-sev="critical" aria-pressed="false">Kritisch</button>' +
        '<button class="v3-chip v3-chip--warn" data-lager-sev="warning" aria-pressed="false">Warnung</button>' +
      '</div>' +
      '<div class="v3-lager-bar__group">' +
        '<span class="v3-lager-bar__label">Drehzahl</span>' +
        '<button class="v3-chip v3-chip--active" data-lager-turnover="" aria-pressed="true">Alle</button>' +
        turnoverChips +
      '</div>' +
      '<div class="v3-lager-bar__group">' +
        '<span class="v3-lager-bar__label">Automat</span>' +
        '<select data-lager-machine aria-label="Automat wählen">' + machOpts + '</select>' +
      '</div>' +
      '<div class="v3-lager-bar__group">' +
        '<span class="v3-lager-bar__label">Produkt</span>' +
        '<select data-lager-product aria-label="Produkt wählen">' + prodOpts + '</select>' +
      '</div>' +
    '</div>';
  }

  /* ---- Lager-Tabelle (Bestand & MHD / /lager) ------------------------------ */
  var _lagerBatches = [];
  var _lagerCanEdit = false;
  var _lagerSort    = { col: 'mhd_date', dir: 'asc' };
  var WRITE_OFF_REASONS = ['MHD abgelaufen', 'Bruch / Beschädigung', 'Schwund', 'Rückruf', 'Sonstiges'];

  function mhdSeverity(days) {
    if (days === null || days === undefined) return 'ok';
    if (days < 0)   return 'critical';
    if (days <= 14) return 'critical';
    if (days <= 30) return 'warning';
    return 'ok';
  }

  function mhdLabel(days) {
    if (days === null || days === undefined) return '—';
    if (days < 0)  return 'Abgelaufen (' + Math.abs(days) + ' Tage)';
    if (days === 0) return 'Heute';
    return 'In ' + days + ' Tag' + (days === 1 ? '' : 'en');
  }

  function sortBatches(batches, col, dir) {
    return batches.slice().sort(function (a, b) {
      var va, vb;
      if (col === 'mhd_date') {
        va = a.mhd_date || 'zzz';
        vb = b.mhd_date || 'zzz';
        return dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
      }
      if (col === 'remaining_qty') {
        va = a.remaining_qty;
        vb = b.remaining_qty;
        return dir === 'asc' ? va - vb : vb - va;
      }
      if (col === 'product_name') {
        va = a.product_name || '';
        vb = b.product_name || '';
        return dir === 'asc' ? va.localeCompare(vb, 'de') : vb.localeCompare(va, 'de');
      }
      return 0;
    });
  }

  function sortArrow(col) {
    if (_lagerSort.col !== col) return '<span class="v3-lager-th__arrow v3-lager-th__arrow--idle">↕</span>';
    return '<span class="v3-lager-th__arrow">' + (_lagerSort.dir === 'asc' ? '↑' : '↓') + '</span>';
  }

  function renderLagerTable(batches) {
    var sorted = sortBatches(batches, _lagerSort.col, _lagerSort.dir);
    var rows = sorted.map(function (b) {
      var sev   = mhdSeverity(b.days_until_mhd);
      var label = mhdLabel(b.days_until_mhd);
      var sevCls = sev === 'critical' ? ' v3-lager-row--crit' : sev === 'warning' ? ' v3-lager-row--warn' : '';
      var tagCls = sev === 'critical' ? 'v3-badge--crit' : sev === 'warning' ? 'v3-badge--warn' : 'v3-badge--ok';
      var mhdDisplay = b.mhd_date
        ? b.mhd_date.split('-').reverse().join('.')
        : '—';
      var batchCount = b.batch_count || 1;
      var writeOffBtn = (_lagerCanEdit && b.batch_key)
        ? '<button type="button" class="v3-lager-row__writeoff" data-writeoff-btn ' +
            'data-batch-key="' + esc(b.batch_key) + '" ' +
            'data-product-name="' + esc(b.product_name) + '" ' +
            'data-remaining="' + b.remaining_qty + '" ' +
            'data-batch-count="' + batchCount + '" ' +
            'title="Aussortieren">×</button>'
        : '';
      return '<tr class="v3-lager-row' + sevCls + '">' +
        '<td class="v3-lager-td v3-lager-td--name">' + esc(b.product_name) + '</td>' +
        '<td class="v3-lager-td v3-lager-td--mhd">' + esc(mhdDisplay) + '</td>' +
        '<td class="v3-lager-td v3-lager-td--days">' +
          '<span class="v3-badge ' + tagCls + '">' + esc(label) + '</span>' +
        '</td>' +
        '<td class="v3-lager-td v3-lager-td--qty">' + b.remaining_qty + ' Stk.</td>' +
        (_lagerCanEdit ? '<td class="v3-lager-td v3-lager-td--action">' + writeOffBtn + '</td>' : '') +
      '</tr>';
    }).join('');

    var actionCol = _lagerCanEdit ? '<th class="v3-lager-th"></th>' : '';
    return '<div class="v3-lager-table-wrap" data-lager-table>' +
      '<table class="v3-lager-table" aria-label="Lagerbestand nach MHD">' +
        '<thead><tr>' +
          '<th class="v3-lager-th v3-lager-th--sortable" data-sort="product_name">Produkt ' + sortArrow('product_name') + '</th>' +
          '<th class="v3-lager-th v3-lager-th--sortable" data-sort="mhd_date">MHD ' + sortArrow('mhd_date') + '</th>' +
          '<th class="v3-lager-th">Dringlichkeit</th>' +
          '<th class="v3-lager-th v3-lager-th--sortable" data-sort="remaining_qty">Lagerbestand ' + sortArrow('remaining_qty') + '</th>' +
          actionCol +
        '</tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table>' +
    '</div>';
  }

  function renderLagerPage(data) {
    var batches = (data && data.batches) || [];
    var total   = batches.length;
    var totalQty = batches.reduce(function (s, b) { return s + b.remaining_qty; }, 0);

    var kpis = '<div class="v3-cockpit-kpis" style="margin-bottom:18px">' +
      '<div class="v3-cockpit-kpi"><span class="v3-cockpit-kpi__label">Chargen</span>' +
        '<span class="v3-cockpit-kpi__value">' + total + '</span></div>' +
      '<div class="v3-cockpit-kpi"><span class="v3-cockpit-kpi__label">Stück gesamt</span>' +
        '<span class="v3-cockpit-kpi__value">' + totalQty + '</span></div>' +
    '</div>';

    return kpis + renderLagerTable(batches);
  }

  function rerenderLagerTable() {
    var wrap = viewEl.querySelector('[data-lager-table]');
    if (!wrap) { return; }
    wrap.outerHTML = renderLagerTable(_lagerBatches);
    bindLagerFilters();
    bindLagerWriteOff();
  }

  function bindLagerFilters() {
    var ths = viewEl.querySelectorAll('[data-sort]');
    ths.forEach(function (th) {
      th.addEventListener('click', function () {
        var col = th.getAttribute('data-sort');
        if (_lagerSort.col === col) {
          _lagerSort.dir = _lagerSort.dir === 'asc' ? 'desc' : 'asc';
        } else {
          _lagerSort.col = col;
          _lagerSort.dir = 'asc';
        }
        rerenderLagerTable();
      });
    });
  }

  /* Aussortieren (Issue #21): Knopf-Delegation auf dem Karten-Grid + Modal.
     Wiederverwendet mountSlotDialog (Portal auf document.body — Pflicht wegen
     transform-Vorfahr) + showSlotToast. Schreibt via POST /api/v2/inventory/write-off. */
  function bindLagerWriteOff() {
    var table = viewEl.querySelector('[data-lager-table]');
    if (!table || !_lagerCanEdit) { return; }
    table.addEventListener('click', function (ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest('[data-writeoff-btn]') : null;
      if (!btn) { return; }
      openWriteOffDialog({
        batch_key:    btn.getAttribute('data-batch-key') || '',
        product_name: btn.getAttribute('data-product-name') || '',
        remaining:    Number(btn.getAttribute('data-remaining')) || 0,
        batch_count:  Number(btn.getAttribute('data-batch-count')) || 1,
      });
    });
  }

  function openWriteOffDialog(info) {
    var reasonOpts = WRITE_OFF_REASONS.map(function (r) {
      return '<option value="' + esc(r) + '">' + esc(r) + '</option>';
    }).join('');
    var multiNote = (info.batch_count > 1)
      ? '<p class="v3-slots-dialog__note" style="color:var(--warn);margin-top:6px">' +
          'Hinweis: ' + info.batch_count + ' Chargen zusammengefasst — es wird nur die älteste ausgebucht. Danach Seite neu laden um die nächste auszubuchen.</p>'
      : '';
    var body = '' +
      '<p class="v3-slots-dialog__eyebrow">Aussortieren</p>' +
      '<p class="v3-slots-dialog__note"><b>' + esc(info.product_name) + '</b> — ' +
        esc(String(info.remaining)) + ' Stk. werden ausgebucht und verschwinden aus dem Bestand.</p>' +
      multiNote +
      '<div class="v3-writeoff__fields">' +
        '<label class="v3-writeoff__label" for="v3-writeoff-reason">Grund</label>' +
        '<select id="v3-writeoff-reason" class="v3-writeoff__select" data-writeoff-reason>' + reasonOpts + '</select>' +
        '<input type="text" class="v3-writeoff__note" data-writeoff-note maxlength="120"' +
          ' placeholder="Notiz (optional, überschreibt den Grund)" aria-label="Notiz" />' +
      '</div>' +
      '<p class="v3-slots-dialog__error" data-writeoff-error hidden></p>' +
      '<div class="v3-slots-dialog__actions">' +
        '<button type="button" class="v3-btn" data-dialog-cancel>Abbrechen</button>' +
        '<button type="button" class="v3-btn v3-btn--brand" data-writeoff-confirm>Ausbuchen bestätigen</button>' +
      '</div>';
    var modal = mountSlotDialog(body, 'Charge aussortieren');
    var card = modal.card;
    var confirmBtn = card.querySelector('[data-writeoff-confirm]');
    var errEl = card.querySelector('[data-writeoff-error]');
    confirmBtn.addEventListener('click', function () {
      var sel  = card.querySelector('[data-writeoff-reason]');
      var note = card.querySelector('[data-writeoff-note]');
      var reason = (note && note.value.trim()) ? note.value.trim() : (sel ? sel.value : '');
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Wird ausgebucht …';
      errEl.hidden = true;
      postJson('/api/v2/inventory/write-off', {
        batch_key: info.batch_key,
        reason: reason,
        expected_remaining_qty: info.remaining,
      }).then(function (res) {
        if (res.ok && res.json && res.json.ok) {
          modal.close();
          showSlotToast((res.json && res.json.message) || (info.product_name + ' ausgebucht.'));
          renderRoute(ROUTE_BY_PATH['/lager']);
        } else {
          errEl.textContent = (res.json && res.json.error && res.json.error.message) ||
            ('Ausbuchen fehlgeschlagen (' + res.status + ').');
          errEl.hidden = false;
          confirmBtn.disabled = false;
          confirmBtn.textContent = 'Ausbuchen bestätigen';
        }
      }).catch(function () {
        errEl.textContent = 'Netzwerkfehler. Bitte erneut versuchen.';
        errEl.hidden = false;
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Ausbuchen bestätigen';
      });
    });
  }

  /* ---- GuV-Seite (Wirtschaftlichkeit / /guv) ---------------------------- */

  /* Zahl-/Datumsformate (de-DE; Tabularziffern kommen aus dem CSS) */
  function fmtEuro(n) { return (Number(n) || 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function fmtPct(n)  { return (Number(n) || 0).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' %'; }
  function fmtInt(n)  { return (Number(n) || 0).toLocaleString('de-DE'); }
  function currentYM() {
    var d = new Date(), m = d.getMonth() + 1;
    return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m;
  }
  var GUV_MON = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
  function monthLabel(ym) {
    var parts = String(ym || '').split('-');
    if (parts.length < 2) { return String(ym || ''); }
    return (GUV_MON[parseInt(parts[1], 10) - 1] || '?') + ' ' + parts[0].slice(2);
  }
  /* Tages-Label: kurz '15.05.' (Achse) bzw. lang '15. Mai' (Tooltip) */
  function dayLabel(ymd, long) {
    var p = String(ymd || '').split('-');
    if (p.length < 3) { return monthLabel(ymd); }
    var d = parseInt(p[2], 10), m = parseInt(p[1], 10);
    if (long) { return d + '. ' + (GUV_MON[m - 1] || ''); }
    return d + '.' + (m < 10 ? '0' : '') + m + '.';
  }
  /* Bucket-Label: erkennt Tages- ('YYYY-MM-DD') vs. Monatsschlüssel ('YYYY-MM') */
  function bucketLabel(key, long) {
    return String(key || '').length > 7 ? dayLabel(key, long) : monthLabel(key);
  }
  /* Heutiges Datum als 'YYYY-MM-DD' (für den taggenauen eigenen Zeitraum) */
  function todayYmd() {
    var d = new Date(), m = d.getMonth() + 1, day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
  }

  /* ---- ISO-Kalenderwochen (Spiegel von lib/economics.js) ----------------- */
  function isoWeekMonday(year, week) {
    var jan4 = new Date(Date.UTC(year, 0, 4));
    var dow = (jan4.getUTCDay() + 6) % 7;            // Mo=0 … So=6
    var mon = new Date(jan4);
    mon.setUTCDate(jan4.getUTCDate() - dow + (week - 1) * 7);
    return mon;
  }
  function isoWeeksInYear(year) {
    var jan1 = new Date(Date.UTC(year, 0, 1)).getUTCDay();
    var leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return (jan1 === 4 || (leap && jan1 === 3)) ? 53 : 52;
  }
  function currentIsoWeek() {
    var t = new Date();
    var d = new Date(Date.UTC(t.getFullYear(), t.getMonth(), t.getDate()));
    var dayNum = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - dayNum + 3);        // nächster Donnerstag = ISO-Wochenjahr
    var firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
    var ft = (firstThu.getUTCDay() + 6) % 7;
    firstThu.setUTCDate(firstThu.getUTCDate() - ft + 3);
    var week = 1 + Math.round((d.getTime() - firstThu.getTime()) / (7 * 86400000));
    return { year: d.getUTCFullYear(), week: week };
  }
  /* Tagesspanne der KW für die Dropdown-Beschriftung. Kompakt, wenn beide Tage
     im selben Monat liegen ("01.–07.06."), sonst mit beiden Monaten. */
  function weekRangeLabel(year, week) {
    var mon = isoWeekMonday(year, week);
    var sun = new Date(mon); sun.setUTCDate(mon.getUTCDate() + 6);
    function dd(x) { return ('0' + x.getUTCDate()).slice(-2); }
    function mm(x) { return ('0' + (x.getUTCMonth() + 1)).slice(-2); }
    if (mon.getUTCMonth() === sun.getUTCMonth()) {
      return dd(mon) + '.–' + dd(sun) + '.' + mm(sun) + '.';
    }
    return dd(mon) + '.' + mm(mon) + '.–' + dd(sun) + '.' + mm(sun) + '.';
  }

  /* Period-State: was die /guv-Seite gerade abfragt */
  var _guvQuery = (function () {
    var now = new Date(), iso = currentIsoWeek();
    return {
      mode: 'month', month: currentYM(), year: now.getFullYear(),
      quarter: Math.floor(now.getMonth() / 3) + 1,
      week: iso.week, weekYear: iso.year,
      from: todayYmd(), to: todayYmd(), /* eigener Zeitraum: taggenau */
      sort: 'revenue_gross', order: 'desc', limit: 10, filter: '', machines: [],
    };
  })();
  var _guvData = null;
  var _guvScope = null; /* { locations: [...], machines: [...] } – einmal geladen */
  var _liveTimer = null; /* Auto-Refresh-Handle der Live-Kachel (in renderRoute aufgeräumt) */
  var _liveReqToken = 0; /* verwirft veraltete Live-Antworten bei schnellem Filterwechsel */
  var _liveListOpen = false; /* Auf/Zu-Zustand der "Letzte Verkäufe"-Box, übersteht Auto-Refresh */
  var LIVE_REFRESH_MS = 30000;

  /* Zeitraum-Parameter (ohne den Maschinen-Filter) – von Daten- und Export-URL geteilt */
  function guvPeriodParams(q) {
    var p = ['mode=' + encodeURIComponent(q.mode)];
    if (q.mode === 'week')         { p.push('year=' + encodeURIComponent(q.weekYear), 'week=' + encodeURIComponent(q.week)); }
    else if (q.mode === 'quarter') { p.push('year=' + encodeURIComponent(q.year), 'quarter=' + encodeURIComponent(q.quarter)); }
    else if (q.mode === 'year')    { p.push('year=' + encodeURIComponent(q.year)); }
    else if (q.mode === 'custom')  { p.push('from=' + encodeURIComponent(q.from), 'to=' + encodeURIComponent(q.to)); }
    else                           { p.push('from=' + encodeURIComponent(q.month), 'to=' + encodeURIComponent(q.month)); }
    if (q.machines && q.machines.length) { p.push('machines=' + encodeURIComponent(q.machines.join(','))); }
    return p;
  }
  function guvBuildUrl(q) {
    return '/api/v2/economics?' + guvPeriodParams(q).join('&');
  }
  function guvExportUrl(q) {
    return '/api/v2/reports/export?' + guvPeriodParams(q).join('&');
  }
  function loadGuvData(q) {
    return fetchJson(guvBuildUrl(q)).then(function (res) { return (res && res.data) ? res.data : null; });
  }

  /* Spiegelung von lib/guv-chart.js::aggregateTopProducts (kein Round-Trip) */
  function guvTopProducts(rows) {
    var byId = {};
    (rows || []).forEach(function (r) {
      var id = Number(r.product_id) || 0;
      var acc = byId[id] || { product_id: id, product_name: null, revenue_net: 0, db_net: 0, revenue_gross: 0, gross_profit: 0, qty: 0, cost_missing: false };
      if (r.product_name != null && r.product_name !== '') { acc.product_name = String(r.product_name); }
      acc.revenue_net   += Number(r.revenue_net)   || 0;
      acc.db_net        += Number(r.db_net)        || 0;
      acc.revenue_gross += Number(r.revenue_gross) || 0;
      acc.gross_profit  += Number(r.gross_profit)  || 0;
      acc.qty           += Number(r.qty)           || 0;
      if (r.cost_missing) { acc.cost_missing = true; } // fehlt für irgendeinen Posten der EK -> Marge „–"
      byId[id] = acc;
    });
    return Object.keys(byId).map(function (k) {
      var p = byId[k];
      var rg = Math.round(p.revenue_gross * 100) / 100;
      var gp = Math.round(p.gross_profit * 100) / 100;
      return {
        product_id: p.product_id,
        product_name: p.product_name != null ? p.product_name : String(p.product_id),
        revenue_net: Math.round(p.revenue_net * 100) / 100,
        db_net: Math.round(p.db_net * 100) / 100,
        revenue_gross: rg, gross_profit: gp, qty: p.qty,
        cost_missing: !!p.cost_missing,
        margin_gross_pct: p.cost_missing ? null : (rg > 0 ? Math.round((gp / rg) * 1000) / 10 : 0),
      };
    });
  }

  /* Spiegelung von lib/guv-chart.js::buildLineSeries, aber mit asymmetrischem
     Rand (links Platz für Y-Achsen-Werte, unten für die Zeit-Labels). */
  function guvLineSeries(series, valueKey, geo) {
    var data = (series || []).map(function (d) { return { month: d.month, value: Number(d[valueKey]) || 0 }; });
    if (data.length === 0) { return { points: [], min: 0, max: 0, path: '', area: '' }; }
    var vals = data.map(function (d) { return d.value; });
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals), span = max - min;
    var innerW = geo.W - geo.padL - geo.padR, innerH = geo.H - geo.padT - geo.padB;
    var top = geo.padT, bottom = geo.H - geo.padB;
    var r2 = function (n) { return Math.round(n * 100) / 100; };
    var yOf = function (v) {
      return span === 0 ? r2(top + innerH / 2) : r2(top + (1 - (v - min) / span) * innerH);
    };
    var points = data.map(function (d, i) {
      var x = data.length === 1 ? r2(geo.padL + innerW / 2) : r2(geo.padL + (i / (data.length - 1)) * innerW);
      return { x: x, y: yOf(d.value), value: d.value, month: d.month };
    });
    var path = 'M' + points.map(function (p) { return p.x + ' ' + p.y; }).join(' L');
    var area = path + ' L' + points[points.length - 1].x + ' ' + bottom + ' L' + points[0].x + ' ' + bottom + ' Z';
    return { points: points, min: min, max: max, span: span, path: path, area: area, yOf: yOf, bottom: bottom };
  }

  /* Ein Zeitreihen-Flächen-/Linienchart (reines SVG) inkl. Y-Achse, Gridlines
     und ausgedünnten X-Labels (für die Tagessicht mit ~30 Punkten). */
  function renderLineChartSvg(series, valueKey, opts) {
    opts = opts || {};
    var W = 340, H = 152;
    var geo = { W: W, H: H, padL: 42, padR: 12, padT: 12, padB: 24 };
    var chart = guvLineSeries(series, valueKey, geo);
    if (chart.points.length === 0) { return '<p class="v3-guv-chart__empty">Keine Daten im Zeitraum</p>'; }
    var fmt = opts.fmt || fmtEuro;
    var color = opts.color || 'var(--brand)';
    var gradId = 'guvgrad-' + (opts.id || valueKey);
    var isPct = /pct/.test(valueKey);
    var axisFmt = function (v) { return isPct ? fmtPct(v) : Math.round(v).toLocaleString('de-DE'); };

    /* Y-Achse: Gridlines + Werte (max / Mitte / min); bei flacher Reihe nur eine */
    var ticks = chart.span === 0 ? [chart.max] : [chart.max, (chart.max + chart.min) / 2, chart.min];
    var grid = ticks.map(function (v) {
      var y = chart.yOf(v);
      return '<line class="v3-guv-grid" x1="' + geo.padL + '" y1="' + y + '" x2="' + (W - geo.padR) + '" y2="' + y + '"/>' +
        '<text class="v3-guv-axisy" x="' + (geo.padL - 6) + '" y="' + (y + 3) + '" text-anchor="end">' + esc(axisFmt(v)) + '</text>';
    }).join('');

    /* Hoverbare Punkte: große transparente Trefferfläche + Punkt + Wert-Tooltip */
    var dots = chart.points.map(function (p) {
      var txt = bucketLabel(p.month, true) + ' · ' + fmt(p.value);
      var tw = Math.max(48, txt.length * 6.4 + 16);
      var tx = Math.min(W - tw / 2 - 2, Math.max(tw / 2 + 2, p.x));
      var ty = Math.max(24, p.y);
      return '<g class="v3-guv-pt">' +
        '<circle class="v3-guv-pt__hit" cx="' + p.x + '" cy="' + p.y + '" r="16"/>' +
        '<circle class="v3-guv-pt__dot" cx="' + p.x + '" cy="' + p.y + '" r="3.4" style="stroke:' + color + '"/>' +
        '<g class="v3-guv-pt__tip" transform="translate(' + tx + ',' + ty + ')">' +
          '<rect x="' + (-tw / 2) + '" y="-30" width="' + tw + '" height="20" rx="6"/>' +
          '<text x="0" y="-16" text-anchor="middle">' + esc(txt) + '</text>' +
        '</g>' +
        '<title>' + esc(txt) + '</title>' +
      '</g>';
    }).join('');

    /* X-Labels ausdünnen, damit Tages-Labels sich nicht überlappen */
    var n = chart.points.length;
    var step = n <= 7 ? 1 : Math.ceil(n / 6);
    var axis = chart.points.map(function (p, i) {
      if (i % step !== 0 && i !== n - 1) { return ''; }
      return '<text class="v3-guv-axis" x="' + p.x + '" y="' + (H - 6) + '" text-anchor="middle">' + esc(bucketLabel(p.month)) + '</text>';
    }).join('');

    return '<svg class="v3-guv-chartsvg" viewBox="0 0 ' + W + ' ' + H + '" role="img" ' +
        'aria-label="' + esc(opts.label || valueKey) + '" style="width:100%;height:auto;display:block;overflow:visible">' +
        '<defs><linearGradient id="' + gradId + '" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0%" stop-color="' + color + '" stop-opacity="0.20"/>' +
          '<stop offset="100%" stop-color="' + color + '" stop-opacity="0"/>' +
        '</linearGradient></defs>' +
        grid +
        '<path class="v3-guv-area" d="' + chart.area + '" fill="url(#' + gradId + ')"/>' +
        '<path class="v3-guv-line" d="' + chart.path + '" fill="none" stroke="' + color + '"/>' +
        dots + axis +
      '</svg>';
  }

  /* Zeitraum-Wähler (Monat / Quartal / Jahr / Eigener) */
  function guvPeriodPicker(q) {
    function btn(mode, label) {
      var active = q.mode === mode;
      return '<button type="button" class="v3-guv-period__btn' + (active ? ' is-active' : '') +
        '" data-period="' + mode + '" aria-pressed="' + (active ? 'true' : 'false') + '">' + label + '</button>';
    }
    var now = new Date(), years = [];
    for (var y = now.getFullYear(); y >= now.getFullYear() - 4; y--) { years.push(y); }
    var yearOpts = years.map(function (yy) { return '<option value="' + yy + '"' + (Number(q.year) === yy ? ' selected' : '') + '>' + yy + '</option>'; }).join('');
    var weekYearOpts = years.map(function (yy) { return '<option value="' + yy + '"' + (Number(q.weekYear) === yy ? ' selected' : '') + '>' + yy + '</option>'; }).join('');
    var qOpts = [1, 2, 3, 4].map(function (n) { return '<option value="' + n + '"' + (Number(q.quarter) === n ? ' selected' : '') + '>Q' + n + '</option>'; }).join('');
    function field(name, visible, inner) {
      return '<label class="v3-guv-field' + (visible ? '' : ' is-hidden') + '" data-field="' + name + '">' + inner + '</label>';
    }
    return '<div class="v3-guv-period v3-card" role="group" aria-label="Zeitraum wählen">' +
      '<div class="v3-guv-period__seg" role="tablist">' +
        btn('week', 'Woche') + btn('month', 'Monat') + btn('quarter', 'Quartal') + btn('year', 'Jahr') + btn('custom', 'Eigener') +
      '</div>' +
      '<div class="v3-guv-period__fields">' +
        field('month',   q.mode === 'month',   '<span>Monat</span><input type="month" data-guv-month value="' + esc(q.month) + '">') +
        field('week',    q.mode === 'week',    '<span>KW</span><span class="v3-guv-weekpick">' +
          '<select class="v3-guv-weekyear" data-guv-week-year aria-label="Jahr der Kalenderwoche">' + weekYearOpts + '</select>' +
          '<select class="v3-guv-weeksel" data-guv-week aria-label="Kalenderwoche">' + guvWeekOptions(q.weekYear, q.week) + '</select>' +
        '</span>') +
        field('quarter', q.mode === 'quarter', '<span>Quartal</span><select data-guv-quarter>' + qOpts + '</select>') +
        field('year',    q.mode === 'quarter' || q.mode === 'year', '<span>Jahr</span><select data-guv-year>' + yearOpts + '</select>') +
        field('from',    q.mode === 'custom',  '<span>Von</span><input type="date" data-guv-from value="' + esc(q.from) + '">') +
        field('to',      q.mode === 'custom',  '<span>Bis</span><input type="date" data-guv-to value="' + esc(q.to) + '">') +
      '</div>' +
      '<div class="v3-guv-period__filter" data-guv-filter-wrap>' + guvFilterControl(q) + '</div>' +
    '</div>';
  }

  /* <option>-Liste aller KW eines Jahres; die gewählte (Default: aktuelle) Woche
     ist selektiert, sodass das native Dropdown beim Öffnen direkt dorthin scrollt. */
  function guvWeekOptions(year, selectedWeek) {
    var yr = Number(year), n = isoWeeksInYear(yr), out = '';
    for (var w = 1; w <= n; w++) {
      out += '<option value="' + w + '"' + (Number(selectedWeek) === w ? ' selected' : '') + '>' +
        'KW ' + (w < 10 ? '0' : '') + w + ' · ' + weekRangeLabel(yr, w) + '</option>';
    }
    return out;
  }

  /* Standort-/Automaten-Mehrfachauswahl (Chips + Dropdown mit Checkboxen).
     Wird auch nach dem Laden von _guvScope per data-guv-filter-wrap neu gerendert. */
  function guvFilterControl(q) {
    var sel = (q.machines || []);
    var scope = _guvScope;
    /* Solange der Auswahlbaum noch nicht (oder nicht) verfügbar ist: dezenter Hinweis. */
    if (!scope || !scope.machines || scope.machines.length === 0) {
      return '<span class="v3-guv-filter__label">Automat</span>' +
        '<span class="v3-guv-filter__summary is-muted">Alle Automaten</span>';
    }
    var selSet = {};
    sel.forEach(function (id) { selSet[id] = true; });
    var summary = sel.length === 0
      ? 'Alle Automaten'
      : (sel.length === 1
          ? (guvMachineLabel(sel[0]) )
          : sel.length + ' Automaten');

    function checkbox(id, label, sub, cls) {
      var on = !!selSet[id];
      return '<label class="v3-guv-opt' + (cls ? ' ' + cls : '') + (on ? ' is-on' : '') + '">' +
        '<input type="checkbox" ' + (on ? 'checked ' : '') + 'data-guv-mid="' + esc(id) + '">' +
        '<span class="v3-guv-opt__txt">' + esc(label) + (sub ? '<span class="v3-guv-opt__sub">' + esc(sub) + '</span>' : '') + '</span>' +
      '</label>';
    }

    var locItems = (scope.locations || []).filter(function (l) { return l.machine_ids && l.machine_ids.length; })
      .map(function (l) {
        var all = l.machine_ids.every(function (id) { return selSet[id]; });
        return '<label class="v3-guv-opt v3-guv-opt--loc' + (all && l.machine_ids.length ? ' is-on' : '') + '">' +
          '<input type="checkbox" ' + (all ? 'checked ' : '') + 'data-guv-loc="' + esc(l.machine_ids.join(',')) + '">' +
          '<span class="v3-guv-opt__txt">' + esc(l.name) + '<span class="v3-guv-opt__sub">' + l.machine_ids.length + ' Automaten</span></span>' +
        '</label>';
      }).join('');
    var macItems = (scope.machines || []).map(function (m) {
      return checkbox(m.machine_id, m.label || m.machine_id, m.location_name || null, 'v3-guv-opt--mac');
    }).join('');

    return '<span class="v3-guv-filter__label">Automat</span>' +
      '<details class="v3-guv-filter" data-guv-filterbox>' +
        '<summary class="v3-guv-filter__summary">' + esc(summary) +
          (sel.length ? '<button type="button" class="v3-guv-filter__clear" data-guv-clear aria-label="Auswahl zurücksetzen">×</button>' : '') +
        '</summary>' +
        '<div class="v3-guv-filter__panel">' +
          (locItems ? '<p class="v3-guv-filter__group">Standorte</p>' + locItems : '') +
          (macItems ? '<p class="v3-guv-filter__group">Automaten</p>' + macItems : '') +
        '</div>' +
      '</details>';
  }

  function guvMachineLabel(id) {
    if (_guvScope && _guvScope.machines) {
      for (var i = 0; i < _guvScope.machines.length; i++) {
        if (_guvScope.machines[i].machine_id === id) { return _guvScope.machines[i].label || id; }
      }
    }
    return id;
  }

  /* KPI-Strip mit den Totalen des Zeitraums (Brutto wie Legacy).
     #40: Umsatz + Stück schließen den laufenden Tag ein (aus sales_transactions),
     GuV/Marge zusätzlich via Live-FIFO. Gewinn/Marge stammen NUR aus Posten mit
     bekanntem EK; fehlt für Posten der EK, fließen sie NICHT in GuV/Marge ein
     (kein geschätzter Wert) und es erscheint ein Warnhinweis. */
  function guvKpiStrip(data) {
    data = data || {};
    var totals = data.totals || {};
    var prov = data.provisional || { hasProvisional: false };
    var withProv = data.totalsWithProvisional || totals;
    var hasProv = !!prov.hasProvisional;
    var costMissing = !!data.costMissing;

    var umsatzVal = hasProv ? withProv.revenue_gross : totals.revenue_gross;
    var stueckVal = hasProv ? withProv.qty : totals.qty;
    var guvVal    = withProv.gross_profit != null ? withProv.gross_profit : totals.gross_profit;
    // Marge-Nenner = nur „costable" Umsatz (gleiche Posten wie der GuV-Zähler).
    var margeRev  = withProv.revenue_gross_costable != null ? withProv.revenue_gross_costable : (withProv.revenue_gross != null ? withProv.revenue_gross : totals.revenue_gross);
    var marge     = Number(margeRev) > 0 ? (guvVal / margeRev) * 100 : 0;

    var umsatzHint = hasProv ? 'inkl. heute: +' + fmtEuro(prov.revenueGross) + ' €' : '';
    var stueckHint = hasProv ? 'inkl. heute: +' + fmtInt(prov.qty) : '';
    var guvHint    = (hasProv && Number(prov.grossProfit) > 0) ? 'inkl. heute: +' + fmtEuro(prov.grossProfit) + ' €' : '';
    // Bei fehlendem EK: GuV/Marge sind unvollständig -> ehrlich kennzeichnen.
    var margeHint  = costMissing ? '⚠ EK fehlt – unvollständig' : '';
    if (costMissing && !guvHint) { guvHint = '⚠ EK fehlt'; }

    function kpi(label, value, unit, hint, warn) {
      return '<div class="v3-cockpit-kpi">' +
        '<span class="v3-cockpit-kpi__label">' + label + '</span>' +
        '<span class="v3-cockpit-kpi__value">' + value + (unit ? '<span class="v3-cockpit-kpi__unit"> ' + unit + '</span>' : '') + '</span>' +
        (hint ? '<span class="v3-guv-kpi__prov' + (warn ? ' v3-guv-kpi__warn' : '') + '">' + hint + '</span>' : '') +
      '</div>';
    }
    return '<div class="v3-cockpit-kpis v3-guv-kpis">' +
      kpi('Umsatz (brutto)', fmtEuro(umsatzVal), 'EUR', umsatzHint, false) +
      kpi('GuV (brutto)', fmtEuro(guvVal), 'EUR', guvHint, costMissing) +
      kpi('Marge', fmtPct(marge), '', margeHint, costMissing) +
      kpi('Stück', fmtInt(stueckVal), '', stueckHint, false) +
    '</div>';
  }

  /* Warnbanner: aktive Lagerchargen ohne Einkaufspreis. Macht die Datenlücke
     sichtbar, damit der User den EK (aus der gescannten Rechnung) nachträgt –
     erst dann sind GuV/Marge der betroffenen Produkte korrekt. */
  function guvMissingCostBanner(data) {
    var list = (data && data.missingCostBatches) || [];
    if (!list.length) { return ''; }
    var names = list.map(function (b) {
      var n = b.product_name || ('#' + b.product_id);
      return '<li><strong>' + esc(n) + '</strong>' + (b.batch_key ? ' <span class="v3-guv-missing__batch">' + esc(b.batch_key) + '</span>' : '') + '</li>';
    }).join('');
    return '<section class="v3-guv-missing" role="alert">' +
      '<p class="v3-guv-missing__head">⚠ Einkaufspreis fehlt für ' + list.length + ' Lagercharge' + (list.length === 1 ? '' : 'n') +
        ' – GuV &amp; Marge dieser Produkte sind unvollständig.</p>' +
      '<ul class="v3-guv-missing__list">' + names + '</ul>' +
      '<p class="v3-guv-missing__hint">Bitte den Einkaufspreis der Charge (aus der Rechnung) nachtragen, damit die Werte stimmen.</p>' +
    '</section>';
  }

  /* Alle Tagesschlüssel ('YYYY-MM-DD') des Zeitraums – die X-Achse ist damit
     vorgegeben (z. B. alle Tage des Monats), nicht nur die Tage mit Verkäufen. */
  function guvPeriodDays(period) {
    if (!period || !period.from || !period.to) { return []; }
    var from = String(period.from), to = String(period.to);
    if (from.length === 7) { // 'YYYY-MM' (Einzelmonat) -> alle Tage des Monats
      var pp = from.split('-'), y = +pp[0], mo = +pp[1];
      var n = new Date(Date.UTC(y, mo, 0)).getUTCDate();
      var out = [];
      for (var d = 1; d <= n; d++) { out.push(from + '-' + (d < 10 ? '0' : '') + d); }
      return out;
    }
    var arr = [], cur = new Date(from + 'T00:00:00Z'), end = new Date(to + 'T00:00:00Z');
    while (cur <= end && arr.length < 400) {
      arr.push(cur.toISOString().slice(0, 10));
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return arr;
  }

  /* Runde Obergrenze für die Y-Achse, damit die Gitterlinien glatte Werte tragen
     (z. B. 31 -> 40, Schritte 0/10/20/30/40). */
  function guvNiceMax(v) {
    if (!(v > 0)) { return 1; }
    var rawStep = v / 4;
    var p = Math.pow(10, Math.floor(Math.log10(rawStep)));
    var n = rawStep / p;
    var step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
    return step * 4;
  }

  /* Balkendiagramm über den vorgegebenen Tages-Zeitraum. Sinnvoll für Tages-
     granularität (Monat/Woche/eigener Zeitraum) – auch ein einzelner Tag ist als
     Balken klar lesbar (statt sinnlosem Ein-Punkt-Linienchart). Y-Achse mit
     runden Gitterlinien, jeder Balken mit Hover-Tooltip (Datum + exakter Wert). */
  function renderBarChartSvg(series, valueKey, opts, days) {
    opts = opts || {};
    var byDay = {};
    (series || []).forEach(function (d) { byDay[d.month] = Number(d[valueKey]) || 0; });
    var keys = (days && days.length) ? days : (series || []).map(function (d) { return d.month; });
    if (keys.length === 0) { return '<p class="v3-guv-chart__empty">Keine Daten im Zeitraum</p>'; }

    var W = 340, H = 152, padL = 42, padR = 12, padT = 12, padB = 24;
    var innerW = W - padL - padR, innerH = H - padT - padB, base = H - padB;
    var isPct = /pct/.test(valueKey);
    var fmt = opts.fmt || fmtEuro;
    var color = opts.color || 'var(--brand)';

    var dataMax = keys.reduce(function (m, k) { return Math.max(m, byDay[k] || 0); }, 0);
    var maxY = isPct ? Math.max(100, guvNiceMax(dataMax)) : guvNiceMax(dataMax);
    var ticks = isPct
      ? [0, 20, 40, 60, 80, 100].filter(function (t) { return t <= maxY; })
      : [0, 0.25, 0.5, 0.75, 1].map(function (f) { return Math.round(maxY * f); });
    if (ticks[ticks.length - 1] < maxY) { ticks.push(maxY); }
    var yOf = function (v) { return base - (maxY > 0 ? (v / maxY) * innerH : 0); };
    var axisFmt = function (v) { return isPct ? (v + ' %') : Math.round(v).toLocaleString('de-DE'); };

    var grid = ticks.map(function (v) {
      var y = Math.round(yOf(v) * 100) / 100;
      return '<line class="v3-guv-grid" x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '"/>' +
        '<text class="v3-guv-axisy" x="' + (padL - 6) + '" y="' + (y + 3) + '" text-anchor="end">' + esc(axisFmt(v)) + '</text>';
    }).join('');

    var slot = innerW / keys.length;
    var barW = Math.min(46, Math.max(3, slot * 0.62));
    var n = keys.length;
    var step = n <= 10 ? 1 : Math.ceil(n / 8);

    var bars = keys.map(function (k, i) {
      var v = byDay[k] || 0;
      var cx = padL + slot * (i + 0.5);
      var x = cx - barW / 2;
      var h = Math.max(0, base - yOf(v));
      var y = base - h;
      var txt = bucketLabel(k, true) + ' · ' + fmt(v);
      var tw = Math.max(48, txt.length * 6.4 + 16);
      var tx = Math.min(W - tw / 2 - 2, Math.max(tw / 2 + 2, cx));
      var ty = Math.max(24, y);
      return '<g class="v3-guv-pt v3-guv-barg">' +
        '<rect class="v3-guv-pt__hit" x="' + (cx - slot / 2) + '" y="' + padT + '" width="' + slot + '" height="' + (base - padT) + '"/>' +
        '<rect class="v3-guv-bar" x="' + x + '" y="' + y + '" width="' + barW + '" height="' + h + '" rx="' + Math.min(3, barW / 2) + '" style="fill:' + color + '"/>' +
        '<g class="v3-guv-pt__tip" transform="translate(' + tx + ',' + ty + ')">' +
          '<rect x="' + (-tw / 2) + '" y="-30" width="' + tw + '" height="20" rx="6"/>' +
          '<text x="0" y="-16" text-anchor="middle">' + esc(txt) + '</text>' +
        '</g>' +
        '<title>' + esc(txt) + '</title>' +
      '</g>';
    }).join('');

    // Jeden step-ten Tag beschriften; das letzte Label nur, wenn es nicht direkt
    // an einem schon beschrifteten klebt (sonst Überlappung „29./30.").
    var lastShown = n - 1;
    while (lastShown > 0 && lastShown % step !== 0) { lastShown--; }
    var axis = keys.map(function (k, i) {
      var show = (i % step === 0) || (i === n - 1 && (n - 1 - lastShown) >= step);
      if (!show) { return ''; }
      return '<text class="v3-guv-axis" x="' + (padL + slot * (i + 0.5)) + '" y="' + (H - 6) + '" text-anchor="middle">' + esc(bucketLabel(k)) + '</text>';
    }).join('');

    return '<svg class="v3-guv-chartsvg" viewBox="0 0 ' + W + ' ' + H + '" role="img" ' +
        'aria-label="' + esc(opts.label || valueKey) + '" style="width:100%;height:auto;display:block;overflow:visible">' +
        grid + '<line class="v3-guv-baseline" x1="' + padL + '" y1="' + base + '" x2="' + (W - padR) + '" y2="' + base + '"/>' +
        bars + axis +
      '</svg>';
  }

  /* Abgerundete Balken-Oberkante (nur oben gerundet) als SVG-Pfad. */
  function roundedTopBar(x, y, w, h, r) {
    if (h <= 0) { return 'M' + x + ' ' + y + ' h' + w + ' h' + (-w) + ' Z'; }
    r = Math.min(r, h, w / 2);
    return 'M' + x + ' ' + (y + h) +
      ' L' + x + ' ' + (y + r) +
      ' Q' + x + ' ' + y + ' ' + (x + r) + ' ' + y +
      ' L' + (x + w - r) + ' ' + y +
      ' Q' + (x + w) + ' ' + y + ' ' + (x + w) + ' ' + (y + r) +
      ' L' + (x + w) + ' ' + (y + h) + ' Z';
  }

  /* Spiegelt lib/guv-chart.js buildStackedBars: je Periode Umsatz = Wareneinsatz
     (unten) + Gewinn (oben), Gewinn auf [0,total] gedeckelt. */
  function guvStackedBars(series) {
    return (series || []).map(function (d) {
      var total = Number(d.revenue_gross) || 0;
      var raw = Number(d.gross_profit) || 0;
      var profit = Math.max(0, Math.min(raw, total));
      return { month: d.month, total: total, profit: profit, cost: Math.max(0, total - profit), margin: Number(d.margin_gross_pct) || 0 };
    });
  }

  /* Kombi-Chart (Monats-/Jahresvergleich): gestapelte Balken (Wareneinsatz +
     Gewinn) auf der linken €-Achse + Marge-Overlay-Linie auf der rechten %-Achse.
     Tooltips liegen in einer ZULETZT gezeichneten Overlay-Ebene (immer oben). */
  function renderComboChartSvg(series, opts) {
    opts = opts || {};
    var rows = guvStackedBars(series);
    if (!rows.length) { return '<p class="v3-guv-chart__empty">Keine Daten im Zeitraum</p>'; }
    var W = 340, H = 160, padL = 42, padR = 34, padT = 14, padB = 24;
    var innerW = W - padL - padR, innerH = H - padT - padB, base = H - padB;
    var r2 = function (n) { return Math.round(n * 100) / 100; };
    var maxY = guvNiceMax(rows.reduce(function (m, r) { return Math.max(m, r.total); }, 0));
    var maxM = Math.max(guvNiceMax(rows.reduce(function (m, r) { return Math.max(m, r.margin); }, 0)), 1);
    var yOf = function (v) { return base - (maxY > 0 ? (v / maxY) * innerH : 0); };
    var yM = function (v) { return base - (maxM > 0 ? (v / maxM) * innerH : 0); };

    var grid = [0, 0.25, 0.5, 0.75, 1].map(function (f) {
      var v = Math.round(maxY * f), y = r2(yOf(v));
      return '<line class="v3-guv-grid" x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '"/>' +
        '<text class="v3-guv-axisy" x="' + (padL - 6) + '" y="' + (y + 3) + '" text-anchor="end">' + esc(v.toLocaleString('de-DE')) + '</text>';
    }).join('');
    var raxis = [0, 0.5, 1].map(function (f) {
      var v = Math.round(maxM * f), y = r2(yM(v));
      return '<text class="v3-guv-axisy v3-guv-axisy--right" x="' + (W - padR + 6) + '" y="' + (y + 3) + '" text-anchor="start">' + v + ' %</text>';
    }).join('');

    var slot = innerW / rows.length;
    var barW = Math.min(40, Math.max(3, slot * 0.6));
    var rTop = Math.min(4, barW / 2);
    var bars = rows.map(function (r, i) {
      var cx = padL + slot * (i + 0.5), x = r2(cx - barW / 2);
      var yCost = r2(yOf(r.cost)), hCost = r2(Math.max(0, base - yCost));
      var yTop = r2(yOf(r.total)), hProfit = r2(Math.max(0, yCost - yTop));
      return '<rect class="v3-guv-bar v3-guv-bar--cost" x="' + x + '" y="' + yCost + '" width="' + r2(barW) + '" height="' + hCost + '"/>' +
        '<path class="v3-guv-bar v3-guv-bar--profit" d="' + roundedTopBar(x, yTop, r2(barW), hProfit, rTop) + '"/>';
    }).join('');

    // Marge nur für Buckets mit Umsatz (>0) – keine 0-%-Linie über leere Perioden.
    var pts = [];
    rows.forEach(function (r, i) { if (r.total > 0) { pts.push({ x: r2(padL + slot * (i + 0.5)), y: r2(yM(r.margin)) }); } });
    var mline = pts.length ? '<path class="v3-guv-line v3-guv-line--margin" d="M' + pts.map(function (p) { return p.x + ' ' + p.y; }).join(' L') + '" fill="none"/>' : '';
    var markers = pts.map(function (p) { return '<circle class="v3-guv-pt__dot v3-guv-dot--margin" cx="' + p.x + '" cy="' + p.y + '" r="2.6"/>'; }).join('');

    var n = rows.length, step = n <= 12 ? 1 : Math.ceil(n / 8);
    // Letztes Label nur zeigen, wenn es nicht direkt am vorigen klebt (sonst „29.30.").
    var lastShown = n - 1;
    while (lastShown > 0 && lastShown % step !== 0) { lastShown--; }
    var axis = rows.map(function (r, i) {
      var show = (i % step === 0) || (i === n - 1 && (n - 1 - lastShown) >= step);
      if (!show) { return ''; }
      return '<text class="v3-guv-axis" x="' + r2(padL + slot * (i + 0.5)) + '" y="' + (H - 6) + '" text-anchor="middle">' + esc(bucketLabel(r.month)) + '</text>';
    }).join('');

    // Interaktions-Overlay (zuletzt gezeichnet -> immer über Balken/Linie):
    // je Balken getrennte Treffer für Wareneinsatz, Gewinn und Marge. Hover
    // (Desktop), Fokus (Tastatur) oder Tipp (Touch, .is-tapped) heben das Segment
    // hervor und zeigen GENAU einen Wert.
    function tipNode(cx, anchorY, text) {
      var tw = Math.max(54, text.length * 6.0 + 16);
      var tx = Math.min(W - tw / 2 - 2, Math.max(tw / 2 + 2, cx)), ty = Math.max(24, anchorY);
      return '<g class="v3-guv-pt__tip" transform="translate(' + r2(tx) + ',' + r2(ty) + ')">' +
        '<rect x="' + r2(-tw / 2) + '" y="-30" width="' + r2(tw) + '" height="20" rx="6"/>' +
        '<text x="0" y="-16" text-anchor="middle">' + esc(text) + '</text>' +
      '</g>';
    }
    function segNode(text, hit, hl, cx, anchorY, extraClass) {
      return '<g class="v3-guv-seg' + (extraClass ? ' ' + extraClass : '') + '" data-guv-seg tabindex="0" role="button" aria-label="' + esc(text) + '">' +
        hit + hl + tipNode(cx, anchorY, text) + '<title>' + esc(text) + '</title>' +
      '</g>';
    }
    var tips = rows.map(function (r, i) {
      var cx = padL + slot * (i + 0.5), x = r2(cx - barW / 2), bw = r2(barW);
      var yCost = r2(yOf(r.cost)), hCost = r2(Math.max(0, base - yCost));
      var yTop = r2(yOf(r.total)), hProfit = r2(Math.max(0, yCost - yTop));
      var per = bucketLabel(r.month, true);
      var out = '';
      if (hCost > 0.5) {
        out += segNode(per + ' · Wareneinsatz ' + fmtEuro(r.cost) + ' €',
          '<rect class="v3-guv-seg__hit" x="' + r2(cx - slot / 2) + '" y="' + yCost + '" width="' + r2(slot) + '" height="' + hCost + '"/>',
          '<rect class="v3-guv-seg__hl" x="' + x + '" y="' + yCost + '" width="' + bw + '" height="' + hCost + '"/>',
          cx, yCost);
      }
      if (hProfit > 0.5) {
        out += segNode(per + ' · Gewinn ' + fmtEuro(r.profit) + ' €',
          '<rect class="v3-guv-seg__hit" x="' + r2(cx - slot / 2) + '" y="' + yTop + '" width="' + r2(slot) + '" height="' + hProfit + '"/>',
          '<path class="v3-guv-seg__hl" d="' + roundedTopBar(x, yTop, bw, hProfit, rTop) + '"/>',
          cx, yTop);
      }
      if (r.total > 0) {
        var my = r2(yM(r.margin));
        out += segNode(per + ' · Marge ' + fmtPct(r.margin),
          '<circle class="v3-guv-seg__hit" cx="' + r2(cx) + '" cy="' + my + '" r="11"/>',
          '<circle class="v3-guv-seg__hl v3-guv-seg__hl--margin" cx="' + r2(cx) + '" cy="' + my + '" r="5"/>',
          cx, my, 'v3-guv-seg--margin');
      }
      return out;
    }).join('');

    return '<svg class="v3-guv-chartsvg" viewBox="0 0 ' + W + ' ' + H + '" role="img" ' +
        'aria-label="' + esc(opts.label || 'Umsatz, Wareneinsatz und Marge') + '" style="width:100%;height:auto;display:block;overflow:visible">' +
        grid + raxis +
        '<line class="v3-guv-baseline" x1="' + padL + '" y1="' + base + '" x2="' + (W - padR) + '" y2="' + base + '"/>' +
        bars + mline + markers + axis + tips +
      '</svg>';
  }

  /* Ein kombiniertes Diagramm über ALLE Zeiträume (einheitlicher Stil): gestapelte
     Balken (Wareneinsatz + Gewinn) + Marge-Overlay-Linie. Nur die X-Achse
     unterscheidet Tag/Woche vs. Monat/Quartal/Jahr. */
  function guvChartsPanel(data) {
    var series = (data && data.series) || [];
    // Nur vorhandene Buckets zeigen (keine Null-Tage auffüllen) – einheitlich für
    // alle Granularitäten. Verhindert die irritierende 0-%-Marge-Linie über
    // verkaufsfreie Tage; gezeigt wird nur, was tatsächlich da ist.
    var svg = renderComboChartSvg(series, { label: 'Umsatz, Wareneinsatz und Marge je Periode' });
    var legend = '<div class="v3-guv-legend">' +
      '<span class="v3-guv-leg v3-guv-leg--cost">Wareneinsatz</span>' +
      '<span class="v3-guv-leg v3-guv-leg--profit">Gewinn</span>' +
      '<span class="v3-guv-leg v3-guv-leg--margin">Marge</span>' +
    '</div>';
    var hint = '<p class="v3-guv-chart__hint">Segment antippen oder mit der Maus berühren – zeigt den Einzelwert.</p>';
    var cards = [
      '<section class="v3-guv-chart v3-card" aria-label="Umsatz, Wareneinsatz und Marge">' +
        '<p class="v3-guv-chart__title">Umsatz, Wareneinsatz &amp; Marge</p>' + legend + svg + hint +
      '</section>',
    ];
    // Punkt-Indikatoren nur bei mehreren Charts (data-guv-cardot bleibt für die
    // Karussell-Logik im Quelltext erhalten).
    var dots = cards.length > 1
      ? cards.map(function (_, i) {
          return '<button type="button" class="v3-guv-cardot' + (i === 0 ? ' is-active' : '') +
            '" data-guv-cardot="' + i + '" aria-label="Diagramm ' + (i + 1) + ' anzeigen"></button>';
        }).join('')
      : '';
    return '<div class="v3-guv-chartsblock">' +
      '<div class="v3-guv-charts" data-guv-charts>' + cards.join('') + '</div>' +
      '<div class="v3-guv-cardots" data-guv-cardots>' + dots + '</div>' +
    '</div>';
  }

  /* Top-N-Tabelle: filtern, sortieren, begrenzen (clientseitig) */
  function guvComputeRows(byProduct, q) {
    var rows = guvTopProducts(byProduct);
    var f = (q.filter || '').trim().toLowerCase();
    if (f) { rows = rows.filter(function (r) { return r.product_name.toLowerCase().indexOf(f) >= 0; }); }
    var key = q.sort || 'revenue_gross', dir = q.order === 'asc' ? 1 : -1;
    rows.sort(function (a, b) { var av = a[key] || 0, bv = b[key] || 0; return (av < bv ? -1 : av > bv ? 1 : 0) * dir; });
    if (q.limit === 'all') { return rows; }
    return rows.slice(0, Number(q.limit) || 10);
  }
  /* Marge-Zelle: bei fehlendem EK (Kosten ~0 trotz Umsatz) ehrlich „–" statt
     einer unplausiblen 100-%-Marge. */
  function guvMargeCell(r) {
    var cost = (Number(r.revenue_gross) || 0) - (Number(r.gross_profit) || 0);
    var missing = r.cost_missing || r.margin_gross_pct == null || (Number(r.revenue_gross) > 0 && cost <= 0.005);
    if (missing) {
      return '<td class="v3-guv-table__num v3-guv-table__na" title="Einkaufspreis fehlt – Marge nicht berechenbar; bitte EK der Lagercharge nachtragen">–</td>';
    }
    return '<td class="v3-guv-table__num">' + fmtPct(r.margin_gross_pct) + '</td>';
  }
  function guvRowsHtml(rows) {
    if (!rows.length) { return '<tr><td colspan="5" class="v3-guv-table__empty">Keine Treffer</td></tr>'; }
    return rows.map(function (r) {
      return '<tr>' +
        '<td class="v3-guv-table__name">' + esc(r.product_name) + '</td>' +
        '<td class="v3-guv-table__num">' + fmtEuro(r.revenue_gross) + '</td>' +
        '<td class="v3-guv-table__num">' + fmtEuro(r.gross_profit) + '</td>' +
        guvMargeCell(r) +
        '<td class="v3-guv-table__num">' + fmtInt(r.qty) + '</td>' +
      '</tr>';
    }).join('');
  }
  function renderGuvTableEl(byProduct, q) {
    var rows = guvComputeRows(byProduct, q);
    function th(label, key) {
      var active = q.sort === key;
      var arrow = active ? '<span class="v3-guv-sort__arr">' + (q.order === 'asc' ? '▲' : '▼') + '</span>' : '';
      return '<th class="v3-guv-table__num"><button type="button" class="v3-guv-sort' + (active ? ' is-active' : '') +
        '" data-guv-sort="' + key + '">' + label + arrow + '</button></th>';
    }
    return '<table class="v3-guv-table v2-kpi-table">' +
      '<thead><tr>' +
        '<th>Produkt</th>' +
        th('Umsatz brutto', 'revenue_gross') + th('GuV brutto', 'gross_profit') +
        th('Marge', 'margin_gross_pct') + th('Stück', 'qty') +
      '</tr></thead>' +
      '<tbody>' + guvRowsHtml(rows) + '</tbody>' +
    '</table>';
  }
  function guvTable(byProduct, q) {
    return '<section class="v3-card v3-guv-tablecard" aria-label="Top-Produkte im Zeitraum">' +
      '<div class="v3-guv-tablebar">' +
        '<p class="v3-guv-tablecard__title">Top-Produkte im Zeitraum</p>' +
        '<div class="v3-guv-tablebar__controls">' +
          '<input type="search" class="v3-guv-search" data-guv-filter placeholder="Produkt filtern …" value="' + esc(q.filter || '') + '" aria-label="Produkt filtern">' +
          '<select class="v3-guv-limit v3-filter-select" data-guv-limit aria-label="Anzahl Zeilen">' +
            [5, 10, 20, 50].map(function (n) { return '<option value="' + n + '"' + (Number(q.limit) === n ? ' selected' : '') + '>Top ' + n + '</option>'; }).join('') +
            '<option value="all"' + (q.limit === 'all' ? ' selected' : '') + '>Alle</option>' +
          '</select>' +
          '<div class="v3-guv-export" role="group" aria-label="Bericht exportieren">' +
            '<button type="button" class="v3-guv-export__btn" data-guv-export="csv" title="Als CSV/Excel herunterladen">' +
              ICONS.export + '<span>Excel</span></button>' +
            '<button type="button" class="v3-guv-export__btn" data-guv-export="pdf" title="Als PDF speichern (Druckdialog)">' +
              ICONS.print + '<span>PDF</span></button>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="v3-guv-tablewrap" data-guv-tablewrap>' + renderGuvTableEl(byProduct, q) + '</div>' +
    '</section>';
  }

  /* Tages-Label inkl. Jahr für taggenaue Zeiträume: '3. Jun 26' */
  function dayLabelYear(ymd) {
    var pp = String(ymd || '').split('-');
    if (pp.length < 3) { return monthLabel(ymd); }
    return parseInt(pp[2], 10) + '. ' + (GUV_MON[parseInt(pp[1], 10) - 1] || '') + ' ' + pp[0].slice(2);
  }
  /* Lesbares Label einer Periode (monats- oder taggenau, erkannt an der Länge) */
  function periodLabel(p) {
    if (!p || !p.from || !p.to) { return ''; }
    var isDay = String(p.from).length > 7;
    var fmt = isDay ? dayLabelYear : monthLabel;
    return p.from === p.to ? fmt(p.from) : fmt(p.from) + ' – ' + fmt(p.to);
  }
  /* Sichtbares Label des tatsächlich geladenen Zeitraums (Feedback nach Wechsel) */
  function guvRangeCaption(data) {
    var label = periodLabel(data && data.period);
    if (!label) { return ''; }
    return '<p class="v3-guv-range">Zeitraum: <strong>' + esc(label) + '</strong></p>';
  }

  function renderGuvBody(data, q) {
    var series    = (data && data.series)    || [];
    var byProduct = (data && data.byProduct) || [];
    if (series.length === 0) {
      return guvRangeCaption(data) + guvMissingCostBanner(data) + guvKpiStrip(data) +
        renderState('empty', { message: 'Für den gewählten Zeitraum liegen keine Umsätze vor.' });
    }
    return guvRangeCaption(data) + guvMissingCostBanner(data) + guvKpiStrip(data) + guvChartsPanel(data) + guvTable(byProduct, q);
  }

  /* ---- Live-Umsatz (quasi-live) ---------------------------------------- */
  /* Eigene Kachel oben auf der GuV-Seite. Liest /api/v2/economics/live
     (sales_transactions, von WF3 befüllt) und aktualisiert sich alle 30 s
     selbst. Bewusst getrennt von der GuV-Periodenauswertung darunter. */

  function liveTimeHHMM(iso) {
    if (!iso) { return '—'; }
    var d = new Date(iso);
    if (isNaN(d.getTime())) { return '—'; }
    return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  }

  function liveAgoText(iso) {
    if (!iso) { return 'noch kein Verkauf heute'; }
    var d = new Date(iso);
    if (isNaN(d.getTime())) { return ''; }
    var sec = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
    if (sec < 60) { return 'letzter Verkauf gerade eben'; }
    var min = Math.round(sec / 60);
    if (min < 60) { return 'letzter Verkauf vor ' + min + ' Min'; }
    var h = Math.round(min / 60);
    if (h < 24) { return 'letzter Verkauf vor ' + h + ' Std'; }
    return 'letzter Verkauf ' + liveTimeHHMM(iso) + ' Uhr';
  }

  function liveKpis(today) {
    today = today || {};
    function kpi(label, value, unit) {
      return '<div class="v3-cockpit-kpi">' +
        '<span class="v3-cockpit-kpi__label">' + label + '</span>' +
        '<span class="v3-cockpit-kpi__value">' + value + (unit ? '<span class="v3-cockpit-kpi__unit"> ' + unit + '</span>' : '') + '</span>' +
      '</div>';
    }
    return '<div class="v3-cockpit-kpis v3-live__kpis">' +
      kpi('Umsatz heute', fmtEuro(today.umsatzBrutto), 'EUR') +
      kpi('Verkäufe', fmtInt(today.verkaeufe), '') +
      kpi('Stück', fmtInt(today.stueck), '') +
    '</div>';
  }

  /* "Letzte Verkäufe" als ausklappbare Box (natives <details>), standardmäßig
     eingeklappt. _liveListOpen bewahrt den Zustand über den Auto-Refresh hinweg. */
  function liveList(recent) {
    recent = recent || [];
    var count = recent.length;
    var inner = count
      ? '<ul class="v3-live__list">' + recent.map(function (r) {
          return '<li class="v3-live__row">' +
            '<span class="v3-live__time">' + esc(liveTimeHHMM(r.settlementAt)) + '</span>' +
            '<span class="v3-live__prod">' + esc(r.product || '–') + '</span>' +
            '<span class="v3-live__qty">×' + fmtInt(r.quantity) + '</span>' +
            '<span class="v3-live__amt">' + fmtEuro(r.grossAmount) + ' €</span>' +
          '</li>';
        }).join('') + '</ul>'
      : '<p class="v3-live__empty">Noch keine Verkäufe.</p>';
    return '<details class="v3-live__details" data-live-details' + (_liveListOpen ? ' open' : '') + '>' +
      '<summary class="v3-live__summary">Letzte Verkäufe' + (count ? ' (' + count + ')' : '') + '</summary>' +
      inner +
    '</details>';
  }

  /* Innerer Inhalt der Kachel je nach Zustand (loading/error/ok). */
  function liveTileInner(state) {
    if (state.loading) {
      return '<div class="v3-live__body" data-live-body>' +
        '<p class="v3-live__loading">Live-Daten werden geladen …</p></div>';
    }
    if (state.error) {
      return '<div class="v3-live__body" data-live-body>' +
        '<p class="v3-live__error">Live-Daten nicht verfügbar.</p></div>';
    }
    var d = state.data || {};
    return '<div class="v3-live__body" data-live-body>' +
      liveKpis(d.today) +
      liveList(d.recent) +
    '</div>';
  }

  /* Toggle-Zustand der Verkaufsliste merken, damit ein Auto-Refresh die Box
     nicht wieder zuklappt. Neu gebunden nach jedem Render (Element ist frisch). */
  function wireLiveDetails() {
    var d = viewEl.querySelector('[data-live-details]');
    if (d) { d.addEventListener('toggle', function () { _liveListOpen = d.open; }); }
  }

  function liveMetaText(state) {
    if (state.loading) { return 'lädt …'; }
    if (state.error) { return ''; }
    return esc(liveAgoText(state.data && state.data.lastSaleAt));
  }

  function liveTileHtml(state) {
    state = state || { loading: true };
    return '<section class="v3-card v3-live" data-live-tile aria-label="Live-Umsatz">' +
      '<header class="v3-live__head">' +
        '<span class="v3-live__title"><span class="v3-live__dot" aria-hidden="true"></span>Live-Umsatz</span>' +
        '<span class="v3-live__meta" data-live-meta>' + liveMetaText(state) + '</span>' +
      '</header>' +
      liveTileInner(state) +
    '</section>';
  }

  function loadLiveData() {
    var qs = '';
    if (_guvQuery.machines && _guvQuery.machines.length) {
      qs = '?machines=' + encodeURIComponent(_guvQuery.machines.join(','));
    }
    return fetchJson('/api/v2/economics/live' + qs)
      .then(function (res) { return (res && res.data) ? res.data : null; });
  }

  /* Nur den Kachel-Inhalt neu zeichnen, ohne die Seite anzufassen. */
  function paintLiveTile(state) {
    var tile = viewEl.querySelector('[data-live-tile]');
    if (!tile) { return; }
    var body = tile.querySelector('[data-live-body]');
    var meta = tile.querySelector('[data-live-meta]');
    if (body) { body.outerHTML = liveTileInner(state); wireLiveDetails(); }
    if (meta) { meta.textContent = liveMetaText(state); }
  }

  function refreshLiveTile() {
    if (!viewEl.querySelector('[data-live-tile]')) { stopLiveRefresh(); return; }
    var token = ++_liveReqToken;
    loadLiveData().then(function (data) {
      if (token !== _liveReqToken) { return; }
      if (!viewEl.querySelector('[data-live-tile]')) { return; }
      paintLiveTile({ data: data || { today: {}, recent: [] } });
    }).catch(function () {
      if (token !== _liveReqToken) { return; }
      paintLiveTile({ error: true });
    });
  }

  function startLiveRefresh() {
    stopLiveRefresh();
    refreshLiveTile();
    _liveTimer = setInterval(refreshLiveTile, LIVE_REFRESH_MS);
  }

  function stopLiveRefresh() {
    if (_liveTimer) { clearInterval(_liveTimer); _liveTimer = null; }
  }

  function renderGuvPage(data) {
    _guvData = data || null;
    return '<div class="v3-guv">' +
      liveTileHtml({ loading: true }) +
      guvPeriodPicker(_guvQuery) +
      '<div class="v3-guv-body" data-guv-body aria-live="polite">' + renderGuvBody(_guvData, _guvQuery) + '</div>' +
    '</div>';
  }

  /* Lesbare Filter-Zusammenfassung für PDF/Druck-Kopf */
  function guvFilterSummaryText() {
    var m = _guvQuery.machines || [];
    if (!m.length) { return 'Alle Automaten'; }
    return m.map(guvMachineLabel).join(', ');
  }

  /* PDF-Export: öffnet ein sauberes Druck-Layout (eigenes Fenster) mit
     Zeitraum-/Filter-Kopf, vollständiger Produkttabelle (Brutto) + Summenzeile
     und ruft den Druckdialog auf ("Als PDF speichern"). Dependency-frei. */
  function guvPrintReport() {
    var data = _guvData || {};
    var rows = guvTopProducts(data.byProduct || []).sort(function (a, b) { return b.revenue_gross - a.revenue_gross; });
    var totals = data.totals || {};
    var prov = data.provisional || { hasProvisional: false };
    var withProv = data.totalsWithProvisional || totals;
    var withCost = prov.hasProvisional && prov.hasCost;
    // Summenzeile/KPIs spiegeln die Bildschirm-Anzeige „inkl. heute" wider.
    var sumRev = prov.hasProvisional ? withProv.revenue_gross : totals.revenue_gross;
    var sumQty = prov.hasProvisional ? withProv.qty : totals.qty;
    var sumGuv = withCost ? withProv.gross_profit : totals.gross_profit;
    var range = periodLabel(data.period) || '–';
    var marge = Number(sumRev) > 0 ? (sumGuv / sumRev) * 100 : 0;
    var today = new Date().toLocaleDateString('de-DE');

    var rowsHtml = rows.map(function (r) {
      return '<tr><td>' + esc(r.product_name) + '</td>' +
        '<td class="n">' + fmtEuro(r.revenue_gross) + '</td>' +
        '<td class="n">' + fmtEuro(r.gross_profit) + '</td>' +
        '<td class="n">' + fmtPct(r.margin_gross_pct) + '</td>' +
        '<td class="n">' + fmtInt(r.qty) + '</td></tr>';
    }).join('') || '<tr><td colspan="5" class="empty">Keine Daten im Zeitraum</td></tr>';
    var sumRow = '<tr class="sum"><td>Summe</td>' +
      '<td class="n">' + fmtEuro(sumRev) + '</td>' +
      '<td class="n">' + fmtEuro(sumGuv) + '</td>' +
      '<td class="n">' + fmtPct(marge) + '</td>' +
      '<td class="n">' + fmtInt(sumQty) + '</td></tr>';

    var win = window.open('', '_blank');
    if (!win) { return; }
    var css = 'body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1b1c1f;margin:32px;}' +
      'h1{font-size:20px;margin:0 0 4px;}' +
      '.meta{color:#555;font-size:12px;margin:0 0 18px;line-height:1.5;}' +
      '.meta b{color:#1b1c1f;}' +
      '.kpis{display:flex;gap:24px;margin:0 0 18px;flex-wrap:wrap;}' +
      '.kpi{font-size:12px;color:#555;}.kpi b{display:block;font-size:17px;color:#1b1c1f;}' +
      'table{width:100%;border-collapse:collapse;font-size:12px;}' +
      'th,td{padding:7px 10px;border-bottom:1px solid #e4e0d8;text-align:left;}' +
      'th{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#666;border-bottom:1.5px solid #b8b2a6;}' +
      'td.n,th.n{text-align:right;font-variant-numeric:tabular-nums;}' +
      'tr.sum td{font-weight:700;border-top:2px solid #b8b2a6;border-bottom:none;}' +
      '.empty{color:#888;text-align:center;padding:24px;}' +
      '@media print{body{margin:12mm;}}';
    var doc = '<!doctype html><html lang="de"><head><meta charset="utf-8">' +
      '<title>GuV-Bericht ' + esc(range) + '</title><style>' + css + '</style></head><body>' +
      '<h1>GuV-Bericht</h1>' +
      '<p class="meta">Zeitraum: <b>' + esc(range) + '</b><br>Automat: <b>' + esc(guvFilterSummaryText()) + '</b><br>Erstellt am ' + esc(today) + '</p>' +
      '<div class="kpis">' +
        '<div class="kpi">Umsatz (brutto)<b>' + fmtEuro(sumRev) + ' €</b></div>' +
        '<div class="kpi">GuV (brutto)<b>' + fmtEuro(sumGuv) + ' €</b></div>' +
        '<div class="kpi">Marge<b>' + fmtPct(marge) + '</b></div>' +
        '<div class="kpi">Stück<b>' + fmtInt(sumQty) + '</b></div>' +
      '</div>' +
      '<table><thead><tr><th>Produkt</th><th class="n">Umsatz brutto</th><th class="n">GuV brutto</th><th class="n">Marge</th><th class="n">Stück</th></tr></thead>' +
      '<tbody>' + rowsHtml + sumRow + '</tbody></table>' +
      '<script>window.onload=function(){setTimeout(function(){window.print();},180);};<\/script>' +
      '</body></html>';
    win.document.open();
    win.document.write(doc);
    win.document.close();
  }

  function bindGuvControls() {
    var root = viewEl.querySelector('.v3-guv');
    if (!root) { return; }

    function fieldVisibility() {
      var show = {
        month:   _guvQuery.mode === 'month',
        week:    _guvQuery.mode === 'week',
        quarter: _guvQuery.mode === 'quarter',
        year:    _guvQuery.mode === 'quarter' || _guvQuery.mode === 'year',
        from:    _guvQuery.mode === 'custom',
        to:      _guvQuery.mode === 'custom',
      };
      root.querySelectorAll('.v3-guv-field').forEach(function (el) {
        var f = el.getAttribute('data-field');
        if (show[f]) { el.classList.remove('is-hidden'); } else { el.classList.add('is-hidden'); }
      });
    }

    function reload() {
      var body = root.querySelector('[data-guv-body]');
      if (body) { body.setAttribute('aria-busy', 'true'); body.classList.add('is-loading'); }
      loadGuvData(_guvQuery).then(function (data) {
        _guvData = data;
        if (!body) { return; }
        body.classList.remove('is-loading');
        body.setAttribute('aria-busy', 'false');
        body.innerHTML = renderGuvBody(data, _guvQuery);
        bindBody();
        refreshLiveTile(); // Live-Kachel dem evtl. geänderten Automaten-Filter nachziehen
      }).catch(function () {
        if (!body) { return; }
        body.classList.remove('is-loading');
        body.setAttribute('aria-busy', 'false');
        body.innerHTML = renderState('error', { message: 'Die GuV-Daten für diesen Zeitraum konnten nicht geladen werden.' });
      });
    }

    function redrawTable() {
      var wrap = root.querySelector('[data-guv-tablewrap]');
      if (!wrap || !_guvData) { return; }
      wrap.innerHTML = renderGuvTableEl((_guvData && _guvData.byProduct) || [], _guvQuery);
      bindSortButtons();
    }
    function bindSortButtons() {
      root.querySelectorAll('[data-guv-sort]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var key = btn.getAttribute('data-guv-sort');
          if (_guvQuery.sort === key) { _guvQuery.order = _guvQuery.order === 'asc' ? 'desc' : 'asc'; }
          else { _guvQuery.sort = key; _guvQuery.order = 'desc'; }
          redrawTable();
        });
      });
    }

    /* Nach jedem Body-Render neu binden: Tabellen-Controls, Karussell, Export */
    function bindBody() {
      var search = root.querySelector('[data-guv-filter]');
      if (search) { search.addEventListener('input', function (e) { _guvQuery.filter = e.target.value; redrawTable(); }); }
      var limit = root.querySelector('[data-guv-limit]');
      if (limit) { limit.addEventListener('change', function (e) { _guvQuery.limit = e.target.value; redrawTable(); }); }
      bindSortButtons();
      bindCarousel();
      bindChartTips();
      bindExport();
    }

    /* Touch/Click: ein Chart-Segment antippen pinnt seinen Tooltip (.is-tapped);
       erneutes Tippen bzw. Tippen woanders blendet ihn aus. Auf dem Desktop
       reicht zusätzlich CSS :hover. */
    function bindChartTips() {
      var charts = root.querySelector('[data-guv-charts]');
      if (!charts) { return; }
      charts.addEventListener('click', function (e) {
        var seg = e.target.closest ? e.target.closest('[data-guv-seg]') : null;
        var on = seg && seg.classList.contains('is-tapped');
        charts.querySelectorAll('.v3-guv-seg.is-tapped').forEach(function (s) { s.classList.remove('is-tapped'); });
        if (seg && !on) { seg.classList.add('is-tapped'); }
      });
    }

    /* Handy-Karussell: aktiven Punkt beim Wischen markieren, Klick scrollt hin */
    function bindCarousel() {
      var charts = root.querySelector('[data-guv-charts]');
      var dotsWrap = root.querySelector('[data-guv-cardots]');
      if (!charts || !dotsWrap) { return; }
      var dots = [].slice.call(dotsWrap.querySelectorAll('[data-guv-cardot]'));
      function update() {
        var w = charts.clientWidth || 1;
        var idx = Math.round(charts.scrollLeft / w);
        dots.forEach(function (d, i) { d.classList.toggle('is-active', i === idx); });
      }
      charts.addEventListener('scroll', function () { window.requestAnimationFrame(update); });
      dots.forEach(function (d, i) {
        d.addEventListener('click', function () {
          charts.scrollTo({ left: i * charts.clientWidth, behavior: 'smooth' });
        });
      });
      update();
    }

    /* Export: CSV/Excel als Datei-Download, PDF über das Druck-Layout */
    function bindExport() {
      root.querySelectorAll('[data-guv-export]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          if (btn.getAttribute('data-guv-export') === 'csv') {
            var a = document.createElement('a');
            a.href = guvExportUrl(_guvQuery);
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
          } else {
            guvPrintReport();
          }
        });
      });
    }

    /* ---- Standort-/Automaten-Filter -------------------------------------- */
    function loadGuvScope() {
      if (_guvScope) { return Promise.resolve(_guvScope); }
      return fetchJson('/api/v2/economics/scope')
        .then(function (res) { _guvScope = (res && res.data) ? res.data : { locations: [], machines: [] }; return _guvScope; })
        .catch(function () { _guvScope = { locations: [], machines: [] }; return _guvScope; });
    }
    function bindClear() {
      var clear = root.querySelector('[data-guv-clear]');
      if (clear) {
        clear.addEventListener('click', function (e) {
          e.preventDefault(); e.stopPropagation();
          _guvQuery.machines = []; syncFilterUi(); reload();
        });
      }
    }
    function syncFilterUi() {
      var sel = {};
      _guvQuery.machines.forEach(function (id) { sel[id] = true; });
      root.querySelectorAll('[data-guv-mid]').forEach(function (cb) {
        var on = !!sel[cb.getAttribute('data-guv-mid')];
        cb.checked = on;
        var opt = cb.closest('.v3-guv-opt'); if (opt) { opt.classList.toggle('is-on', on); }
      });
      root.querySelectorAll('[data-guv-loc]').forEach(function (cb) {
        var ids = cb.getAttribute('data-guv-loc').split(',').filter(Boolean);
        var all = ids.length > 0 && ids.every(function (id) { return sel[id]; });
        cb.checked = all;
        var opt = cb.closest('.v3-guv-opt'); if (opt) { opt.classList.toggle('is-on', all); }
      });
      var sum = root.querySelector('.v3-guv-filter__summary');
      if (sum) {
        var n = _guvQuery.machines.length;
        var text = n === 0 ? 'Alle Automaten' : (n === 1 ? guvMachineLabel(_guvQuery.machines[0]) : n + ' Automaten');
        sum.innerHTML = esc(text) + (n ? '<button type="button" class="v3-guv-filter__clear" data-guv-clear aria-label="Auswahl zurücksetzen">×</button>' : '');
        bindClear();
      }
    }
    function afterFilterChange() { syncFilterUi(); reload(); }
    function bindFilter() {
      root.querySelectorAll('[data-guv-mid]').forEach(function (cb) {
        cb.addEventListener('change', function () {
          var id = cb.getAttribute('data-guv-mid');
          var set = {}; _guvQuery.machines.forEach(function (x) { set[x] = true; });
          if (cb.checked) { set[id] = true; } else { delete set[id]; }
          _guvQuery.machines = Object.keys(set);
          afterFilterChange();
        });
      });
      root.querySelectorAll('[data-guv-loc]').forEach(function (cb) {
        cb.addEventListener('change', function () {
          var ids = cb.getAttribute('data-guv-loc').split(',').filter(Boolean);
          var set = {}; _guvQuery.machines.forEach(function (x) { set[x] = true; });
          if (cb.checked) { ids.forEach(function (id) { set[id] = true; }); }
          else { ids.forEach(function (id) { delete set[id]; }); }
          _guvQuery.machines = Object.keys(set);
          afterFilterChange();
        });
      });
      // Dropdown schließt bei Klick außerhalb bzw. Escape (Listener nur solange offen)
      var box = root.querySelector('[data-guv-filterbox]');
      if (box && !box.__outsideBound) {
        box.__outsideBound = true;
        var onDocDown = function (e) { if (box.open && !box.contains(e.target)) { box.open = false; } };
        box.addEventListener('toggle', function () {
          if (box.open) { document.addEventListener('mousedown', onDocDown); }
          else { document.removeEventListener('mousedown', onDocDown); }
        });
        box.addEventListener('keydown', function (e) { if (e.key === 'Escape') { box.open = false; } });
      }
      bindClear();
    }
    function renderFilter() {
      var wrap = root.querySelector('[data-guv-filter-wrap]');
      if (!wrap) { return; }
      wrap.innerHTML = guvFilterControl(_guvQuery);
      bindFilter();
    }

    /* Zeitraum-Segment + Felder lösen einen Server-Reload aus */
    root.querySelectorAll('[data-period]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        _guvQuery.mode = btn.getAttribute('data-period');
        root.querySelectorAll('[data-period]').forEach(function (b) {
          var active = b === btn;
          if (active) { b.classList.add('is-active'); } else { b.classList.remove('is-active'); }
          b.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
        fieldVisibility();
        reload();
      });
    });
    function onChange(sel, fn) { var el = root.querySelector(sel); if (el) { el.addEventListener('change', fn); } }
    onChange('[data-guv-month]',   function (e) { _guvQuery.month   = e.target.value; reload(); });
    onChange('[data-guv-quarter]', function (e) { _guvQuery.quarter = e.target.value; reload(); });
    onChange('[data-guv-year]',    function (e) { _guvQuery.year    = e.target.value; reload(); });
    onChange('[data-guv-week]',    function (e) { _guvQuery.week    = parseInt(e.target.value, 10); reload(); });
    onChange('[data-guv-from]',    function (e) { _guvQuery.from    = e.target.value; reload(); });
    onChange('[data-guv-to]',      function (e) { _guvQuery.to      = e.target.value; reload(); });
    // Jahr der KW: Wochenliste neu aufbauen (Wochenzahl auf 52/53 begrenzen).
    onChange('[data-guv-week-year]', function (e) {
      _guvQuery.weekYear = parseInt(e.target.value, 10);
      var maxW = isoWeeksInYear(_guvQuery.weekYear);
      if (_guvQuery.week > maxW) { _guvQuery.week = maxW; }
      var sel = root.querySelector('[data-guv-week]');
      if (sel) { sel.innerHTML = guvWeekOptions(_guvQuery.weekYear, _guvQuery.week); }
      reload();
    });

    loadGuvScope().then(renderFilter);
    bindBody();
    startLiveRefresh(); // Live-Kachel laden + 30-s-Auto-Refresh (Cleanup in renderRoute)
  }

  /* ---- Sortiment & Slots: Etagen-Slot-Editor (/slots) ------------------ */
  /* Client-Spiegel der getesteten lib/slot-editor.js (Quelle der Wahrheit).
     Schreibt ausschliesslich ueber den bestehenden Slot-Assign-Vorgang
     (/api/v2/slot-assign-inline/confirm) – kein neuer Roh-Schreibpfad. */

  function slotParseCode(mdbCode) {
    var raw = String(mdbCode == null ? '' : mdbCode).replace(/[^0-9]/g, '');
    return {
      floor:    raw.length ? Number(raw[0]) : 0,
      position: raw.length > 1 ? Number(raw.slice(1)) : 0,
      raw:      raw,
    };
  }

  function slotFloorLayout(slots) {
    var byFloor = {};
    var order = [];
    (slots || []).forEach(function (slot) {
      var p = slotParseCode(slot.mdb_code);
      var enriched = Object.assign({}, slot, { floor: p.floor, position: p.position });
      if (!byFloor[p.floor]) { byFloor[p.floor] = []; order.push(p.floor); }
      byFloor[p.floor].push(enriched);
    });
    return order
      .sort(function (a, b) { return a - b; })
      .map(function (floor) {
        return {
          floor: floor,
          slots: byFloor[floor].sort(function (a, b) { return a.position - b.position; }),
        };
      });
  }

  function slotBuildPalette(searchResults) {
    var seen = {};
    var items = [];
    (searchResults || []).forEach(function (row) {
      var pid = Number(row.product_id);
      if (!pid || seen[pid]) { return; }
      seen[pid] = true;
      /* Katalog (/products/catalog) liefert `name`, die Refill-Suche `product_name`. */
      var rawName = row.name != null ? row.name : row.product_name;
      var name = String(rawName == null ? '' : rawName).trim();
      items.push({ product_id: pid, product_key: row.product_key != null ? row.product_key : null, name: name, label: name });
    });
    return items;
  }

  function slotBuildPreview(item, slot, machineId, qty, startDate) {
    var p = slotParseCode(slot.mdb_code);
    return {
      product: { product_id: item.product_id, product_key: item.product_key != null ? item.product_key : null, name: item.name || '' },
      slot: { mdb_code: Number(slot.mdb_code), floor: p.floor, position: p.position, machine_id: machineId },
      assign: {
        product_id:  item.product_id,
        product_key: item.product_key != null ? item.product_key : null,
        machine_id:  machineId,
        mdb_code:    Number(slot.mdb_code),
        qty:         Number(qty),
        start_date:  startDate,
      },
      assign_key: 'SLOTASSIGN|' + item.product_id + '|' + machineId + '|' + Number(slot.mdb_code),
    };
  }

  function groupSlotsByMachine(slots) {
    var byMachine = {};
    var order = [];
    (slots || []).forEach(function (slot) {
      var id = String(slot.machine_id || '');
      if (!byMachine[id]) {
        byMachine[id] = { machine_id: id, machine_name: slot.machine_name || id, location_name: slot.location_name || '', rows: [] };
        order.push(id);
      }
      byMachine[id].rows.push(slot);
    });
    return order.map(function (id) {
      var m = byMachine[id];
      return { machine_id: m.machine_id, machine_name: m.machine_name, location_name: m.location_name, floors: slotFloorLayout(m.rows) };
    });
  }

  function todayIso() {
    var d = new Date();
    var mm = String(d.getMonth() + 1);
    var dd = String(d.getDate());
    return d.getFullYear() + '-' + (mm.length < 2 ? '0' + mm : mm) + '-' + (dd.length < 2 ? '0' + dd : dd);
  }

  /* Eine einzelne Slot-Zelle (Drop-Ziel bzw. Tap-Ziel) */
  function renderSlotCell(slot, canEdit) {
    var occupied = Number(slot.product_id) > 0;
    var occ      = slot.occupancy || {};
    var fillPct  = typeof occ.fill_pct === 'number' ? occ.fill_pct : null;
    var curQty   = occ.current_machine_qty != null ? occ.current_machine_qty : (slot.current_machine_qty != null ? slot.current_machine_qty : 0);
    var cap      = occ.machine_capacity != null ? occ.machine_capacity : (slot.machine_capacity != null ? slot.machine_capacity : 0);
    var product  = occupied ? esc(slot.product_name || ('#' + slot.product_id)) : 'Frei';
    var cls = 'v3-slot' + (occupied ? ' v3-slot--occupied' : ' v3-slot--empty');
    // Belegte Slots sind selbst Ziehquelle (zum Tauschen); alle Slots sind Drop-/Tap-Ziel.
    return '' +
      '<button type="button" class="' + cls + '"' +
        ' data-slot' +
        (canEdit && occupied ? ' data-draggable="slot"' : '') +
        ' data-slot-mdb="' + esc(slot.mdb_code) + '"' +
        ' data-slot-floor="' + esc(slot.floor) + '"' +
        ' data-slot-pos="' + esc(slot.position) + '"' +
        ' data-slot-pid="' + esc(slot.product_id || 0) + '"' +
        ' data-slot-said="' + esc(slot.slot_assignment_id || 0) + '"' +
        ' data-slot-qty="' + esc(curQty) + '"' +
        ' data-slot-cap="' + esc(cap) + '"' +
        ' data-slot-turnover="' + esc(occupied ? (slot.turnover_class || '') : '') + '"' +
        (canEdit ? '' : ' disabled') +
        ' aria-label="Slot ' + esc(slot.mdb_code) + ' – ' + product + (occupied ? ' (' + esc(curQty) + (cap ? '/' + esc(cap) : '') + ')' : '') +
          (occupied && slot.turnover_class && TURNOVER_LABEL[slot.turnover_class] ? ' · Drehzahl: ' + esc(TURNOVER_LABEL[slot.turnover_class]) : '') + '">' +
        '<span class="v3-slot__code">' + esc(slot.mdb_code) + '</span>' +
        '<span class="v3-slot__product">' + product + '</span>' +
        (occupied
          ? '<span class="v3-slot__meta">' + esc(curQty) + (cap ? ' / ' + esc(cap) : '') + ' Stk.</span>'
          : '') +
        (occupied ? turnoverBadge(slot.turnover_class, true) : '') +
        (fillPct != null
          ? '<span class="v3-slot__fill"><span class="v3-slot__fillbar" style="width:' + Math.max(0, Math.min(100, fillPct)) + '%"></span></span>'
          : '') +
      '</button>';
  }

  /* Etagen-Klappzustand: pro Automat+Etage in localStorage gemerkt, damit das
     Ein-/Ausklappen über Reloads und Automatenwechsel hinweg stabil bleibt.
     Default = aufgeklappt (kein Eintrag); nur eingeklappte Etagen werden gespeichert. */
  var FLOOR_COLLAPSE_KEY = 'v3.slots.collapsedFloors';
  function floorKey(machineId, floor) { return String(machineId) + '::' + String(floor); }
  function loadCollapsedFloors() {
    try { return JSON.parse(window.localStorage.getItem(FLOOR_COLLAPSE_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function saveCollapsedFloors(map) {
    try { window.localStorage.setItem(FLOOR_COLLAPSE_KEY, JSON.stringify(map)); } catch (e) { /* Speicher voll/gesperrt → still ignorieren */ }
  }
  /* Default-Zustand ohne ausdrückliche Nutzer-Entscheidung: am Handy eingeklappt
     (kompakte Übersicht, kein endloses Scrollen), am Desktop aufgeklappt. Die
     Schwelle 880px entspricht dem Umschaltpunkt zur Sidebar-/Desktop-Ansicht. */
  function floorDefaultCollapsed() {
    try { return window.matchMedia('(max-width: 879px)').matches; } catch (e) { return false; }
  }
  var FLOOR_CHEVRON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';

  function renderMachineStage(machine, canEdit) {
    var collapsed = loadCollapsedFloors();
    var defCollapsed = floorDefaultCollapsed();
    var floorsHtml = machine.floors.map(function (f) {
      var total = f.slots.length;
      var occ = f.slots.filter(function (s) { return Number(s.product_id) > 0; }).length;
      var key = floorKey(machine.machine_id, f.floor);
      // Ausdrückliche Wahl (true/false) schlägt den Viewport-Default; sonst Default.
      var isCollapsed = (key in collapsed) ? !!collapsed[key] : defCollapsed;
      return '' +
        '<div class="v3-slots-floor" data-slots-floor data-floor-key="' + esc(key) + '"' +
          ' data-floor-collapsed="' + (isCollapsed ? 'true' : 'false') + '">' +
          '<button type="button" class="v3-slots-floor__toggle" data-floor-toggle' +
            ' aria-expanded="' + (isCollapsed ? 'false' : 'true') + '">' +
            '<span class="v3-slots-floor__label">Etage ' + esc(f.floor) + '</span>' +
            '<span class="v3-slots-floor__summary">' + occ + ' / ' + total + ' belegt</span>' +
            '<span class="v3-slots-floor__chev">' + FLOOR_CHEVRON + '</span>' +
          '</button>' +
          '<div class="v3-slots-floor__row">' +
            f.slots.map(function (s) { return renderSlotCell(s, canEdit); }).join('') +
          '</div>' +
        '</div>';
    }).join('');
    return '' +
      '<div class="v3-slots-stage" data-slots-stage data-slots-stage-machine="' + esc(machine.machine_id) + '">' +
        '<div class="v3-slots-stage__top">' +
          '<span class="v3-slots-stage__name">' + esc(machine.machine_name) + '</span>' +
          (machine.location_name ? '<span class="v3-slots-stage__loc">' + esc(machine.location_name) + '</span>' : '') +
          (canEdit ? '<button type="button" class="v3-btn v3-btn--brand v3-slots-fillbtn" data-slots-fillall="' + esc(machine.machine_id) + '">Automat voll auffüllen</button>' : '') +
          // Abgleich-Vorschau ist read-only -> auch für Gäste sichtbar; die
          // Übernahme im Panel ist admin-only (Server erzwingt 403).
          '<button type="button" class="v3-btn v3-slots-fillbtn" data-slots-nayax-abgleich="' + esc(machine.machine_id) + '">Aus Nayax abgleichen</button>' +
        '</div>' +
        '<div class="v3-slots-stage__body">' + floorsHtml + '</div>' +
        '<div class="v3-slots-stage__tray" aria-hidden="true"></div>' +
      '</div>';
  }

  function renderPaletteTiles(items) {
    if (!items.length) {
      return '<p class="v3-slots-palette__empty">Keine Produkte gefunden.</p>';
    }
    return items.map(function (it) {
      return '' +
        '<button type="button" class="v3-slot-tile"' +
          ' data-tile data-draggable="palette" data-product-id="' + esc(it.product_id) + '"' +
          ' data-product-key="' + esc(it.product_key == null ? '' : it.product_key) + '"' +
          ' data-product-name="' + esc(it.name) + '">' +
          '<span class="v3-slot-tile__grip" aria-hidden="true">⠿</span>' +
          '<span class="v3-slot-tile__name">' + esc(it.name) + '</span>' +
        '</button>';
    }).join('');
  }

  function renderSlotsPage(data) {
    var machines = (data && data.machines) || [];
    var palette  = (data && data.palette)  || [];
    var canEdit  = !!(data && data.canEdit);

    var machineChips = machines.length > 1
      ? '<div class="v3-slots__machines" role="tablist" aria-label="Automat wählen">' +
          machines.map(function (m, i) {
            return '<button type="button" class="v3-chip v3-chip--brand' + (i === 0 ? ' v3-chip--active' : '') + '"' +
              ' role="tab" data-slots-machine="' + i + '" aria-selected="' + (i === 0 ? 'true' : 'false') + '">' +
              esc(m.machine_name) + '</button>';
          }).join('') +
        '</div>'
      : '';

    var palettePanel = canEdit
      ? '<aside class="v3-slots-palette" aria-label="Produkt-Palette">' +
          '<p class="v3-slots-palette__title">Produkt-Palette</p>' +
          '<p class="v3-slots-hint" data-slots-hint>' +
            '<b>Ziehen:</b> Kachel auf einen Slot = bestücken/wechseln · Slot auf Slot = tauschen.<br>' +
            '<b>Antippen:</b> belegten Slot antippen zum Nachfüllen.' +
          '</p>' +
          '<div class="v3-slots-palette__search">' +
            '<input type="search" class="v3-input" data-palette-search placeholder="Produkt suchen …" aria-label="Produkt suchen">' +
          '</div>' +
          '<div class="v3-slots-palette__list" data-palette-list>' + renderPaletteTiles(palette) + '</div>' +
        '</aside>'
      : '<aside class="v3-slots-palette v3-slots-palette--ro" aria-label="Hinweis">' +
          '<p class="v3-slots-palette__title">Nur Lesezugriff</p>' +
          '<p class="v3-slots-hint">Das Bestücken der Slots ist Admins vorbehalten. Die Etagen-Übersicht ist hier nur zur Ansicht.</p>' +
        '</aside>';

    /* Drehzahl-Filter (User Story 37): hebt Slots einer Klasse hervor, dimmt den
       Rest. Wirkt per data-turnover-filter auf [data-slots-stagewrap] (CSS),
       übersteht den Stage-Neuaufbau beim Automatenwechsel ohne erneutes Binden. */
    var turnoverFilter = '' +
      '<div class="v3-slots-filter" role="group" aria-label="Nach Drehzahl-Klasse filtern">' +
        '<span class="v3-slots-filter__label">Drehzahl</span>' +
        '<button type="button" class="v3-chip v3-chip--active" data-slots-turnover="" aria-pressed="true">Alle</button>' +
        TURNOVER_CLASSES.map(function (c) {
          return '<button type="button" class="v3-chip v3-chip--turnover-' + esc(c.key) + '"' +
            ' data-slots-turnover="' + esc(c.key) + '" aria-pressed="false">' + esc(c.label) + '</button>';
        }).join('') +
      '</div>';

    return '' +
      machineChips +
      turnoverFilter +
      '<div class="v3-slots-layout" data-slots-root>' +
        '<div class="v3-slots-stagewrap" data-slots-stagewrap>' +
          (machines.length ? renderMachineStage(machines[0], canEdit) : '') +
        '</div>' +
        palettePanel +
      '</div>' +
      '<div class="v3-slots-fillpanel" data-slots-fillpanel hidden></div>';
    // Dialog + Toast werden auf document.body portiert (mountSlotDialog/showSlotToast),
    // damit position:fixed am Viewport haftet (Vorfahren der View tragen ein transform).
    // Das Nayax-Abgleich-Panel ebenso: ensureAbgleichPanel() erzeugt es auf
    // document.body (sonst rendert das fixe Panel weit unten im transformierten View).
  }

  /* Client-Spiegel der getesteten lib/slot-editor.js (Swap + Refill) */
  function slotQtyOf(s) {
    return Number(s.current_machine_qty != null ? s.current_machine_qty : (s.qty != null ? s.qty : 0));
  }
  function writeMachineId(slot) { return slot.machine_ref || slot.machine_id; }
  function slotBuildSwap(a, b, date) {
    var valid = Number(a.product_id) > 0 && Number(b.product_id) > 0
      && !(String(a.machine_id) === String(b.machine_id) && String(a.mdb_code) === String(b.mdb_code));
    return {
      valid: valid,
      changes: valid ? [
        { slot_assignment_id: a.slot_assignment_id, machine_id: writeMachineId(a), mdb_code: Number(a.mdb_code), old_product_id: Number(a.product_id), new_product_id: Number(b.product_id), new_qty: slotQtyOf(b), start_date: date },
        { slot_assignment_id: b.slot_assignment_id, machine_id: writeMachineId(b), mdb_code: Number(b.mdb_code), old_product_id: Number(b.product_id), new_product_id: Number(a.product_id), new_qty: slotQtyOf(a), start_date: date },
      ] : [],
    };
  }
  function slotFillToCapacity(details) {
    var s = (details && details.slot) || {};
    if (s.free_capacity != null) { return Math.max(0, Number(s.free_capacity)); }
    return Math.max(0, Number(s.capacity || 0) - Number(s.current_machine_qty || 0));
  }
  function slotRefillWarnings(details, qty) {
    var s = (details && details.slot) || {};
    var bs = (details && details.backstock) || {};
    var w = [];
    var free = s.free_capacity != null ? Number(s.free_capacity) : Math.max(0, Number(s.capacity || 0) - Number(s.current_machine_qty || 0));
    if (qty > free) { w.push('Menge übersteigt freie Kapazität (' + free + ' frei).'); }
    if (bs.total_qty != null && qty > Number(bs.total_qty)) { w.push('Menge übersteigt verfügbaren Backstock (' + bs.total_qty + ' Stk.).'); }
    return w;
  }

  /* ---- Dialog-Hülle (auf document.body portiert) ----------------------- */
  function slotsBodyHost(id, className) {
    var el = document.getElementById(id);
    if (!el) { el = document.createElement('div'); el.id = id; document.body.appendChild(el); }
    el.className = className;
    return el;
  }

  function mountSlotDialog(bodyHtml, ariaLabel) {
    var dialog = slotsBodyHost('v3-slots-dialog-host', 'v3-slots-dialog');
    dialog.innerHTML = '' +
      '<div class="v3-slots-dialog__backdrop" data-dialog-cancel></div>' +
      '<div class="v3-slots-dialog__card" role="dialog" aria-modal="true" aria-label="' + esc(ariaLabel) + '">' + bodyHtml + '</div>';
    dialog.hidden = false;
    dialog.classList.add('is-open');
    function close() { dialog.remove(); }
    dialog.querySelectorAll('[data-dialog-cancel]').forEach(function (el) { el.addEventListener('click', close); });
    return { dialog: dialog, card: dialog.querySelector('.v3-slots-dialog__card'), close: close };
  }

  function dialogError(card, msg) {
    var errEl = card.querySelector('[data-pv-error]');
    if (errEl) { errEl.textContent = msg; errEl.hidden = false; }
  }

  /* ---- Bestücken / Produktwechsel (Palette -> Slot) -------------------- */
  function openPlacePreview(item, slotData, machineId) {
    var occupied = Number(slotData.product_id) > 0;
    var pos = slotParseCode(slotData.mdb_code);
    var body = '' +
      '<p class="v3-slots-dialog__eyebrow">' + (occupied ? 'Produktwechsel' : 'Bestücken') + '</p>' +
      '<div class="v3-slots-dialog__flow">' +
        '<span class="v3-slots-dialog__product">' + esc(item.name) + '</span>' +
        '<span class="v3-slots-dialog__arrow" aria-hidden="true">→</span>' +
        '<span class="v3-slots-dialog__target">Slot ' + esc(slotData.mdb_code) +
          ' <small>(Etage ' + esc(pos.floor) + ', Pos. ' + esc(pos.position) + ')</small></span>' +
      '</div>' +
      (occupied ? '<p class="v3-slots-dialog__note">Ersetzt aktuell: <b>' + esc(slotData.product_name || '') + '</b></p>' : '') +
      '<div class="v3-slots-dialog__fields">' +
        '<label class="v3-field"><span>Startmenge</span>' +
          '<input type="number" min="0" step="1" class="v3-input" data-pv-qty value="1"></label>' +
        '<label class="v3-field"><span>Startdatum</span>' +
          '<input type="date" class="v3-input" data-pv-date value="' + esc(todayIso()) + '"></label>' +
      '</div>' +
      '<p class="v3-slots-dialog__error" data-pv-error hidden></p>' +
      '<div class="v3-slots-dialog__actions">' +
        '<button type="button" class="v3-btn" data-dialog-cancel>Abbrechen</button>' +
        '<button type="button" class="v3-btn v3-btn--brand" data-pv-confirm>' + (occupied ? 'Wechsel bestätigen' : 'Zuordnung bestätigen') + '</button>' +
      '</div>';
    var d = mountSlotDialog(body, 'Slot bestücken');
    if (!d) { return; }
    var qtyEl = d.card.querySelector('[data-pv-qty]');
    var dateEl = d.card.querySelector('[data-pv-date]');
    var confirmEl = d.card.querySelector('[data-pv-confirm]');

    confirmEl.addEventListener('click', function () {
      var qty = Number(qtyEl.value);
      var date = dateEl.value;
      var wmid = writeMachineId(slotData);
      var url, payload;
      if (occupied) {
        url = '/api/v2/slot-change/confirm';
        payload = { slot_assignment_id: slotData.slot_assignment_id, machine_id: wmid, mdb_code: Number(slotData.mdb_code), new_product_id: item.product_id, new_qty: qty, start_date: date };
      } else {
        url = '/api/v2/slot-assign-inline/confirm';
        payload = slotBuildPreview(item, slotData, wmid, qty, date).assign;
      }
      confirmEl.disabled = true;
      confirmEl.textContent = 'Wird gespeichert …';
      postJson(url, payload).then(function (res) {
        if (res.ok && res.json && res.json.ok) {
          updateSlotCellFull(machineId, slotData.mdb_code, { product_id: item.product_id, product_name: item.name, qty: qty });
          showSlotToast('„' + item.name + '" auf Slot ' + slotData.mdb_code + (occupied ? ' gewechselt.' : ' zugeordnet.'));
          d.close();
        } else {
          dialogError(d.card, (res.json && res.json.error && res.json.error.message) || (res.json && res.json.message) || 'Vorgang fehlgeschlagen.');
          confirmEl.disabled = false; confirmEl.textContent = occupied ? 'Wechsel bestätigen' : 'Zuordnung bestätigen';
        }
      }).catch(function () {
        dialogError(d.card, 'Netzwerkfehler – bitte erneut versuchen.');
        confirmEl.disabled = false; confirmEl.textContent = occupied ? 'Wechsel bestätigen' : 'Zuordnung bestätigen';
      });
    });
  }

  /* ---- Tauschen (Slot -> Slot, beide belegt) --------------------------- */
  function openSwapPreview(srcSlot, dstSlot, machineId) {
    var date = todayIso();
    var plan = slotBuildSwap(srcSlot, dstSlot, date);
    if (!plan.valid) { showSlotToast('Diese beiden Slots lassen sich nicht tauschen.'); return; }
    var body = '' +
      '<p class="v3-slots-dialog__eyebrow">Slots tauschen</p>' +
      '<div class="v3-slots-dialog__swap">' +
        '<div class="v3-slots-dialog__swapside"><span class="v3-slots-dialog__swapcode">Slot ' + esc(srcSlot.mdb_code) + '</span>' +
          '<b>' + esc(srcSlot.product_name || '') + '</b><small>' + esc(slotQtyOf(srcSlot)) + ' Stk.</small></div>' +
        '<span class="v3-slots-dialog__swapicon" aria-hidden="true">⇄</span>' +
        '<div class="v3-slots-dialog__swapside"><span class="v3-slots-dialog__swapcode">Slot ' + esc(dstSlot.mdb_code) + '</span>' +
          '<b>' + esc(dstSlot.product_name || '') + '</b><small>' + esc(slotQtyOf(dstSlot)) + ' Stk.</small></div>' +
      '</div>' +
      '<p class="v3-slots-dialog__note">Die Produkte (inkl. Bestand) wechseln die Plätze.</p>' +
      '<p class="v3-slots-dialog__error" data-pv-error hidden></p>' +
      '<div class="v3-slots-dialog__actions">' +
        '<button type="button" class="v3-btn" data-dialog-cancel>Abbrechen</button>' +
        '<button type="button" class="v3-btn v3-btn--brand" data-pv-confirm>Tausch bestätigen</button>' +
      '</div>';
    var d = mountSlotDialog(body, 'Slots tauschen');
    if (!d) { return; }
    var confirmEl = d.card.querySelector('[data-pv-confirm]');
    confirmEl.addEventListener('click', function () {
      confirmEl.disabled = true; confirmEl.textContent = 'Wird getauscht …';
      // Zwei Slot-Change-Vorgänge nacheinander.
      postJson('/api/v2/slot-change/confirm', plan.changes[0]).then(function (r1) {
        if (!(r1.ok && r1.json && r1.json.ok)) { throw new Error((r1.json && r1.json.error && r1.json.error.message) || 'Erster Tauschschritt fehlgeschlagen.'); }
        return postJson('/api/v2/slot-change/confirm', plan.changes[1]);
      }).then(function (r2) {
        if (!(r2.ok && r2.json && r2.json.ok)) { throw new Error((r2.json && r2.json.error && r2.json.error.message) || 'Zweiter Tauschschritt fehlgeschlagen.'); }
        updateSlotCellFull(machineId, srcSlot.mdb_code, { product_id: dstSlot.product_id, product_name: dstSlot.product_name, qty: slotQtyOf(dstSlot) });
        updateSlotCellFull(machineId, dstSlot.mdb_code, { product_id: srcSlot.product_id, product_name: srcSlot.product_name, qty: slotQtyOf(srcSlot) });
        showSlotToast('Slot ' + srcSlot.mdb_code + ' und ' + dstSlot.mdb_code + ' getauscht.');
        d.close();
      }).catch(function (err) {
        dialogError(d.card, (err && err.message) || 'Tausch fehlgeschlagen.');
        confirmEl.disabled = false; confirmEl.textContent = 'Tausch bestätigen';
      });
    });
  }

  /* ---- Slot-Steuerkarte: Nachfüllen (Tap auf Slot) --------------------- */
  function openSlotControl(slotData, machineId) {
    var occupied = Number(slotData.product_id) > 0;
    if (!occupied) {
      mountSlotDialog(
        '<p class="v3-slots-dialog__eyebrow">Slot ' + esc(slotData.mdb_code) + '</p>' +
        '<p class="v3-slots-dialog__note">Dieser Slot ist frei. Ziehe eine Produkt-Kachel aus der Palette hierher, um ihn zu bestücken.</p>' +
        '<div class="v3-slots-dialog__actions"><button type="button" class="v3-btn v3-btn--brand" data-dialog-cancel>Verstanden</button></div>',
        'Slot ' + slotData.mdb_code,
      );
      return;
    }
    var d = mountSlotDialog(
      '<p class="v3-slots-dialog__eyebrow">Nachfüllen</p>' +
      '<div class="v3-slots-dialog__flow"><span class="v3-slots-dialog__product">' + esc(slotData.product_name || '') + '</span>' +
        '<span class="v3-slots-dialog__target">Slot ' + esc(slotData.mdb_code) + '</span></div>' +
      '<div data-refill-body><div class="v3-state v3-state--loading" style="min-height:120px"><span class="v3-spinner"></span><p class="v3-state__msg">Bestand wird geladen …</p></div></div>',
      'Slot ' + slotData.mdb_code + ' nachfüllen',
    );
    if (!d) { return; }

    fetchJson('/api/v2/refill/details?machine_id=' + encodeURIComponent(writeMachineId(slotData)) + '&mdb_code=' + encodeURIComponent(slotData.mdb_code))
      .then(function (res) {
        var details = res && res.data;
        if (!details) { throw new Error('Keine Bestandsdaten.'); }
        renderRefillControl(d, details, slotData, machineId);
      })
      .catch(function () {
        var bodyEl = d.card.querySelector('[data-refill-body]');
        if (bodyEl) {
          bodyEl.innerHTML = '<p class="v3-slots-dialog__error" hidden="false">Bestand konnte nicht geladen werden.</p>' +
            '<div class="v3-slots-dialog__actions"><button type="button" class="v3-btn" data-dialog-cancel>Schließen</button></div>';
          bodyEl.querySelectorAll('[data-dialog-cancel]').forEach(function (el) { el.addEventListener('click', d.close); });
        }
      });
  }

  function renderRefillControl(d, details, slotData, machineId) {
    var slot = details.slot || {};
    var cur = Number(slot.current_machine_qty || 0);
    var cap = Number(slot.capacity || 0);
    var bs = (details.backstock && details.backstock.total_qty) || 0;
    var maxFill = slotFillToCapacity(details);
    var qty = 1;

    var bodyEl = d.card.querySelector('[data-refill-body]');
    bodyEl.innerHTML = '' +
      '<div class="v3-slots-refill">' +
        '<div class="v3-slots-refill__stat"><span>Bestand</span><b data-rf-cur>' + cur + (cap ? ' / ' + cap : '') + '</b></div>' +
        '<div class="v3-slots-refill__stat"><span>Backstock</span><b>' + bs + ' Stk.</b></div>' +
      '</div>' +
      '<div class="v3-slots-refill__stepper">' +
        '<button type="button" class="v3-btn v3-slots-refill__step" data-rf-dec aria-label="weniger">−</button>' +
        '<span class="v3-slots-refill__qty" data-rf-qty>1</span>' +
        '<button type="button" class="v3-btn v3-slots-refill__step" data-rf-inc aria-label="mehr">+</button>' +
        '<button type="button" class="v3-btn v3-slots-refill__full" data-rf-full>Voll auffüllen</button>' +
      '</div>' +
      '<p class="v3-slots-refill__hint" data-rf-warn></p>' +
      '<p class="v3-slots-dialog__error" data-pv-error hidden></p>' +
      '<div class="v3-slots-dialog__actions">' +
        '<button type="button" class="v3-btn" data-dialog-cancel>Abbrechen</button>' +
        '<button type="button" class="v3-btn v3-btn--brand" data-rf-confirm>Nachfüllen bestätigen</button>' +
      '</div>';
    bodyEl.querySelectorAll('[data-dialog-cancel]').forEach(function (el) { el.addEventListener('click', d.close); });

    var qtyEl = bodyEl.querySelector('[data-rf-qty]');
    var warnEl = bodyEl.querySelector('[data-rf-warn]');
    var confirmEl = bodyEl.querySelector('[data-rf-confirm]');

    function refresh() {
      if (qty < 1) { qty = 1; }
      qtyEl.textContent = String(qty);
      var w = slotRefillWarnings(details, qty);
      warnEl.textContent = w.join(' ');
      warnEl.classList.toggle('is-warn', w.length > 0);
    }
    bodyEl.querySelector('[data-rf-dec]').addEventListener('click', function () { qty = Math.max(1, qty - 1); refresh(); });
    bodyEl.querySelector('[data-rf-inc]').addEventListener('click', function () { qty = qty + 1; refresh(); });
    bodyEl.querySelector('[data-rf-full]').addEventListener('click', function () { qty = Math.max(1, maxFill); refresh(); });
    refresh();

    confirmEl.addEventListener('click', function () {
      var params = { machine_id: writeMachineId(slotData), mdb_code: Number(slotData.mdb_code), product_id: Number(slotData.product_id), product_name: slotData.product_name || '', qty: qty };
      confirmEl.disabled = true; confirmEl.textContent = 'Wird nachgefüllt …';
      postJson('/api/v2/refill/trigger', params).then(function (res) {
        if (res.ok && res.json && res.json.ok) {
          updateSlotCellFull(machineId, slotData.mdb_code, { product_id: slotData.product_id, product_name: slotData.product_name, qty: cur + qty });
          showSlotToast('Slot ' + slotData.mdb_code + ' um ' + qty + ' Stk. nachgefüllt.');
          d.close();
        } else {
          dialogError(d.card, (res.json && res.json.error && res.json.error.message) || (res.json && res.json.message) || 'Nachfüllen fehlgeschlagen.');
          confirmEl.disabled = false; confirmEl.textContent = 'Nachfüllen bestätigen';
        }
      }).catch(function () {
        dialogError(d.card, 'Netzwerkfehler – bitte erneut versuchen.');
        confirmEl.disabled = false; confirmEl.textContent = 'Nachfüllen bestätigen';
      });
    });
  }

  /* ---- „Automat voll auffüllen" (Bulk-Refill) -------------------------- */
  /* Client-Spiegel von lib/bulk-refill.js (kanonische Logik dort getestet).
     Füllt jeden Slot bis zur Kapazität, HART begrenzt durch den real
     verfügbaren Lagerbestand je Produkt (geteilt über Slots gleichen Produkts).
     Schreibt ausschließlich über den bestehenden /api/v2/refill/trigger. */
  function bulkNum(v) { var n = Number(v); return isFinite(n) ? n : 0; }

  function bulkActiveMachine() {
    return (_slotsState.machines || [])[_slotsState.activeMachine] || null;
  }

  function bulkOccupiedSlots(machine) {
    var out = [];
    ((machine && machine.floors) || []).forEach(function (f) {
      (f.slots || []).forEach(function (s) { if (Number(s.product_id) > 0) { out.push(s); } });
    });
    return out;
  }

  function bulkRefillPlanClient(slots) {
    slots = slots || [];
    var avail = {}, remaining = {}, requested = {}, nameOf = {}, order = [];
    function desired(s) {
      var cap = bulkNum(s.capacity), cur = bulkNum(s.current_machine_qty);
      var free = s.free_capacity != null ? bulkNum(s.free_capacity) : (cap - cur);
      return Math.max(0, free);
    }
    slots.forEach(function (s) {
      var pid = bulkNum(s.product_id);
      if (pid <= 0 || Object.prototype.hasOwnProperty.call(avail, pid)) { return; }
      var st = Math.max(0, bulkNum(s.available_backstock));
      avail[pid] = st; remaining[pid] = st; requested[pid] = 0; nameOf[pid] = s.product_name || ''; order.push(pid);
    });
    var totalRefill = 0, slotsPlanned = 0, cappedCount = 0;
    var planSlots = slots.map(function (s) {
      var pid = bulkNum(s.product_id);
      var des = pid > 0 ? desired(s) : 0;
      if (pid > 0) { requested[pid] += des; }
      var qty = 0, capped = false;
      if (pid > 0 && des > 0) { var pool = remaining[pid]; qty = Math.min(des, pool); remaining[pid] = pool - qty; capped = qty < des; }
      if (qty > 0) { totalRefill += qty; slotsPlanned++; }
      if (capped) { cappedCount++; }
      return {
        machine_id: s.machine_id, mdb_code: s.mdb_code, product_id: pid, product_name: s.product_name || '',
        current_machine_qty: bulkNum(s.current_machine_qty), capacity: bulkNum(s.capacity),
        desired: des, refill_qty: qty, qty: qty, available_backstock: pid > 0 ? avail[pid] : 0, capped_by_stock: capped,
      };
    });
    var byProduct = order.map(function (pid) {
      var a = avail[pid], alloc = a - remaining[pid], req = requested[pid];
      return { product_id: pid, product_name: nameOf[pid], requested: req, allocated: alloc, available: a, short: alloc < req };
    });
    return { slots: planSlots, totalRefill: totalRefill, slotsPlanned: slotsPlanned, cappedCount: cappedCount, byProduct: byProduct };
  }

  function ensureBulkPanel() { return viewEl.querySelector('[data-slots-fillpanel]'); }
  function bindBulkClose(panel) {
    panel.querySelectorAll('[data-bulk-close]').forEach(function (b) {
      b.addEventListener('click', function () { panel.hidden = true; panel.innerHTML = ''; });
    });
  }
  function bulkPanelLoading(panel) {
    panel.hidden = false;
    panel.innerHTML = '<div class="v3-state v3-state--loading" style="min-height:88px"><span class="v3-spinner"></span><p class="v3-state__msg">Lagerbestände werden geprüft …</p></div>';
  }
  function bulkPanelMessage(panel, msg) {
    panel.hidden = false;
    panel.innerHTML = '<div class="v3-slots-fill-head"><span class="v3-slots-fill-title">Automat voll auffüllen</span>' +
      '<button type="button" class="v3-slots-fill-close" data-bulk-close aria-label="Schließen">&times;</button></div>' +
      '<p class="v3-slots-fill-empty">' + esc(msg) + '</p>';
    bindBulkClose(panel);
  }

  function bulkRefillStart(btn) {
    var machine = bulkActiveMachine();
    var panel = ensureBulkPanel();
    if (!machine || !panel) { return; }
    var occupied = bulkOccupiedSlots(machine);
    if (occupied.length === 0) { bulkPanelMessage(panel, 'Dieser Automat hat keine belegten Slots zum Auffüllen.'); return; }
    btn.disabled = true;
    var label = btn.textContent; btn.textContent = 'Bestände werden geprüft …';
    bulkPanelLoading(panel);
    var reqs = occupied.map(function (s) {
      var mid = writeMachineId(s);
      return fetchJson('/api/v2/refill/details?machine_id=' + encodeURIComponent(mid) + '&mdb_code=' + encodeURIComponent(s.mdb_code))
        .then(function (res) {
          var det = (res && res.data) || {};
          var slot = det.slot || {}; var bs = det.backstock || {};
          return {
            machine_id: mid, mdb_code: s.mdb_code, product_id: s.product_id, product_name: s.product_name,
            current_machine_qty: slot.current_machine_qty != null ? slot.current_machine_qty : s.current_machine_qty,
            capacity: slot.capacity != null ? slot.capacity : s.machine_capacity,
            free_capacity: slot.free_capacity,
            available_backstock: bs.total_qty != null ? bs.total_qty : 0,
          };
        }).catch(function () { return null; });
    });
    Promise.all(reqs).then(function (rows) {
      btn.disabled = false; btn.textContent = label;
      var plan = bulkRefillPlanClient(rows.filter(Boolean));
      bulkRenderPreview(panel, machine, plan);
    });
  }

  function bulkRenderPreview(panel, machine, plan) {
    panel.hidden = false;
    var closeBtn = '<button type="button" class="v3-slots-fill-close" data-bulk-close aria-label="Schließen">&times;</button>';
    if (plan.totalRefill === 0) {
      panel.innerHTML = '<div class="v3-slots-fill-head"><span class="v3-slots-fill-title">Automat voll auffüllen</span>' + closeBtn + '</div>' +
        '<p class="v3-slots-fill-empty">Alle belegten Slots sind bereits voll – oder es ist kein passender Lagerbestand verfügbar.</p>';
      bindBulkClose(panel);
      return;
    }
    var rows = plan.slots.filter(function (s) { return s.product_id > 0 && s.desired > 0; }).map(function (s) {
      return '<div class="v3-slots-fill-row' + (s.capped_by_stock ? ' is-capped' : '') + '">' +
        '<span class="v3-slots-fill-row__name">' + esc(s.product_name || ('Slot ' + s.mdb_code)) + ' <em>· Slot ' + esc(s.mdb_code) + '</em></span>' +
        '<span class="v3-slots-fill-row__qty">' + s.current_machine_qty + ' &#8594; ' + (s.current_machine_qty + s.refill_qty) + (s.capacity ? ' / ' + s.capacity : '') + '</span>' +
        (s.refill_qty > 0 ? '<span class="v3-slots-fill-row__add">+' + s.refill_qty + '</span>' : '<span class="v3-slots-fill-row__add is-zero">+0</span>') +
        (s.capped_by_stock ? '<span class="v3-slots-fill-row__cap">Lager begrenzt</span>' : '') +
      '</div>';
    }).join('');
    var shortProducts = plan.byProduct.filter(function (p) { return p.short; });
    var shortNote = shortProducts.length
      ? '<p class="v3-slots-fill-note">Begrenzt durch Lagerbestand: ' +
        shortProducts.map(function (p) { return esc(p.product_name) + ' (' + p.allocated + ' von ' + p.requested + ' möglich)'; }).join(', ') + '.</p>'
      : '';
    panel.innerHTML =
      '<div class="v3-slots-fill-head"><span class="v3-slots-fill-title">Voll auffüllen · ' + esc(machine.machine_name) + '</span>' + closeBtn + '</div>' +
      '<p class="v3-slots-fill-lead">Aufgefüllt wird bis zur Kapazität und <b>höchstens so viel, wie im Lager verfügbar ist</b>.</p>' +
      '<div class="v3-slots-fill-rows">' + rows + '</div>' + shortNote +
      '<div class="v3-slots-fill-actions">' +
        '<span class="v3-slots-fill-sum">' + plan.slotsPlanned + ' Slot(s) · +' + plan.totalRefill + ' Stk.</span>' +
        '<button type="button" class="v3-btn" data-bulk-close>Abbrechen</button>' +
        '<button type="button" class="v3-btn v3-btn--brand" data-bulk-confirm>Auffüllen bestätigen</button>' +
      '</div>';
    bindBulkClose(panel);
    var cBtn = panel.querySelector('[data-bulk-confirm]');
    if (cBtn) { cBtn.addEventListener('click', function () { bulkConfirm(panel, plan); }); }
    if (panel.scrollIntoView) { panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
  }

  function bulkConfirm(panel, plan) {
    var toFill = plan.slots.filter(function (s) { return s.refill_qty > 0; });
    if (toFill.length === 0) { return; }
    var cBtn = panel.querySelector('[data-bulk-confirm]');
    if (cBtn) { cBtn.disabled = true; cBtn.textContent = 'Wird aufgefüllt …'; }
    var done = 0, failed = 0;
    var jobs = toFill.map(function (s) {
      return postJson('/api/v2/refill/trigger', {
        machine_id: s.machine_id, mdb_code: Number(s.mdb_code), product_id: Number(s.product_id),
        product_name: s.product_name || '', qty: s.refill_qty,
      }).then(function (r) {
        if (r.ok && r.json && r.json.ok) { done++; } else { failed++; }
      }).catch(function () { failed++; });
    });
    Promise.all(jobs).then(function () {
      panel.hidden = true; panel.innerHTML = '';
      showSlotToast(done + ' Slot(s) aufgefüllt' + (failed ? ' · ' + failed + ' fehlgeschlagen' : '') + '.');
      renderRoute(ROUTE_BY_PATH['/slots']);   // Bestände neu laden
    });
  }

  /* ---- „Aus Nayax abgleichen" (Vollabgleich Slotbelegung + Füllstand) -- */
  /* Vorschau (read-only, auch Gäste) -> /api/v2/nayax-abgleich/preview liefert
     den vollständigen Diff (Umbuchung alt->neu, Menge alt->neu, Onboarding-Liste,
     PG-only-Slots). Übernahme (admin-only, Confirm) -> /api/v2/nayax-abgleich/apply
     mit expected_guard (Drift-Schutz). Onboarding/unmatchbar wird übersprungen.
     Reine Vanilla-JS, gespiegelt am Bulk-Panel (gleiche v3-slots-fill*-Klassen). */
  function ensureAbgleichPanel() {
    // Auf document.body portiert (via slotsBodyHost), damit das position:fixed-
    // Bottom-Sheet relativ zum Viewport sitzt und nicht vom transform-Vorfahr
    // der View weit nach unten gezogen wird (sonst auf dem Handy "unsichtbar").
    var p = slotsBodyHost('v3-slots-abgleich-host', 'v3-slots-fillpanel');
    p.setAttribute('data-slots-abgleichpanel', '');
    return p;
  }
  function bindAbgleichClose(panel) {
    panel.querySelectorAll('[data-abgleich-close]').forEach(function (b) {
      b.addEventListener('click', function () { panel.hidden = true; panel.innerHTML = ''; });
    });
  }
  function abgleichHead(title) {
    return '<div class="v3-slots-fill-head"><span class="v3-slots-fill-title">' + esc(title) + '</span>' +
      '<button type="button" class="v3-slots-fill-close" data-abgleich-close aria-label="Schließen">&times;</button></div>';
  }

  // WICHTIG: fetchJson() liefert den geparsten Body DIREKT zurueck (und wirft bei
  // HTTP non-ok) — NICHT { ok, json }. Daher hier den Body direkt auswerten.
  function nayaxAbgleichFetch(panel, machine, machineKey, btn, label, attempt) {
    panel.hidden = false;
    panel.innerHTML = '<div class="v3-state v3-state--loading" style="min-height:88px"><span class="v3-spinner"></span>' +
      '<p class="v3-state__msg">Nayax-Bestand wird gelesen und abgeglichen …' + (attempt > 1 ? ' (erneuter Versuch)' : '') + '</p></div>';
    fetchJson('/api/v2/nayax-abgleich/preview?machine=' + encodeURIComponent(machineKey)).then(function (data) {
      if (data && data.ok) {
        if (btn) { btn.disabled = false; btn.textContent = label; }
        // #29: Nayax-Übernehmen erfordert nayax.schreiben (nicht nur Slot-Edit).
        nayaxAbgleichRenderPreview(panel, machine, data, machineKey, viewerCan('nayax.schreiben'));
        return;
      }
      var reason = (data && data.error && (data.error.message || data.error.code)) || 'unerwartete Antwort';
      nayaxAbgleichFailOrRetry(panel, machine, machineKey, btn, label, attempt, reason);
    }).catch(function (e) {
      nayaxAbgleichFailOrRetry(panel, machine, machineKey, btn, label, attempt, (e && e.message) ? ('HTTP ' + e.message) : 'Netzwerkfehler');
    });
  }

  function nayaxAbgleichFailOrRetry(panel, machine, machineKey, btn, label, attempt, reason) {
    // Transiente Aussetzer (langsamer Nayax-Call/Netz-Blip) einmal automatisch wiederholen.
    if (attempt < 2) { window.setTimeout(function () { nayaxAbgleichFetch(panel, machine, machineKey, btn, label, attempt + 1); }, 1500); return; }
    if (btn) { btn.disabled = false; btn.textContent = label; }
    panel.hidden = false;
    panel.innerHTML = abgleichHead('Aus Nayax abgleichen') +
      '<p class="v3-slots-fill-empty">Konnte nicht geladen werden (' + esc(reason) + ').</p>' +
      '<div class="v3-slots-fill-actions">' +
        '<button type="button" class="v3-btn" data-abgleich-close>Schließen</button>' +
        '<button type="button" class="v3-btn v3-btn--brand" data-abgleich-retry>Nochmal versuchen</button>' +
      '</div>';
    bindAbgleichClose(panel);
    var r = panel.querySelector('[data-abgleich-retry]');
    if (r) { r.addEventListener('click', function () { nayaxAbgleichFetch(panel, machine, machineKey, null, '', 1); }); }
  }

  function nayaxAbgleichStart(btn) {
    var machine = bulkActiveMachine();
    var panel = ensureAbgleichPanel();
    if (!machine || !panel) { return; }
    var machineKey = btn.getAttribute('data-slots-nayax-abgleich') || machine.machine_id;
    btn.disabled = true;
    var label = btn.textContent; btn.textContent = 'Nayax wird gelesen …';
    nayaxAbgleichFetch(panel, machine, machineKey, btn, label, 1);
  }

  function abgleichArrow(a, b) { return esc(a) + ' &#8594; ' + esc(b); }

  function nayaxAbgleichRenderPreview(panel, machine, diff, machineKey, canEdit) {
    panel.hidden = false;
    var ac = diff.assignment_changes || [];
    var qc = diff.qty_changes || [];
    var ob = diff.onboarding || [];
    var pgOnly = diff.pg_only_slots || [];
    var nChanges = ac.length + qc.length;

    if (nChanges === 0 && ob.length === 0 && pgOnly.length === 0) {
      panel.innerHTML = abgleichHead('Aus Nayax abgleichen · ' + machine.machine_name) +
        '<p class="v3-slots-fill-empty">Alles im Einklang mit Nayax – keine Abweichung in Belegung oder Menge.</p>';
      bindAbgleichClose(panel);
      return;
    }

    var sections = '';
    if (ac.length) {
      sections += '<p class="v3-slots-fill-lead"><b>Produktwechsel (Umbuchung)</b> – Belegung wird angepasst, Menge mitgesetzt.</p>' +
        '<div class="v3-slots-fill-rows">' + ac.map(function (c) {
          return '<div class="v3-slots-fill-row">' +
            '<span class="v3-slots-fill-row__name">' + abgleichArrow(c.old_product_name || ('#' + c.old_product_id), c.new_product_name || ('#' + c.new_product_id)) + ' <em>· Slot ' + esc(c.mdb_code) + '</em></span>' +
            '<span class="v3-slots-fill-row__qty">' + esc(c.old_qty) + ' &#8594; ' + esc(c.new_qty) + '</span>' +
            '<span class="v3-slots-fill-row__cap">Umbuchung</span>' +
          '</div>';
        }).join('') + '</div>';
    }
    if (qc.length) {
      sections += '<p class="v3-slots-fill-lead"><b>Mengen-Abgleich</b> – gleiches Produkt, Füllstand aus Nayax.</p>' +
        '<div class="v3-slots-fill-rows">' + qc.map(function (q) {
          var d = Number(q.new_qty) - Number(q.old_qty);
          return '<div class="v3-slots-fill-row">' +
            '<span class="v3-slots-fill-row__name">' + esc(q.product_name || ('Slot ' + q.mdb_code)) + ' <em>· Slot ' + esc(q.mdb_code) + '</em></span>' +
            '<span class="v3-slots-fill-row__qty">' + esc(q.old_qty) + ' &#8594; ' + esc(q.new_qty) + '</span>' +
            '<span class="v3-slots-fill-row__add' + (d < 0 ? ' is-zero' : '') + '">' + (d >= 0 ? '+' : '') + d + '</span>' +
          '</div>';
        }).join('') + '</div>';
    }
    if (ob.length) {
      sections += '<p class="v3-slots-fill-note"><b>Neue / unbekannte Produkte – erst onboarden</b> (werden beim Übernehmen übersprungen):<br>' +
        ob.map(function (o) {
          var why = o.reason === 'kein_match' ? 'kein Produkt-Treffer' : 'noch kein Slot im Dashboard';
          return esc(o.product_name || ('Slot ' + o.mdb_code)) + ' (Slot ' + esc(o.mdb_code) + ', ' + esc(o.on_hand) + ' Stk., ' + why + ')';
        }).join('; ') + '.</p>';
    }
    if (pgOnly.length) {
      sections += '<p class="v3-slots-fill-note">Im Dashboard, aber nicht in Nayax (nur Hinweis, wird nicht geändert): ' +
        pgOnly.map(function (s) { return esc(s.product_name || ('Slot ' + s.mdb_code)) + ' (Slot ' + esc(s.mdb_code) + ')'; }).join('; ') + '.</p>';
    }

    var expectedQtySum = ac.reduce(function (s, c) { return s + Number(c.new_qty || 0); }, 0)
      + qc.reduce(function (s, q) { return s + Number(q.new_qty || 0); }, 0);

    var actionRight = canEdit
      ? '<button type="button" class="v3-btn" data-abgleich-close>Abbrechen</button>' +
        '<button type="button" class="v3-btn v3-btn--brand" data-abgleich-confirm' + (nChanges === 0 ? ' disabled' : '') + '>Übernehmen</button>'
      : '<span class="v3-slots-fill-note" style="margin:0">Übernehmen ist Admins vorbehalten.</span>' +
        '<button type="button" class="v3-btn" data-abgleich-close>Schließen</button>';

    panel.innerHTML =
      abgleichHead('Aus Nayax abgleichen · ' + machine.machine_name) +
      sections +
      '<div class="v3-slots-fill-actions">' +
        '<span class="v3-slots-fill-sum">' + nChanges + ' Änderung(en) · ' + ac.length + ' Umbuchung · ' + qc.length + ' Menge</span>' +
        actionRight +
      '</div>';
    bindAbgleichClose(panel);
    var cBtn = panel.querySelector('[data-abgleich-confirm]');
    if (cBtn) {
      cBtn.addEventListener('click', function () {
        nayaxAbgleichConfirm(panel, machine, machineKey, { expected_changes: nChanges, expected_qty_sum: expectedQtySum });
      });
    }
    if (panel.scrollIntoView) { panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
  }

  function nayaxAbgleichConfirm(panel, machine, machineKey, expectedGuard) {
    var cBtn = panel.querySelector('[data-abgleich-confirm]');
    if (cBtn) { cBtn.disabled = true; cBtn.textContent = 'Wird übernommen …'; }
    postJson('/api/v2/nayax-abgleich/apply', { machine: machineKey, expected_guard: expectedGuard }).then(function (r) {
      if (r.ok && r.json && r.json.ok) {
        var applied = r.json.applied != null ? r.json.applied : '?';
        var skipped = (r.json.skipped && (r.json.skipped.onboarding + r.json.skipped.pg_only)) || 0;
        panel.hidden = true; panel.innerHTML = '';
        showSlotToast(applied + ' Slot(s) aus Nayax übernommen' + (skipped ? ' · ' + skipped + ' übersprungen (Onboarding)' : '') + '.');
        renderRoute(ROUTE_BY_PATH['/slots']);   // Belegung + Bestände neu laden
        return;
      }
      var err = (r.json && r.json.error && r.json.error.code) || '';
      var msg = (r.json && r.json.error && r.json.error.message) || (r.json && r.json.message) || 'Übernahme fehlgeschlagen.';
      if (err === 'PREVIEW_VERALTET') {
        // Daten haben sich seit der Vorschau geändert -> Vorschau neu laden.
        var startBtn = viewEl.querySelector('[data-slots-nayax-abgleich="' + machineKey + '"]');
        if (startBtn) { nayaxAbgleichStart(startBtn); }
        showSlotToast(msg);
        return;
      }
      if (cBtn) { cBtn.disabled = false; cBtn.textContent = 'Übernehmen'; }
      var sum = panel.querySelector('.v3-slots-fill-sum');
      if (sum) { sum.textContent = msg; }
    }).catch(function () {
      if (cBtn) { cBtn.disabled = false; cBtn.textContent = 'Übernehmen'; }
      var sum = panel.querySelector('.v3-slots-fill-sum');
      if (sum) { sum.textContent = 'Netzwerkfehler bei der Übernahme.'; }
    });
  }

  /* ---- Zustand + Hilfsfunktionen --------------------------------------- */
  var _slotsState = { machines: [], palette: [], canEdit: false, activeMachine: 0 };

  function machineById(id) {
    return (_slotsState.machines || []).filter(function (x) { return String(x.machine_id) === String(id); })[0];
  }
  function findSlotData(machineId, mdbCode) {
    var m = machineById(machineId);
    if (!m) { return null; }
    var found = null;
    m.floors.forEach(function (f) { f.slots.forEach(function (s) { if (String(s.mdb_code) === String(mdbCode)) { found = s; } }); });
    return found;
  }
  function activeMachineId() {
    var m = _slotsState.machines[_slotsState.activeMachine];
    return m ? m.machine_id : '';
  }

  function updateSlotCellFull(machineId, mdbCode, info) {
    var slot = findSlotData(machineId, mdbCode);
    if (slot) {
      slot.product_id = info.product_id;
      slot.product_name = info.product_name;
      slot.current_machine_qty = info.qty;
      var cap = (slot.occupancy && slot.occupancy.machine_capacity) || slot.machine_capacity || 0;
      slot.occupancy = Object.assign({}, slot.occupancy, {
        current_machine_qty: info.qty,
        machine_capacity: cap,
        fill_pct: cap > 0 ? Math.round((info.qty / cap) * 100) : (slot.occupancy ? slot.occupancy.fill_pct : null),
      });
    }
    var cell = viewEl.querySelector('[data-slots-stagewrap] [data-slot-mdb="' + mdbCode + '"]');
    if (slot && cell) {
      var tmp = document.createElement('div');
      tmp.innerHTML = renderSlotCell(slot, _slotsState.canEdit);
      var nc = tmp.firstChild;
      nc.classList.add('v3-slot--justset');
      cell.replaceWith(nc);
    }
  }

  function showSlotToast(message) {
    var toast = slotsBodyHost('v3-slots-toast-host', 'v3-toast');
    toast.textContent = message;
    toast.hidden = false;
    toast.classList.add('is-show');
    window.clearTimeout(showSlotToast._t);
    showSlotToast._t = window.setTimeout(function () {
      toast.classList.remove('is-show');
      window.setTimeout(function () { toast.hidden = true; }, 240);
    }, 2600);
  }

  /* ---- Echtes Drag&Drop via Pointer-Events (Maus + Touch) -------------- */
  var _drag = null;

  function dragPayloadFromEl(el) {
    var kind = el.getAttribute('data-draggable');
    if (kind === 'palette') {
      return { kind: 'palette', label: el.getAttribute('data-product-name') || '', item: {
        product_id:  Number(el.getAttribute('data-product-id')),
        product_key: el.getAttribute('data-product-key') || null,
        name:        el.getAttribute('data-product-name') || '',
      } };
    }
    if (kind === 'slot') {
      var slot = findSlotData(activeMachineId(), el.getAttribute('data-slot-mdb'));
      return { kind: 'slot', label: (slot && slot.product_name) || ('Slot ' + el.getAttribute('data-slot-mdb')), slot: slot };
    }
    return null;
  }

  function slotsRootHasEl(el) {
    var root = viewEl.querySelector('[data-slots-root]');
    return root && el && root.contains(el);
  }

  function onSlotsPointerDown(e) {
    if (!_slotsState.canEdit || _drag) { return; }
    if (e.button != null && e.button > 0) { return; }
    var dragEl = e.target.closest && e.target.closest('[data-draggable]');
    var slotEl = e.target.closest && e.target.closest('[data-slot]');
    var el = dragEl || slotEl;
    if (!el || !slotsRootHasEl(el)) { return; }
    _drag = { srcEl: el, draggable: !!dragEl, payload: dragEl ? dragPayloadFromEl(dragEl) : null, startX: e.clientX, startY: e.clientY, moved: false, ghost: null, pointerId: e.pointerId, lastTarget: null };
  }

  // Hebt den Slot unter dem Zeiger hervor (Drop-Ziel).
  function updateDropHighlight(x, y) {
    if (!_drag) { return; }
    var under = document.elementFromPoint(x, y);
    var slotEl = under && under.closest ? under.closest('[data-slot]') : null;
    if (_drag.lastTarget && _drag.lastTarget !== slotEl) { _drag.lastTarget.classList.remove('v3-slot--drop'); }
    if (slotEl) { slotEl.classList.add('v3-slot--drop'); }
    _drag.lastTarget = slotEl;
  }

  // Auto-Scroll: zieht man an den oberen/unteren Viewport-Rand, scrollt das
  // Fenster mit (sonst sind tiefer liegende Etagen beim Ziehen unerreichbar,
  // da das native Scrollen während des Drags unterdrückt wird).
  function autoScrollTick() {
    if (!_drag || !_drag.moved) { return; }
    var vh = window.innerHeight;
    var y = _drag.lastClientY;
    var EDGE = 90, MAX = 22;
    var speed = 0;
    if (y < EDGE) { speed = -MAX * (1 - Math.max(0, y) / EDGE); }
    else if (y > vh - EDGE) { speed = MAX * (1 - Math.max(0, vh - y) / EDGE); }
    if (speed !== 0) {
      window.scrollBy(0, speed);
      updateDropHighlight(_drag.lastClientX, _drag.lastClientY);
    }
    _drag.autoScroll = window.requestAnimationFrame(autoScrollTick);
  }

  function onSlotsPointerMove(e) {
    if (!_drag || _drag.pointerId !== e.pointerId) { return; }
    var dx = e.clientX - _drag.startX, dy = e.clientY - _drag.startY;
    var dist = Math.sqrt(dx * dx + dy * dy);
    // Nicht ziehbare Slots (leere): Bewegung bricht nur den Tap ab, kein Drag.
    if (!_drag.draggable) { if (dist >= 8) { _drag.moved = true; } return; }
    if (!_drag.moved) {
      if (dist < 6) { return; }
      _drag.moved = true;
      try { _drag.srcEl.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      _drag.ghost = document.createElement('div');
      _drag.ghost.className = 'v3-slots-ghost';
      _drag.ghost.textContent = _drag.payload ? _drag.payload.label : '';
      document.body.appendChild(_drag.ghost);
      _drag.srcEl.classList.add('is-dragging');
      var root = viewEl.querySelector('[data-slots-root]');
      if (root) { root.classList.add('is-dragging-active'); }
      _drag.autoScroll = window.requestAnimationFrame(autoScrollTick);
    }
    e.preventDefault();
    _drag.lastClientX = e.clientX;
    _drag.lastClientY = e.clientY;
    _drag.ghost.style.left = e.clientX + 'px';
    _drag.ghost.style.top = e.clientY + 'px';
    updateDropHighlight(e.clientX, e.clientY);
  }

  function onSlotsPointerUp(e) {
    if (!_drag || _drag.pointerId !== e.pointerId) { return; }
    var d = _drag; _drag = null;
    if (d.autoScroll) { window.cancelAnimationFrame(d.autoScroll); }
    if (d.ghost) { d.ghost.remove(); }
    d.srcEl.classList.remove('is-dragging');
    var root = viewEl.querySelector('[data-slots-root]');
    if (root) { root.classList.remove('is-dragging-active'); }
    if (d.lastTarget) { d.lastTarget.classList.remove('v3-slot--drop'); }
    try { d.srcEl.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }

    if (!d.moved) {
      // Reiner Tap/Klick -> Slot-Steuerkarte
      var tapSlotEl = d.srcEl.closest('[data-slot]');
      if (tapSlotEl) {
        var sd = findSlotData(activeMachineId(), tapSlotEl.getAttribute('data-slot-mdb'));
        if (sd) { openSlotControl(sd, activeMachineId()); }
      }
      return;
    }
    var under = document.elementFromPoint(e.clientX, e.clientY);
    var targetEl = under && under.closest ? under.closest('[data-slot]') : null;
    if (!targetEl || !d.payload) { return; }
    var targetSlot = findSlotData(activeMachineId(), targetEl.getAttribute('data-slot-mdb'));
    if (!targetSlot) { return; }

    if (d.payload.kind === 'palette') {
      openPlacePreview(d.payload.item, targetSlot, activeMachineId());
    } else if (d.payload.kind === 'slot' && d.payload.slot) {
      if (String(d.payload.slot.mdb_code) === String(targetSlot.mdb_code)) { return; }
      if (Number(targetSlot.product_id) > 0) {
        openSwapPreview(d.payload.slot, targetSlot, activeMachineId());
      } else {
        showSlotToast('Nur Tauschen zwischen zwei belegten Slots möglich – leere Slots aus der Palette bestücken.');
      }
    }
  }

  function bindSlotEditor(data) {
    _slotsState = {
      machines: (data && data.machines) || [],
      palette:  (data && data.palette)  || [],
      canEdit:  !!(data && data.canEdit),
      activeMachine: 0,
    };
    var root = viewEl.querySelector('[data-slots-root]');
    if (!root) { return; }

    // Drehzahl-Filter: setzt das data-turnover-filter-Attribut auf den (beim
    // Automatenwechsel bestehenbleibenden) Stage-Wrapper; CSS dimmt Nicht-Treffer.
    var stagewrapEl = viewEl.querySelector('[data-slots-stagewrap]');
    viewEl.querySelectorAll('[data-slots-turnover]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var key = btn.getAttribute('data-slots-turnover') || '';
        if (stagewrapEl) {
          if (key) { stagewrapEl.setAttribute('data-turnover-filter', key); }
          else { stagewrapEl.removeAttribute('data-turnover-filter'); }
        }
        viewEl.querySelectorAll('[data-slots-turnover]').forEach(function (b) {
          var active = b === btn;
          b.classList.toggle('v3-chip--active', active);
          b.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
      });
    });

    // Maschinenwahl
    viewEl.querySelectorAll('[data-slots-machine]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        _slotsState.activeMachine = Number(btn.getAttribute('data-slots-machine')) || 0;
        viewEl.querySelectorAll('[data-slots-machine]').forEach(function (b) {
          var active = b === btn;
          b.classList.toggle('v3-chip--active', active);
          b.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        var stagewrap = viewEl.querySelector('[data-slots-stagewrap]');
        if (stagewrap) { stagewrap.innerHTML = renderMachineStage(_slotsState.machines[_slotsState.activeMachine], _slotsState.canEdit); }
      });
    });

    // Etagen ein-/ausklappen – reine Ansicht-Steuerung, daher auch für Gäste.
    // Delegiert auf root, damit der Handler den Stage-Neuaufbau (Automatenwechsel)
    // übersteht; Zustand wird pro Automat+Etage in localStorage gemerkt.
    root.addEventListener('click', function (e) {
      var tg = e.target.closest && e.target.closest('[data-floor-toggle]');
      if (!tg) { return; }
      var floor = tg.closest('[data-slots-floor]');
      if (!floor) { return; }
      var willCollapse = floor.getAttribute('data-floor-collapsed') !== 'true';
      floor.setAttribute('data-floor-collapsed', willCollapse ? 'true' : 'false');
      tg.setAttribute('aria-expanded', willCollapse ? 'false' : 'true');
      // Ausdrückliche Wahl explizit merken (true=zu, false=auf), damit sie auch
      // gegen den Viewport-Default (Handy=zu) bestehen bleibt.
      var map = loadCollapsedFloors();
      var key = floor.getAttribute('data-floor-key');
      map[key] = !!willCollapse;
      saveCollapsedFloors(map);
    });

    // „Aus Nayax abgleichen" – Vorschau ist read-only (auch Gäste), daher VOR
    // dem canEdit-Return gebunden. Delegiert auf root (übersteht Stage-Neuaufbau).
    root.addEventListener('click', function (e) {
      var ab = e.target.closest && e.target.closest('[data-slots-nayax-abgleich]');
      if (ab) { nayaxAbgleichStart(ab); }
    });

    if (!_slotsState.canEdit) { return; }

    // „Automat voll auffüllen" – delegiert auf root, übersteht den Stage-Neuaufbau
    root.addEventListener('click', function (e) {
      var fb = e.target.closest && e.target.closest('[data-slots-fillall]');
      if (fb) { bulkRefillStart(fb); }
    });

    // Palette-Suche (nutzt vorhandene Produkt-/Refill-Suche)
    var searchEl = viewEl.querySelector('[data-palette-search]');
    var listEl   = viewEl.querySelector('[data-palette-list]');
    if (searchEl && listEl) {
      var t = null;
      searchEl.addEventListener('input', function () {
        window.clearTimeout(t);
        t = window.setTimeout(function () {
          fetchJson('/api/v2/products/catalog?q=' + encodeURIComponent(searchEl.value || '')).then(function (res) {
            var items = slotBuildPalette((res && res.results) || []);
            _slotsState.palette = items;
            listEl.innerHTML = renderPaletteTiles(items);
          }).catch(function () { /* Suche still ignorieren */ });
        }, 220);
      });
    }

    // Pointer-Drag global einmalig binden (No-Op solange kein Drag läuft).
    if (!bindSlotEditor._pointerBound) {
      document.addEventListener('pointerdown', onSlotsPointerDown);
      document.addEventListener('pointermove', onSlotsPointerMove, { passive: false });
      document.addEventListener('pointerup', onSlotsPointerUp);
      document.addEventListener('pointercancel', onSlotsPointerUp);
      bindSlotEditor._pointerBound = true;
    }
  }

  /* ---- Einstellungen-Seite (/einstellungen) ----------------------------- */
  /* Zeigt + editiert die Kategorie-/Schwellwert-Config (Branchen-Anker).
     Quelle: GET/POST /api/v2/settings/definitions → docs/UBIQUITOUS_LANGUAGE.md.
     Lesen für alle, Schreiben nur für Admins (canEdit). */
  function numField(label, key, value, step, hint) {
    return '<label class="v3-set-field">' +
      '<span class="v3-set-field__label">' + esc(label) + '</span>' +
      '<input class="v3-set-input" type="number" step="' + esc(step || '1') + '" data-set-key="' + esc(key) + '" value="' + esc(value) + '">' +
      (hint ? '<span class="v3-set-field__hint">' + esc(hint) + '</span>' : '') +
    '</label>';
  }

  function renderSettingsPage(settings, canEdit) {
    var sm = (settings && settings.slowMover) || { classes: [], ladenhueterDays: 30, graceDays: 14 };
    var cfg = (settings && settings.config) || {};
    var cats = cfg.categories || {};
    var latten = cfg.latten || {};
    var ro = canEdit ? '' : ' disabled';

    var classRows = (sm.classes || []).map(function (c) {
      return '<li class="v3-set-def">' +
        '<span class="v3-badge v3-badge--turnover v3-badge--turnover-' + esc(c.key) + '">' + esc(c.label) + '</span>' +
        '<span class="v3-set-def__text">' + esc(c.description) + '</span>' +
      '</li>';
    }).join('');

    // Kategorie-Zeilen: Label + Marge (%) editierbar, abgeleitete Geld-Latten je Woche.
    var catRows = Object.keys(cats).map(function (key) {
      var c = cats[key]; var l = latten[key] || {};
      return '<tr data-set-cat="' + esc(key) + '">' +
        '<td><code>' + esc(key) + '</code></td>' +
        '<td><input class="v3-set-input v3-set-input--cat" data-cat-field="label" type="text" value="' + esc(c.label || key) + '"' + ro + '></td>' +
        '<td><input class="v3-set-input v3-set-input--cat v3-set-input--num" data-cat-field="marginPct" type="number" step="1" value="' + esc(c.marginPct) + '"' + ro + '></td>' +
        '<td class="v3-set-latte">Renner ≥ ' + esc(l.rennerThreshold) + ' € · Langsam ≤ ' + esc(l.langsamThreshold) + ' € /Woche</td>' +
      '</tr>';
    }).join('');

    var addCat = canEdit ? '' +
      '<div class="v3-set-addcat">' +
        '<input class="v3-set-input" id="v3-set-newcat-key" type="text" placeholder="schlüssel (z. B. spielzeug)">' +
        '<input class="v3-set-input" id="v3-set-newcat-label" type="text" placeholder="Anzeigename">' +
        '<input class="v3-set-input v3-set-input--num" id="v3-set-newcat-margin" type="number" step="1" placeholder="Marge %">' +
        '<button type="button" class="v3-btn v3-btn--ghost" id="v3-set-addcat-btn">Kategorie hinzufügen</button>' +
      '</div>' : '';

    var saveBar = canEdit ? '' +
      '<div class="v3-set-savebar">' +
        '<button type="button" class="v3-btn v3-btn--primary" id="v3-set-save">Einstellungen speichern</button>' +
        '<span class="v3-set-status" id="v3-set-status" role="status"></span>' +
      '</div>' : '<p class="v3-state__msg">Nur Admins können diese Werte ändern (Read-Only-Zugang).</p>';

    // Besteuerungsmodell (#56): steuert Netto- vs. Brutto-EK im Wareneinsatz.
    var taxSel = '' +
      '<section class="v3-card" aria-label="Besteuerungsmodell">' +
        '<h3 class="v3-set-subtitle">Besteuerungsmodell</h3>' +
        '<p class="v3-state__msg" style="margin:0 0 12px"><strong>Kleinunternehmer</strong> (§19 UStG) bucht den <strong>Brutto-EK</strong> als Wareneinsatz (gezahlte MwSt ist echte, nicht erstattete Kosten); <strong>regelbesteuert</strong> den <strong>Netto-EK</strong> (Vorsteuer wird erstattet). Wirkt auf die Live-Marge und ab dem nächsten Lauf auf die Nacht-GuV (WF8). Default für neue Mandanten: regelbesteuert.</p>' +
        '<label class="v3-set-field">' +
          '<span class="v3-set-field__label">Modell</span>' +
          '<select class="v3-set-input" data-set-tax="1"' + ro + '>' +
            '<option value="regelbesteuert"' + (cfg.kleinunternehmerAktiv ? '' : ' selected') + '>Regelbesteuert (Netto-EK)</option>' +
            '<option value="kleinunternehmer"' + (cfg.kleinunternehmerAktiv ? ' selected' : '') + '>Kleinunternehmer §19 (Brutto-EK)</option>' +
          '</select>' +
        '</label>' +
      '</section>';

    return '' +
      '<section class="v3-card" aria-label="Drehzahl-Klassifikation">' +
        '<h2 class="v3-set-title">Drehgeschwindigkeits-Klassen (Branchen-Anker)</h2>' +
        '<p class="v3-state__msg" style="margin:0 0 16px">Maßstab ist der <strong>Deckungsbeitrag pro Slot und Woche</strong> (4-Wochen-Fenster) gegen eine kategorie-eigene Geld-Latte aus der Branchennorm — nicht die reine Stückzahl. Verbindlich im Glossar <code>docs/UBIQUITOUS_LANGUAGE.md</code>, Logik in <code>lib/slow-mover.js</code> + <code>lib/category-config.js</code>.</p>' +
        '<ul class="v3-set-defs">' + classRows + '</ul>' +
      '</section>' +
      taxSel +
      '<section class="v3-card" aria-label="Schwellwerte & Margen">' +
        '<h3 class="v3-set-subtitle">Schwellwerte</h3>' +
        '<div class="v3-set-grid">' +
          numField('Ladenhüter-Schwelle (Tage)', 'ladenhueterDays', cfg.ladenhueterDays, '1', '0 Verkäufe seit ≥ so vielen Tagen.') +
          numField('Schonfrist neue Produkte (Tage)', 'graceDays', cfg.graceDays, '1', 'Jünger gelistet → Klasse „Neu", nie Langsam.') +
          numField('Umsatz-Norm (€/Automat/Monat)', 'umsatzNormMonth', cfg.umsatzNormMonth, '10', 'Branchen-Anker, Quelle der Geld-Latte.') +
          numField('Slots je Automat', 'slotsPerMachine', cfg.slotsPerMachine, '1', 'Für die Umrechnung auf €/Slot/Woche.') +
          numField('Renner-Faktor', 'rennerFactor', cfg.rennerFactor, '0.05', 'Renner ab Erwartungswert × Faktor.') +
          numField('Langsam-Faktor', 'langsamFactor', cfg.langsamFactor, '0.05', 'Langsam unter Erwartungswert × Faktor.') +
          numField('Default-Marge unbek. Kategorie (%)', 'defaultMarginPct', cfg.defaultMarginPct, '1', 'Fallback für neue Kategorien.') +
        '</div>' +
        '<h3 class="v3-set-subtitle">Kategorie-Margen</h3>' +
        '<table class="v3-set-cattable"><thead><tr><th>Schlüssel</th><th>Anzeigename</th><th>Marge %</th><th>Geld-Latte (abgeleitet)</th></tr></thead>' +
          '<tbody>' + catRows + '</tbody></table>' +
        addCat +
        saveBar +
      '</section>';
  }

  // Sammelt die editierten Werte und speichert sie (Admin) über den Schreibpfad.
  function bindSettingsControls() {
    var saveBtn = document.getElementById('v3-set-save');
    if (!saveBtn) { return; } // Read-Only: keine Steuerung.
    var statusEl = document.getElementById('v3-set-status');

    function collectOverride() {
      var override = { categories: {} };
      document.querySelectorAll('.v3-set-input[data-set-key]').forEach(function (inp) {
        var v = inp.value.trim();
        if (v !== '') { override[inp.getAttribute('data-set-key')] = Number(v); }
      });
      var taxEl = document.querySelector('[data-set-tax]');
      if (taxEl) { override.kleinunternehmerAktiv = (taxEl.value === 'kleinunternehmer'); }
      document.querySelectorAll('tr[data-set-cat]').forEach(function (row) {
        var key = row.getAttribute('data-set-cat');
        var entry = {};
        var label = row.querySelector('[data-cat-field="label"]');
        var margin = row.querySelector('[data-cat-field="marginPct"]');
        if (label && label.value.trim() !== '') { entry.label = label.value.trim(); }
        if (margin && margin.value.trim() !== '') { entry.marginPct = Number(margin.value); }
        override.categories[key] = entry;
      });
      return override;
    }

    var addBtn = document.getElementById('v3-set-addcat-btn');
    if (addBtn) {
      addBtn.addEventListener('click', function () {
        var key = (document.getElementById('v3-set-newcat-key').value || '').trim().toLowerCase();
        var label = (document.getElementById('v3-set-newcat-label').value || '').trim();
        var margin = (document.getElementById('v3-set-newcat-margin').value || '').trim();
        if (!key) { statusEl.textContent = 'Bitte einen Kategorie-Schlüssel angeben.'; return; }
        var override = collectOverride();
        override.categories[key] = { label: label || key, marginPct: margin === '' ? undefined : Number(margin) };
        save(override);
      });
    }

    saveBtn.addEventListener('click', function () { save(collectOverride()); });

    function save(override) {
      saveBtn.disabled = true;
      statusEl.textContent = 'Speichere …';
      postJson('/api/v2/settings/definitions', { config: override }).then(function (res) {
        saveBtn.disabled = false;
        if (res.ok && res.json && res.json.ok) {
          statusEl.textContent = 'Gespeichert ✓';
          renderRoute(ROUTE_BY_PATH['/einstellungen']);
        } else {
          var msg = res.json && res.json.error ? res.json.error.message : ('Fehler ' + res.status);
          statusEl.textContent = 'Fehlgeschlagen: ' + msg;
        }
      }).catch(function () {
        saveBtn.disabled = false;
        statusEl.textContent = 'Netzwerkfehler beim Speichern.';
      });
    }
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

    // Auto-Refresh der Live-Kachel stoppen (greift nur auf der GuV-Seite).
    stopLiveRefresh();

    // Etwaige offene Slot-Editor-Overlays (auf body portiert) aufräumen.
    var staleDialog = document.getElementById('v3-slots-dialog-host');
    if (staleDialog) { staleDialog.remove(); }

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
      } else if (route.path === '/lager' && result.lager) {
        _lagerBatches = (result.lager && result.lager.batches) || [];
        viewEl.innerHTML = pageHead(route) + renderLagerPage(result.lager);
        bindLagerFilters();
        bindLagerWriteOff();
      } else if (route.path === '/guv') {
        viewEl.innerHTML = pageHead(route) + renderGuvPage(result.guv);
        bindGuvControls();
      } else if (route.path === '/slots' && result.slots) {
        viewEl.innerHTML = pageHead(route) + renderSlotsPage(result.slots);
        bindSlotEditor(result.slots);
        slotsApplyFocus();
      } else if (route.path === '/automaten' && result.automaten) {
        viewEl.innerHTML = pageHead(route) + renderAutomatenPage(result.automaten);
        bindAutomatenControls();
      } else if (route.path === '/onboarding' && result.onboarding) {
        viewEl.innerHTML = pageHead(route) + renderOnboardingPage(result.onboarding);
        bindOnboardingControls();
      } else if (route.path === '/' && result.cockpit) {
        viewEl.innerHTML = pageHead(route) + renderCockpitPage(result.cockpit);
      } else if (route.path === '/monitoring' && result.monitoring) {
        viewEl.innerHTML = pageHead(route) + renderMonitoringPage(result.monitoring);
        bindMonitoringControls();
      } else if (route.path === '/einstellungen' && result.settings) {
        viewEl.innerHTML = pageHead(route) + renderSettingsPage(result.settings, result.canEdit);
        bindSettingsControls();
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
    // #29: nur Reiter zeigen, für die der Viewer die nötige Fähigkeit hat.
    var html = ROUTES.filter(function (r) { return viewerCan(r.cap); }).map(navItemHtml).join('');
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

    document.addEventListener('click', onNavClick);
    window.addEventListener('popstate', dispatch);
    window.addEventListener('hashchange', dispatch);

    // #29: Erst die Fähigkeiten laden, dann die Nav nach Fähigkeit bauen. Bei
    // Fehler bleiben die Caps null (fail-open) — die Sicherheit liegt am Server.
    buildNav(); // sofort (fail-open), damit die Shell nie leer wirkt
    fetchJson('/api/dashboard').catch(function () { return {}; }).then(function (res) {
      var v = (res && res.viewer) || {};
      if (v.capabilities) { setViewerCaps(v.capabilities); buildNav(); setActiveNav(activePath()); }
    });

    dispatch();
  }

  // Aktiver Pfad relativ zur BASE (für setActiveNav nach Nav-Neuaufbau).
  function activePath() {
    var p = window.location.pathname;
    if (BASE && p.indexOf(BASE) === 0) { p = p.slice(BASE.length) || '/'; }
    return ROUTE_BY_PATH[p] ? p : '/';
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
