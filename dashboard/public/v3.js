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
    if (route.path === '/lager') {
      return fetchJson('/api/v2/inventory-mhd').then(function (res) {
        var rows = (res && res.data && res.data.mhdRisks) || [];
        if (rows.length === 0) { return { status: 'empty' }; }
        /* Client-side: build lager data (same logic as lib/lager.js, no server round-trip) */
        var cards = rows.map(function (r) {
          var s = String(r.severity || r.warning_severity || '').toLowerCase();
          var sev = (s === 'critical' || s === 'error') ? 'critical' :
                    (s === 'warning'  || s === 'warn')  ? 'warning'  : 'info';
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

  function renderLagerCard(card) {
    var sev   = card.severity || 'info';
    var mod   = sev === 'critical' ? ' v3-lager-card--crit' : sev === 'warning' ? ' v3-lager-card--warn' : ' v3-lager-card--info';
    var bMod  = sev === 'critical' ? 'v3-badge--crit' : sev === 'warning' ? 'v3-badge--warn' : 'v3-badge--info';
    var bTxt  = sev === 'critical' ? 'Kritisch' : sev === 'warning' ? 'Warnung' : 'OK';
    var slow  = card.slow_mover_class ? '<span class="v3-badge v3-badge--slow-mover">Slow-Mover</span>' : '';
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
    return '<div class="v3-lager-bar" role="search" aria-label="Bestand filtern">' +
      '<div class="v3-lager-bar__group">' +
        '<span class="v3-lager-bar__label">Dringlichkeit</span>' +
        '<button class="v3-chip v3-chip--active" data-lager-sev="" aria-pressed="true">Alle</button>' +
        '<button class="v3-chip v3-chip--crit" data-lager-sev="critical" aria-pressed="false">Kritisch</button>' +
        '<button class="v3-chip v3-chip--warn" data-lager-sev="warning" aria-pressed="false">Warnung</button>' +
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
    var machSel = viewEl.querySelector('[data-lager-machine]');
    var prodSel = viewEl.querySelector('[data-lager-product]');
    if (!grid) { return; }

    var filters = { severity: null, machine_id: null, product_id: null };

    function applyFilter() {
      var filtered = _lagerAllCards.filter(function (c) {
        if (filters.severity   && c.severity   !== filters.severity)              return false;
        if (filters.machine_id && c.machine_id !== filters.machine_id)             return false;
        if (filters.product_id && c.product_id !== Number(filters.product_id))     return false;
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
      } else if (route.path === '/lager' && result.lager) {
        viewEl.innerHTML = pageHead(route) + renderLagerPage(result.lager);
        bindLagerFilters();
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
