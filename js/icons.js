// SVG icon set (Lucide-style, stroke-based, currentColor). No emoji as icons.
const P = {
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  export: '<path d="M12 3v12m0-12 4 4m-4-4-4 4M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3"/>',
  work: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M3 12h18"/>',
  vacation: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  sick: '<path d="M3 12h4l2 6 4-12 2 6h6"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  pdf: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M9 13h6M9 17h6"/>',
  csv: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
  pencil: '<path d="M4 20h4L18 10l-4-4L4 16v4Z"/><path d="m14 6 4 4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chevDown: '<path d="m6 9 6 6 6-6"/>',
  chevRight: '<path d="m9 6 6 6-6 6"/>',
  chevLeft: '<path d="m15 6-6 6 6 6"/>',
  trash: '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14M10 11v6M14 11v6"/>',
  alert: '<path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>',
  emptyCal: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M3 9h18M8 2v4M16 2v4M9 14h6"/>',
};
// chevStart = "forward" in RTL points left
P.chevStart = P.chevLeft;

export const ICONS = P;

export function svg(name, cls = '') {
  const inner = P[name] || '';
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

// Fill all [data-ic] placeholders + known static targets.
export function initIcons() {
  document.querySelectorAll('[data-ic]').forEach((el) => { el.innerHTML = svg(el.dataset.ic); });
  const set = (id, name) => { const el = document.getElementById(id); if (el) el.innerHTML = svg(name); };
  set('settingsBtn', 'settings');
  set('exportBtn', 'export');
  set('addBtn', 'plus');
  set('prevMonth', 'chevRight'); // RTL: previous (older) points right
  set('nextMonth', 'chevLeft');
  set('weeklyChev', 'chevDown');
  set('dpPrev', 'chevRight');
  set('dpNext', 'chevLeft');
  set('emptyIcon', 'emptyCal');
}
