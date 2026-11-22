//! Neutral monochrome SVG icon library for BookReader.

function svg(body: string, size = 18): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

export const Icons = {
  brandLogo: (size = 20) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M8.5 5.2a5 5 0 0 1 7 0"/>
      <path d="M6.2 3a8.2 8.2 0 0 1 11.6 0"/>
      <path d="M12 11.5v8.5"/>
      <path d="M12 11.5c-2.5-1.3-5.8-1.3-8-.3v8.6c2.2-1 5.5-1 8 .2"/>
      <path d="M12 11.5c2.5-1.3 5.8-1.3 8-.3v8.6c-2.2-1-5.5-1-8 .2"/>
    </svg>`,

  sidebarToggle: () =>
    svg(`<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="9" y1="4" x2="9" y2="20"/>`),

  library: () =>
    svg(`<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/>`),

  pronunciation: () =>
    svg(`<path d="M3 12h2l2-5 3 10 3-8 2 5 2-2h4"/>`),

  ignoreWords: () =>
    svg(`<circle cx="12" cy="12" r="9"/><line x1="5.7" y1="5.7" x2="18.3" y2="18.3"/>`),

  chapters: () =>
    svg(`<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>`),

  bookmark: (filled = false) =>
    `<svg width="16" height="16" viewBox="0 0 24 24" fill="${filled ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z"/></svg>`,

  exportAudio: () =>
    svg(`<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/>`),

  settings: () =>
    svg(`<line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="17" x2="20" y2="17"/><circle cx="9" cy="7" r="2.2" fill="var(--bg-surface)"/><circle cx="15" cy="17" r="2.2" fill="var(--bg-surface)"/>`),

  voice: () =>
    svg(`<circle cx="12" cy="8.5" r="3.5"/><path d="M5.5 20a6.5 6.5 0 0 1 13 0"/><path d="M18.5 6.5a3.5 3.5 0 0 1 0 4"/>`, 20),

  prevSentence: () =>
    svg(`<path d="M11 19 4 12l7-7"/><path d="M20 19l-7-7 7-7"/>`, 17),

  nextSentence: () =>
    svg(`<path d="m13 5 7 7-7 7"/><path d="m4 5 7 7-7 7"/>`, 17),

  play: (size = 18) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="6,4 20,12 6,20"/></svg>`,

  pause: (size = 18) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>`,

  cc: () =>
    `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="5" width="20" height="14" rx="3"/><path d="M10.2 10.2a2.3 2.3 0 1 0 0 3.6"/><path d="M16.8 10.2a2.3 2.3 0 1 0 0 3.6"/></svg>`,

  search: () =>
    svg(`<circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.2" y2="16.2"/>`),

  margins: () =>
    svg(`<rect x="4" y="3" width="16" height="18" rx="2"/><line x1="4" y1="8" x2="20" y2="8" stroke-dasharray="2 2"/><line x1="4" y1="16" x2="20" y2="16" stroke-dasharray="2 2"/>`),

  sun: () =>
    svg(`<circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="6.34" y2="6.34"/><line x1="17.66" y1="17.66" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="6.34" y2="17.66"/><line x1="17.66" y1="6.34" x2="19.07" y2="4.93"/>`),

  moon: () =>
    svg(`<path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5a8.5 8.5 0 1 0 10.7 10.7z"/>`),

  sleepTimer: () =>
    svg(`<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 1.5"/><path d="M9.5 3h5"/>`),

  volume: () =>
    svg(`<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/>`),

  close: (size = 16) =>
    svg(`<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>`, size),

  chevronLeft: () => svg(`<polyline points="15 18 9 12 15 6"/>`),
  chevronUp: () => svg(`<polyline points="18 15 12 9 6 15"/>`, 15),
  chevronDown: () => svg(`<polyline points="6 9 12 15 18 9"/>`, 15),

  uploadTray: () =>
    svg(`<path d="M12 15V4"/><path d="m7 9 5-5 5 5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>`),

  downloadTray: () =>
    svg(`<path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>`),

  trash: () =>
    svg(`<polyline points="3 6 5 6 21 6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>`),

  plus: () => svg(`<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>`),

  check: () => svg(`<polyline points="20 6 9 17 4 12"/>`, 14),

  arrowUp: () => svg(`<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>`, 14),

  zoomIn: () => svg(`<circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.2" y2="16.2"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/>`, 16),
  zoomOut: () => svg(`<circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.2" y2="16.2"/><line x1="8" y1="11" x2="14" y2="11"/>`, 16),
};
