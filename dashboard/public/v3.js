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
      if (!loc) { unassigned++; }
      return {
        machine_id: m.machine_id,
        label: (m.label && String(m.label).trim()) || String(m.machine_id || ''),
        area: m.area || null, type: m.type || null, position: m.position || null, nickname: m.nickname || null,
        location_name: loc ? loc.name : null,
        location_status: loc ? loc.status : null,
      };
    });
    var builtLocations = locations.map(function (l) {
      return {
        location_id: l.location_id != null ? l.location_id : null,
        name: l.name, status: l.status || null,
        machineCount: (l.machine_ids || []).length,
      };
    });
    return {
      machines: builtMachines, locations: builtLocations,
      total: builtMachines.length, locationsTotal: builtLocations.length, unassignedCount: unassigned,
    };
  }

  function renderAutoCard(m) {
    var attrs = [];
    if (m.area) { attrs.push(esc(m.area)); }
    if (m.type) { attrs.push(esc(m.type)); }
    if (m.position) { attrs.push(esc(m.position)); }
    if (m.nickname) { attrs.push(esc(m.nickname)); }
    var locChip = m.location_name
      ? '<span class="v3-auto-loc-chip v3-auto-loc-chip--' + (m.location_status || 'none') + '">' + esc(m.location_name) + '</span>'
      : '<span class="v3-auto-loc-chip v3-auto-loc-chip--none">Ohne Standort</span>';
    return '<article class="v3-auto-card">' +
      '<div class="v3-auto-card__top">' +
        '<span class="v3-auto-card__id">' + esc(m.machine_id) + '</span>' + locChip +
      '</div>' +
      '<p class="v3-auto-card__label">' + esc(m.label) + '</p>' +
      (attrs.length ? '<div class="v3-auto-card__attrs">' + attrs.map(function (a) { return '<span class="v3-auto-attr">' + a + '</span>'; }).join('') + '</div>' : '') +
      '<button type="button" class="v3-btn v3-auto-card__jump" data-auto-jump="' + esc(m.machine_id) + '">Zur Slot-Ansicht <span aria-hidden="true">&#8594;</span></button>' +
    '</article>';
  }

  function renderAutoLocationCard(l) {
    return '<article class="v3-auto-loc-card">' +
      '<div class="v3-auto-loc-card__top">' +
        '<span class="v3-auto-loc-card__name">' + esc(l.name) + '</span>' +
        '<span class="v3-auto-loc-chip v3-auto-loc-chip--' + (l.status || 'none') + '">' + esc(AUTO_STATUS[l.status] || l.status || '—') + '</span>' +
      '</div>' +
      '<p class="v3-auto-loc-card__meta">' + l.machineCount + ' Automat' + (l.machineCount === 1 ? '' : 'en') + '</p>' +
    '</article>';
  }

  function renderAutomatenPage(view) {
    var summary =
      '<div class="v3-auto-summary">' +
        '<div class="v3-auto-stat"><span class="v3-auto-stat__num">' + view.total + '</span><span class="v3-auto-stat__label">Automaten</span></div>' +
        '<div class="v3-auto-stat"><span class="v3-auto-stat__num">' + view.locationsTotal + '</span><span class="v3-auto-stat__label">Standorte</span></div>' +
        '<div class="v3-auto-stat"><span class="v3-auto-stat__num">' + view.unassignedCount + '</span><span class="v3-auto-stat__label">Ohne Standort</span></div>' +
      '</div>';
    var machines = view.machines.length === 0
      ? '<div class="v3-mon-cases-empty">Noch keine Automatenprofile angelegt.</div>'
      : '<div class="v3-auto-grid">' + view.machines.map(renderAutoCard).join('') + '</div>';
    var locations = view.locations.length === 0 ? '' :
      '<section class="v3-auto-section">' +
        '<div class="v3-mon-section__head"><h2 class="v3-mon-section__title">Standorte</h2>' +
          '<span class="v3-mon-section__count">' + view.locationsTotal + '</span></div>' +
        '<div class="v3-auto-loc-grid">' + view.locations.map(renderAutoLocationCard).join('') + '</div>' +
      '</section>';
    return summary + machines + locations;
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
    if (route.path === '/lager') {
      /* Sortiment-Slots zusätzlich laden: liefert die quartilbasierte Drehzahl-
         Klasse je Slot (machine_id+mdb_code). Single Source of Truth ist der
         Sortiment-Endpunkt; hier wird sie nur per Join an die MHD-Karten geheftet.
         Fällt der Join aus, bleiben die Karten ohne Drehzahl-Badge (graceful). */
      return Promise.all([
        fetchJson('/api/v2/inventory-mhd'),
        fetchJson('/api/v2/assortment-slots').catch(function () { return {}; }),
      ]).then(function (results) {
        var res  = results[0];
        var rows = (res && res.data && res.data.mhdRisks) || [];
        if (rows.length === 0) { return { status: 'empty' }; }
        var slots = (results[1] && results[1].data && results[1].data.slots) || [];
        var classByKey = {};
        slots.forEach(function (s) {
          if (s && s.turnover_class) {
            classByKey[String(s.machine_id) + '|' + String(s.mdb_code)] = s.turnover_class;
          }
        });
        /* Client-side: build lager data (same logic as lib/lager.js, no server round-trip) */
        var cards = rows.map(function (r) {
          var s = String(r.severity || r.warning_severity || '').toLowerCase();
          var sev = (s === 'critical' || s === 'error') ? 'critical' :
                    (s === 'warning'  || s === 'warn')  ? 'warning'  : 'info';
          var tkey = String(r.machine_id || '') + '|' + String(r.mdb_code || '');
          var tclass = classByKey[tkey] || (r.turnover_class != null ? String(r.turnover_class) : null);
          return {
            batch_id:        Number(r.batch_id)      || 0,
            product_id:      Number(r.product_id)    || 0,
            product_name:    String(r.product_name   || r.product_id || ''),
            mhd_date:        String(r.mhd_date       || ''),
            remaining_qty:   Number(r.remaining_qty) || 0,
            severity:        sev,
            machine_id:      String(r.machine_id     || ''),
            machine_name:    String(r.machine_name   || ''),
            location_name:   String(r.location_name  || ''),
            mdb_code:        String(r.mdb_code       || ''),
            slow_mover_class: r.slow_mover_class != null ? String(r.slow_mover_class) : null,
            turnover_class:  tclass,
          };
        });
        _lagerAllCards = cards;
        var crit = cards.filter(function (c) { return c.severity === 'critical'; }).length;
        var warn = cards.filter(function (c) { return c.severity === 'warning';  }).length;
        return { status: 'ok', lager: { cards: cards, summary: { total: cards.length, critical: crit, warning: warn } } };
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
        fetchJson('/api/v2/refill/search?q='),
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
      ]).then(function (results) {
        var machines  = (results[0] && results[0].data) || [];
        var locations = (results[1] && results[1].data) || [];
        if (machines.length === 0 && locations.length === 0) { return { status: 'empty' }; }
        return { status: 'ok', automaten: automatenClientView(machines, locations) };
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
        return { status: 'ok', settings: defs };
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

  function renderLagerPage(data) {
    var allCards = (data && data.cards) || [];
    var summary  = (data && data.summary) || { total: 0, critical: 0, warning: 0 };

    var cardsHtml = allCards.length === 0
      ? '<div class="v3-lager-empty">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4"/><path d="M12 11v10"/></svg>' +
          '<p style="margin:0;font-weight:600">Keine Einträge</p>' +
          '<p style="margin:0;font-size:13px">Alle Bestände sind in Ordnung.</p>' +
        '</div>'
      : allCards.map(renderLagerCard).join('');

    return renderLagerKpis(summary) +
      renderLagerBar(allCards) +
      '<div class="v3-lager-layout">' +
        '<div class="v3-lager-grid v3-lager-grid--fresh" data-lager-grid>' + cardsHtml + '</div>' +
        '<aside class="v3-lager-chart-panel" aria-label="Restmengen-Übersicht">' +
          '<p class="v3-lager-chart-panel__title">Restmengen im Überblick</p>' +
          '<div data-lager-chart>' + renderBarChartSvg(allCards) + '</div>' +
        '</aside>' +
      '</div>';
  }

  /* Bind interactive filter events after lager page renders */
  var _lagerAllCards = [];
  function bindLagerFilters() {
    var grid    = viewEl.querySelector('[data-lager-grid]');
    var chart   = viewEl.querySelector('[data-lager-chart]');
    var sevBtns = viewEl.querySelectorAll('[data-lager-sev]');
    var turnBtns = viewEl.querySelectorAll('[data-lager-turnover]');
    var machSel = viewEl.querySelector('[data-lager-machine]');
    var prodSel = viewEl.querySelector('[data-lager-product]');
    if (!grid) { return; }

    var filters = { severity: null, machine_id: null, product_id: null, turnover_class: null };

    function applyFilter() {
      var filtered = _lagerAllCards.filter(function (c) {
        if (filters.severity   && c.severity   !== filters.severity)              return false;
        if (filters.machine_id && c.machine_id !== filters.machine_id)             return false;
        if (filters.product_id && c.product_id !== Number(filters.product_id))     return false;
        if (filters.turnover_class && c.turnover_class !== filters.turnover_class) return false;
        return true;
      });
      var critF = filtered.filter(function (c) { return c.severity === 'critical'; }).length;
      var warnF = filtered.filter(function (c) { return c.severity === 'warning'; }).length;
      /* Update summary KPIs */
      var kpiEl = viewEl.querySelector('.v3-cockpit-kpis');
      if (kpiEl) {
        var vals = kpiEl.querySelectorAll('.v3-cockpit-kpi__value');
        if (vals[0]) { vals[0].textContent = String(filtered.length); }
        if (vals[1]) { vals[1].textContent = String(critF); }
        if (vals[2]) { vals[2].textContent = String(warnF); }
      }
      /* Re-render cards */
      grid.classList.remove('v3-lager-grid--fresh');
      void grid.offsetWidth; /* reflow to retrigger animation */
      grid.classList.add('v3-lager-grid--fresh');
      grid.innerHTML = filtered.length === 0
        ? '<div class="v3-lager-empty">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4"/><path d="M12 11v10"/></svg>' +
            '<p style="margin:0;font-weight:600">Kein Treffer</p>' +
            '<p style="margin:0;font-size:13px">Filter anpassen, um Einträge anzuzeigen.</p>' +
          '</div>'
        : filtered.map(renderLagerCard).join('');
      /* Re-render chart with same filtered set */
      if (chart) { chart.innerHTML = renderBarChartSvg(filtered); }
      /* Navigation links are handled by global click delegation — no rebind needed */
    }

    sevBtns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var sev = btn.getAttribute('data-lager-sev') || null;
        filters.severity = sev || null;
        sevBtns.forEach(function (b) {
          var active = b === btn;
          b.setAttribute('aria-pressed', active ? 'true' : 'false');
          if (active) { b.classList.add('v3-chip--active'); }
          else { b.classList.remove('v3-chip--active'); }
        });
        applyFilter();
      });
    });
    turnBtns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        filters.turnover_class = btn.getAttribute('data-lager-turnover') || null;
        turnBtns.forEach(function (b) {
          var active = b === btn;
          b.setAttribute('aria-pressed', active ? 'true' : 'false');
          if (active) { b.classList.add('v3-chip--active'); }
          else { b.classList.remove('v3-chip--active'); }
        });
        applyFilter();
      });
    });
    if (machSel) {
      machSel.addEventListener('change', function () {
        filters.machine_id = machSel.value || null;
        applyFilter();
      });
    }
    if (prodSel) {
      prodSel.addEventListener('change', function () {
        filters.product_id = prodSel.value || null;
        applyFilter();
      });
    }
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

  /* Period-State: was die /guv-Seite gerade abfragt */
  var _guvQuery = (function () {
    var now = new Date();
    return {
      mode: 'month', month: currentYM(), year: now.getFullYear(),
      quarter: Math.floor(now.getMonth() / 3) + 1, from: currentYM(), to: currentYM(),
      sort: 'revenue_gross', order: 'desc', limit: 10, filter: '',
    };
  })();
  var _guvData = null;

  function guvBuildUrl(q) {
    var p = ['mode=' + encodeURIComponent(q.mode)];
    if (q.mode === 'quarter')      { p.push('year=' + encodeURIComponent(q.year), 'quarter=' + encodeURIComponent(q.quarter)); }
    else if (q.mode === 'year')    { p.push('year=' + encodeURIComponent(q.year)); }
    else if (q.mode === 'custom')  { p.push('from=' + encodeURIComponent(q.from), 'to=' + encodeURIComponent(q.to)); }
    else                           { p.push('from=' + encodeURIComponent(q.month), 'to=' + encodeURIComponent(q.month)); }
    return '/api/v2/economics?' + p.join('&');
  }
  function loadGuvData(q) {
    return fetchJson(guvBuildUrl(q)).then(function (res) { return (res && res.data) ? res.data : null; });
  }

  /* Spiegelung von lib/guv-chart.js::aggregateTopProducts (kein Round-Trip) */
  function guvTopProducts(rows) {
    var byId = {};
    (rows || []).forEach(function (r) {
      var id = Number(r.product_id) || 0;
      var acc = byId[id] || { product_id: id, product_name: null, revenue_net: 0, db_net: 0, revenue_gross: 0, gross_profit: 0, qty: 0 };
      if (r.product_name != null && r.product_name !== '') { acc.product_name = String(r.product_name); }
      acc.revenue_net   += Number(r.revenue_net)   || 0;
      acc.db_net        += Number(r.db_net)        || 0;
      acc.revenue_gross += Number(r.revenue_gross) || 0;
      acc.gross_profit  += Number(r.gross_profit)  || 0;
      acc.qty           += Number(r.qty)           || 0;
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
        margin_gross_pct: rg > 0 ? Math.round((gp / rg) * 1000) / 10 : 0,
      };
    });
  }

  /* Spiegelung von lib/guv-chart.js::buildLineSeries */
  function guvLineSeries(series, valueKey, width, height, pad) {
    var data = (series || []).map(function (d) { return { month: d.month, value: Number(d[valueKey]) || 0 }; });
    if (data.length === 0) { return { points: [], min: 0, max: 0, path: '', area: '' }; }
    var vals = data.map(function (d) { return d.value; });
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals), span = max - min;
    var innerW = width - pad * 2, innerH = height - pad * 2, bottom = height - pad;
    var r2 = function (n) { return Math.round(n * 100) / 100; };
    var points = data.map(function (d, i) {
      var x = data.length === 1 ? pad : r2(pad + (i / (data.length - 1)) * innerW);
      var y = span === 0 ? r2(height / 2) : r2(pad + (1 - (d.value - min) / span) * innerH);
      return { x: x, y: y, value: d.value, month: d.month };
    });
    var path = 'M' + points.map(function (p) { return p.x + ' ' + p.y; }).join(' L');
    var area = path + ' L' + points[points.length - 1].x + ' ' + bottom + ' L' + points[0].x + ' ' + bottom + ' Z';
    return { points: points, min: min, max: max, path: path, area: area };
  }

  /* Ein Zeitreihen-Flächen-/Linienchart (reines SVG) */
  function renderLineChartSvg(series, valueKey, opts) {
    opts = opts || {};
    var W = 340, H = 138, PAD = 20;
    var chart = guvLineSeries(series, valueKey, W, H, PAD);
    if (chart.points.length === 0) { return '<p class="v3-guv-chart__empty">Keine Daten im Zeitraum</p>'; }
    var fmt = opts.fmt || fmtEuro;
    var color = opts.color || 'var(--brand)';
    var gradId = 'guvgrad-' + (opts.id || valueKey);
    /* Hoverbare Punkte: große transparente Trefferfläche + Punkt + Wert-Tooltip */
    var dots = chart.points.map(function (p) {
      var txt = monthLabel(p.month) + ' · ' + fmt(p.value);
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
    var axis = chart.points.map(function (p) {
      return '<text class="v3-guv-axis" x="' + p.x + '" y="' + (H - 4) + '" text-anchor="middle">' + esc(monthLabel(p.month)) + '</text>';
    }).join('');
    return '<svg class="v3-guv-chartsvg" viewBox="0 0 ' + W + ' ' + H + '" role="img" ' +
        'aria-label="' + esc(opts.label || valueKey) + '" style="width:100%;height:auto;display:block;overflow:visible">' +
        '<defs><linearGradient id="' + gradId + '" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0%" stop-color="' + color + '" stop-opacity="0.20"/>' +
          '<stop offset="100%" stop-color="' + color + '" stop-opacity="0"/>' +
        '</linearGradient></defs>' +
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
    var qOpts = [1, 2, 3, 4].map(function (n) { return '<option value="' + n + '"' + (Number(q.quarter) === n ? ' selected' : '') + '>Q' + n + '</option>'; }).join('');
    function field(name, visible, inner) {
      return '<label class="v3-guv-field' + (visible ? '' : ' is-hidden') + '" data-field="' + name + '">' + inner + '</label>';
    }
    return '<div class="v3-guv-period v3-card" role="group" aria-label="Zeitraum wählen">' +
      '<div class="v3-guv-period__seg" role="tablist">' +
        btn('month', 'Monat') + btn('quarter', 'Quartal') + btn('year', 'Jahr') + btn('custom', 'Eigener') +
      '</div>' +
      '<div class="v3-guv-period__fields">' +
        field('month',   q.mode === 'month',   '<span>Monat</span><input type="month" data-guv-month value="' + esc(q.month) + '">') +
        field('quarter', q.mode === 'quarter', '<span>Quartal</span><select data-guv-quarter>' + qOpts + '</select>') +
        field('year',    q.mode === 'quarter' || q.mode === 'year', '<span>Jahr</span><select data-guv-year>' + yearOpts + '</select>') +
        field('from',    q.mode === 'custom',  '<span>Von</span><input type="month" data-guv-from value="' + esc(q.from) + '">') +
        field('to',      q.mode === 'custom',  '<span>Bis</span><input type="month" data-guv-to value="' + esc(q.to) + '">') +
      '</div>' +
    '</div>';
  }

  /* KPI-Strip mit den Totalen des Zeitraums (Brutto wie Legacy) */
  function guvKpiStrip(totals) {
    totals = totals || {};
    var marge = Number(totals.revenue_gross) > 0 ? (totals.gross_profit / totals.revenue_gross) * 100 : 0;
    function kpi(label, value, unit) {
      return '<div class="v3-cockpit-kpi">' +
        '<span class="v3-cockpit-kpi__label">' + label + '</span>' +
        '<span class="v3-cockpit-kpi__value">' + value + (unit ? '<span class="v3-cockpit-kpi__unit"> ' + unit + '</span>' : '') + '</span>' +
      '</div>';
    }
    return '<div class="v3-cockpit-kpis v3-guv-kpis">' +
      kpi('Umsatz (brutto)', fmtEuro(totals.revenue_gross), 'EUR') +
      kpi('GuV (brutto)', fmtEuro(totals.gross_profit), 'EUR') +
      kpi('Marge', fmtPct(marge), '') +
      kpi('Stück', fmtInt(totals.qty), '') +
    '</div>';
  }

  /* Drei Diagramme über die Zeit */
  function guvChartsPanel(series) {
    function card(label, valueKey, color, fmt, id) {
      return '<section class="v3-guv-chart v3-card" aria-label="' + label + '">' +
        '<p class="v3-guv-chart__title">' + label + '</p>' +
        renderLineChartSvg(series, valueKey, { label: label, color: color, fmt: fmt, id: id }) +
      '</section>';
    }
    return '<div class="v3-guv-charts">' +
      card('Umsatz (brutto)', 'revenue_gross', 'var(--brand)', fmtEuro, 'rev') +
      card('GuV / Deckungsbeitrag', 'gross_profit', 'var(--ok)', fmtEuro, 'gp') +
      card('Marge', 'margin_gross_pct', 'var(--warn)', fmtPct, 'mg') +
    '</div>';
  }

  /* Top-N-Tabelle: filtern, sortieren, begrenzen (clientseitig) */
  function guvComputeRows(byProduct, q) {
    var rows = guvTopProducts(byProduct);
    var f = (q.filter || '').trim().toLowerCase();
    if (f) { rows = rows.filter(function (r) { return r.product_name.toLowerCase().indexOf(f) >= 0; }); }
    var key = q.sort || 'revenue_gross', dir = q.order === 'asc' ? 1 : -1;
    rows.sort(function (a, b) { var av = a[key] || 0, bv = b[key] || 0; return (av < bv ? -1 : av > bv ? 1 : 0) * dir; });
    return rows.slice(0, Number(q.limit) || 10);
  }
  function guvRowsHtml(rows) {
    if (!rows.length) { return '<tr><td colspan="5" class="v3-guv-table__empty">Keine Treffer</td></tr>'; }
    return rows.map(function (r) {
      return '<tr>' +
        '<td class="v3-guv-table__name">' + esc(r.product_name) + '</td>' +
        '<td class="v3-guv-table__num">' + fmtEuro(r.revenue_gross) + '</td>' +
        '<td class="v3-guv-table__num">' + fmtEuro(r.gross_profit) + '</td>' +
        '<td class="v3-guv-table__num">' + fmtPct(r.margin_gross_pct) + '</td>' +
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
          '</select>' +
        '</div>' +
      '</div>' +
      '<div class="v3-guv-tablewrap" data-guv-tablewrap>' + renderGuvTableEl(byProduct, q) + '</div>' +
    '</section>';
  }

  /* Sichtbares Label des tatsächlich geladenen Zeitraums (Feedback nach Wechsel) */
  function guvRangeCaption(data) {
    var p = (data && data.period) || {};
    if (!p.from || !p.to) { return ''; }
    var label = p.from === p.to ? monthLabel(p.from) : monthLabel(p.from) + ' – ' + monthLabel(p.to);
    return '<p class="v3-guv-range">Zeitraum: <strong>' + esc(label) + '</strong></p>';
  }

  function renderGuvBody(data, q) {
    var series    = (data && data.series)    || [];
    var totals    = (data && data.totals)    || {};
    var byProduct = (data && data.byProduct) || [];
    if (series.length === 0) {
      return guvRangeCaption(data) + guvKpiStrip(totals) +
        renderState('empty', { message: 'Für den gewählten Zeitraum liegen keine Umsätze vor.' });
    }
    return guvRangeCaption(data) + guvKpiStrip(totals) + guvChartsPanel(series) + guvTable(byProduct, q);
  }

  function renderGuvPage(data) {
    _guvData = data || null;
    return '<div class="v3-guv">' +
      guvPeriodPicker(_guvQuery) +
      '<div class="v3-guv-body" data-guv-body aria-live="polite">' + renderGuvBody(_guvData, _guvQuery) + '</div>' +
    '</div>';
  }

  function bindGuvControls() {
    var root = viewEl.querySelector('.v3-guv');
    if (!root) { return; }

    function fieldVisibility() {
      var show = {
        month:   _guvQuery.mode === 'month',
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
        bindTable();
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
    function bindTable() {
      var search = root.querySelector('[data-guv-filter]');
      if (search) { search.addEventListener('input', function (e) { _guvQuery.filter = e.target.value; redrawTable(); }); }
      var limit = root.querySelector('[data-guv-limit]');
      if (limit) { limit.addEventListener('change', function (e) { _guvQuery.limit = e.target.value; redrawTable(); }); }
      bindSortButtons();
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
    onChange('[data-guv-from]',    function (e) { _guvQuery.from    = e.target.value; reload(); });
    onChange('[data-guv-to]',      function (e) { _guvQuery.to      = e.target.value; reload(); });

    bindTable();
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
      var name = String(row.product_name == null ? '' : row.product_name).trim();
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

  function renderMachineStage(machine, canEdit) {
    var floorsHtml = machine.floors.map(function (f) {
      return '' +
        '<div class="v3-slots-floor">' +
          '<span class="v3-slots-floor__label">Etage ' + esc(f.floor) + '</span>' +
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
          fetchJson('/api/v2/refill/search?q=' + encodeURIComponent(searchEl.value || '')).then(function (res) {
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
  /* Zeigt die im Backend (lib/slow-mover.js) festgelegten Definitionen/Schwellwerte.
     Quelle: GET /api/v2/settings/definitions → docs/UBIQUITOUS_LANGUAGE.md. */
  function renderSettingsPage(settings) {
    var sm = (settings && settings.slowMover) || { classes: [], ladenhueterDays: 30, minPointsForQuartiles: 4 };
    var classRows = (sm.classes || []).map(function (c) {
      return '<li class="v3-set-def">' +
        '<span class="v3-badge v3-badge--turnover v3-badge--turnover-' + esc(c.key) + '">' + esc(c.label) + '</span>' +
        '<span class="v3-set-def__text">' + esc(c.description) + '</span>' +
      '</li>';
    }).join('');

    var thresholds = '' +
      '<ul class="v3-set-list">' +
        '<li><strong>Ladenhüter-Schwelle:</strong> 0 Verkäufe seit ≥ ' + esc(sm.ladenhueterDays) + ' Tagen ' +
          '(Grenzfall genau ' + esc(sm.ladenhueterDays) + ' Tage zählt bereits).</li>' +
        '<li><strong>Verfahren:</strong> quartilbasiert pro Slot/Automat — oberstes Quartil = Renner, unterstes = Langsam-Dreher, dazwischen Normal.</li>' +
        '<li><strong>Mindest-Datenpunkte:</strong> unter ' + esc(sm.minPointsForQuartiles) + ' aktiven Slots (oder ohne Streuung) → alle „Normal".</li>' +
      '</ul>';

    return '' +
      '<section class="v3-card" aria-label="Drehzahl-Klassifikation">' +
        '<h2 class="v3-set-title">Drehzahl-Klassen (Slow-Mover)</h2>' +
        '<p class="v3-state__msg" style="margin:0 0 16px">Wie das Cockpit Produkte nach Umschlag je Slot/Automat einordnet. Diese Definitionen sind im Domänen-Glossar <code>docs/UBIQUITOUS_LANGUAGE.md</code> verbindlich festgeschrieben und liegen im Backend (<code>lib/slow-mover.js</code>).</p>' +
        '<ul class="v3-set-defs">' + classRows + '</ul>' +
        '<h3 class="v3-set-subtitle">Schwellwerte</h3>' +
        thresholds +
      '</section>';
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
        viewEl.innerHTML = pageHead(route) + renderLagerPage(result.lager);
        bindLagerFilters();
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
        viewEl.innerHTML = pageHead(route) + renderSettingsPage(result.settings);
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
