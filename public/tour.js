(function() {
  const VERSION = 'v1';
  const PATH_KEY = location.pathname === '/' ? 'dashboard' : location.pathname.replace(/^\/|\.html$/g, '') || 'dashboard';

  const TOURS = {
    dashboard: [
      {
        selector: '.pulseBar',
        title: 'Facility pulse',
        body: 'Start here for a quick count of active locations, assets, and scans recorded today.'
      },
      {
        selector: '#facilityGrid',
        title: 'Location cards',
        body: 'Each card shows where assets were last seen. Click an asset row to view history or transfer it.'
      },
      {
        selector: '#activityFeed',
        title: 'Recent activity',
        body: 'This feed shows the newest movement events so handovers can be checked quickly.'
      },
      {
        selector: '#refreshBtn',
        title: 'Refresh',
        body: 'Use refresh when you want the latest state right away. The dashboard also refreshes on its own.'
      }
    ],
    scan: [
      {
        selector: '#tag',
        title: 'Asset tag',
        body: 'Type or scan the asset tag. Matching assets appear as suggestions while you enter the code.'
      },
      {
        selector: '#location',
        title: 'Location',
        body: 'Choose where the asset is now. This becomes the asset location shown across the dashboard.'
      },
      {
        selector: '#action',
        title: 'Movement type',
        body: 'Pick whether this is a transfer, check in, or check out before recording the movement.'
      },
      {
        selector: '#submit',
        title: 'Record scan',
        body: 'Save the movement here. If it was a mistake, an undo bar appears briefly after a successful scan.'
      },
      {
        selector: '#recentScans',
        title: 'Session list',
        body: 'Recent scans from this session stay here so the operator can double-check their latest work.'
      }
    ],
    admin: [
      {
        selector: '.adminTabs',
        title: 'Admin sections',
        body: 'Use these tabs to manage users, assets, audit records, labels, and shift reports.'
      },
      {
        selector: '#tab-users .formCard',
        title: 'Create users',
        body: 'Add a user ID, name, access level, and numeric PIN. New users can sign in from the login screen.'
      },
      {
        selector: '[data-tab="assets"]',
        title: 'Assets',
        body: 'Open Assets to register equipment or import a CSV when you need to add many records.'
      },
      {
        selector: '#exportBtn',
        title: 'Audit export',
        body: 'Download a CSV audit trail for compliance checks or external reporting.'
      },
      {
        selector: '[data-tab="reports"]',
        title: 'Shift reports',
        body: 'Reports summarize scan volume by time period, operator, and location.'
      }
    ]
  };

  let userId = 'local';
  let steps = [];
  let index = 0;
  let active = false;
  let overlay;
  let spotlight;
  let card;
  let resizeHandler;

  function storageKey() {
    return `gadaTourDone:${userId}:${PATH_KEY}:${VERSION}`;
  }

  function pageTour() {
    return TOURS[PATH_KEY] || [];
  }

  function visibleTarget(selector) {
    const el = document.querySelector(selector);
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return el;
  }

  function ensureElements() {
    if (overlay) return;

    overlay = document.createElement('div');
    overlay.className = 'tourOverlay';
    overlay.addEventListener('click', endTour);

    spotlight = document.createElement('div');
    spotlight.className = 'tourSpotlight';

    card = document.createElement('div');
    card.className = 'tourCard';
    card.addEventListener('click', e => e.stopPropagation());

    document.body.append(overlay, spotlight, card);
  }

  function filteredSteps() {
    return pageTour().filter(step => visibleTarget(step.selector));
  }

  function positionStep() {
    const step = steps[index];
    if (!step) return endTour();

    const target = visibleTarget(step.selector);
    if (!target) return nextStep();

    target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });

    window.setTimeout(() => {
      const rect = target.getBoundingClientRect();
      const pad = 8;
      const top = Math.max(8, rect.top - pad);
      const left = Math.max(8, rect.left - pad);
      const width = Math.min(window.innerWidth - left - 8, rect.width + pad * 2);
      const height = Math.min(window.innerHeight - top - 8, rect.height + pad * 2);

      spotlight.style.top = `${top}px`;
      spotlight.style.left = `${left}px`;
      spotlight.style.width = `${width}px`;
      spotlight.style.height = `${height}px`;

      const cardWidth = Math.min(340, window.innerWidth - 24);
      const below = top + height + 12;
      const above = top - 12;
      const placeBelow = below + 220 < window.innerHeight || above < 230;
      const cardTop = placeBelow ? below : Math.max(12, above - 220);
      const preferredLeft = left + Math.min(24, Math.max(0, width - cardWidth));
      const cardLeft = Math.max(12, Math.min(preferredLeft, window.innerWidth - cardWidth - 12));

      card.style.width = `${cardWidth}px`;
      card.style.top = `${cardTop}px`;
      card.style.left = `${cardLeft}px`;
      renderCard(step);
    }, 180);
  }

  function renderCard(step) {
    const count = steps.length;
    card.innerHTML = `
      <div class="tourKicker">Step ${index + 1} of ${count}</div>
      <h2>${escapeHtml(step.title)}</h2>
      <p>${escapeHtml(step.body)}</p>
      <div class="tourProgress" aria-hidden="true">
        ${steps.map((_, i) => `<span class="${i === index ? 'active' : ''}"></span>`).join('')}
      </div>
      <div class="tourActions">
        <button class="tourBtn" type="button" data-tour="skip">Skip</button>
        <div>
          <button class="tourBtn" type="button" data-tour="back" ${index === 0 ? 'disabled' : ''}>Back</button>
          <button class="tourBtn tourBtnPrimary" type="button" data-tour="next">${index === count - 1 ? 'Done' : 'Next'}</button>
        </div>
      </div>`;

    card.querySelector('[data-tour="skip"]').onclick = endTour;
    card.querySelector('[data-tour="back"]').onclick = prevStep;
    card.querySelector('[data-tour="next"]').onclick = nextStep;
  }

  function startTour(manual) {
    steps = filteredSteps();
    if (!steps.length) return;
    active = true;
    index = 0;
    ensureElements();
    overlay.classList.add('show');
    spotlight.classList.add('show');
    card.classList.add('show');
    document.body.classList.add('tourActive');
    resizeHandler = () => active && positionStep();
    window.addEventListener('resize', resizeHandler);
    document.addEventListener('keydown', onKeyDown);
    if (manual) localStorage.removeItem(storageKey());
    positionStep();
  }

  function endTour() {
    if (!active) return;
    active = false;
    localStorage.setItem(storageKey(), '1');
    overlay?.classList.remove('show');
    spotlight?.classList.remove('show');
    card?.classList.remove('show');
    document.body.classList.remove('tourActive');
    window.removeEventListener('resize', resizeHandler);
    document.removeEventListener('keydown', onKeyDown);
  }

  function nextStep() {
    if (index >= steps.length - 1) return endTour();
    index += 1;
    positionStep();
  }

  function prevStep() {
    if (index <= 0) return;
    index -= 1;
    positionStep();
  }

  function onKeyDown(e) {
    if (!active) return;
    if (e.key === 'Escape') endTour();
    if (e.key === 'ArrowRight') nextStep();
    if (e.key === 'ArrowLeft') prevStep();
  }

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, c => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[c]);
  }

  function addTourButton() {
    if (!pageTour().length || document.getElementById('tourBtn')) return;
    const navRight = document.querySelector('.navRight');
    if (!navRight) return;
    const btn = document.createElement('button');
    btn.className = 'tourLaunch';
    btn.id = 'tourBtn';
    btn.type = 'button';
    btn.textContent = 'Tour';
    btn.title = 'Start tour';
    btn.addEventListener('click', () => startTour(true));
    navRight.insertBefore(btn, navRight.firstChild);
  }

  async function init() {
    addTourButton();
    if (!pageTour().length) return;

    try {
      const me = await fetch('/api/me', { credentials: 'include' }).then(r => r.json());
      if (!me.user) return;
      userId = me.user.id || me.user.name || 'local';
    } catch {
      return;
    }

    window.setTimeout(() => {
      if (!localStorage.getItem(storageKey())) startTour(false);
    }, 900);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
