(()=>{
  const svg=(body,cls='nl-ico')=>`<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const paths={
    home:'<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10.5V20h13v-9.5"/><path d="M9.5 20v-5h5v5"/>',
    tasks:'<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
    calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 10h18"/><path d="M8 14h3v3H8z"/>',
    alert:'<path d="M12 3 2.8 19h18.4L12 3Z"/><path d="M12 9v4M12 17h.01"/>',
    team:'<circle cx="9" cy="8" r="3"/><path d="M3 20c.5-4 2.8-6 6-6s5.5 2 6 6"/><circle cx="17" cy="9" r="2.3"/><path d="M15.5 15.5c3.2.2 5 1.7 5.5 4.5"/>',
    clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    editor:'<path d="M4 5h16v14H4z"/><path d="M8 9h8M8 13h5"/><path d="m15.5 16.5 1.5 1.5 3-3"/>',
    plus:'<path d="M12 5v14M5 12h14"/>',
    shield:'<path d="M12 3 5 6v5c0 4.6 2.7 8 7 10 4.3-2 7-5.4 7-10V6l-7-3Z"/><path d="m9.5 12 1.8 1.8 3.5-4"/>',
    link:'<path d="M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.2 1.2"/><path d="M14 11a5 5 0 0 0-7.1 0l-2 2A5 5 0 0 0 12 20.1l1.2-1.2"/>',
    settings:'<circle cx="12" cy="12" r="3"/><path d="M19 13.5v-3l-2-.7a6 6 0 0 0-.8-1.8l.9-1.9-2.2-2.2-1.9.9a6 6 0 0 0-1.8-.8L10.5 2h-3l-.7 2a6 6 0 0 0-1.8.8l-1.9-.9L.9 6.1 1.8 8a6 6 0 0 0-.8 1.8L-1 10.5v3l2 .7a6 6 0 0 0 .8 1.8l-.9 1.9 2.2 2.2 1.9-.9a6 6 0 0 0 1.8.8l.7 2h3l.7-2a6 6 0 0 0 1.8-.8l1.9.9 2.2-2.2-.9-1.9a6 6 0 0 0 .8-1.8l2-.7Z" transform="translate(2.5) scale(.85)"/>',
    camera:'<path d="M4 7h4l1.5-2h5L16 7h4v12H4z"/><circle cx="12" cy="13" r="4"/>',
    drone:'<path d="M8 12h8M12 8v8"/><circle cx="5" cy="7" r="3"/><circle cx="19" cy="7" r="3"/><circle cx="5" cy="17" r="3"/><circle cx="19" cy="17" r="3"/>',
    video:'<rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3"/>',
    floorplan:'<path d="M4 4h7v6H8v10H4zM11 4h9v16H8M14 9h6"/>',
    twilight:'<path d="M4 18h16M6 15a6 6 0 0 1 12 0"/><path d="M12 3v3M4.2 8.2l2.1 2.1M19.8 8.2l-2.1 2.1"/>',
    social:'<path d="M7 6h10l2 3v9H5V9z"/><path d="m10 10 5 3-5 3z"/>',
    mail:'<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/>',
    files:'<path d="M4 4h6l2 2h8v14H4z"/><path d="M8 11h8M8 15h6"/>',
    folder:'<path d="M3 6h7l2 2h9v11H3z"/><path d="M3 9h18"/>',
    invoice:'<path d="M6 3h12v18l-2-1.2L14 21l-2-1.2L10 21l-2-1.2L6 21z"/><path d="M9 8h6M9 12h6M9 16h4"/>',
    database:'<ellipse cx="12" cy="5" rx="7" ry="3"/><path d="M5 5v6c0 1.7 3.1 3 7 3s7-1.3 7-3V5M5 11v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>',
    message:'<path d="M4 5h16v11H9l-5 4z"/><path d="M8 9h8M8 12h5"/>',
    check:'<circle cx="12" cy="12" r="9"/><path d="m8 12 2.5 2.5L16 9"/>',
    route:'<circle cx="6" cy="18" r="2"/><circle cx="18" cy="6" r="2"/><path d="M8 18h3a4 4 0 0 0 4-4v-4M14 10l2-2 2 2"/>',
    logout:'<path d="M10 4H5v16h5M14 8l4 4-4 4M18 12H9"/>',
    user:'<circle cx="12" cy="8" r="3"/><path d="M5 20c.7-4.2 3.2-6 7-6s6.3 1.8 7 6"/>',
    search:'<circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/>',
    lock:'<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    close:'<path d="M6 6l12 12M18 6 6 18"/>',
    spark:'<path d="m12 3 1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3Z"/><path d="m18 15 .8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8L18 15Z"/>'
  };
  const aliases={today:'home',tasks:'tasks',booking:'calendar',attention:'alert',team:'team',availability:'clock',editor:'editor',services:'plus',roles:'shield',integrations:'link',settings:'settings'};
  window.NLIcon=(name,cls='nl-ico')=>svg(paths[name]||paths[aliases[name]]||paths.spark,cls);
})();
