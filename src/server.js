/**
 * Small read-only web UI for browsing and playing recordings.
 *
 * Deliberately dependency-free (node:http, no Express): this runs alongside the
 * recorder in a container whose only job is capturing footage, and every added
 * dependency is more to audit and patch on a box exposed to the LAN.
 *
 * Read-only by design — there is no delete or upload route. Retention already
 * prunes old files, and a browser-reachable delete endpoint on an unauthenticated
 * LAN service is a footgun. Filenames are validated against the exact pattern the
 * recorder produces, so no request can escape the output directory.
 */

import { createReadStream, watch } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, basename } from 'node:path';
import { timingSafeEqual } from 'node:crypto';

import { log } from './logger.js';
import { ipInCidr } from './net.js';

/**
 * Exactly the names recorder.js generates: 20260810-142548_front-door_motion.mp4
 * Anything else is rejected outright, which is what keeps `..%2f` and absolute
 * paths from reaching the filesystem. basename() alone is not enough of a
 * guarantee to rely on for this.
 */
export const FILENAME_PATTERN = /^\d{8}-\d{6}_[a-z0-9-]+_(motion|ding)\.(mp4|jpg)$/;

const CONTENT_TYPES = {
  '.mp4': 'video/mp4',
  '.jpg': 'image/jpeg',
};

const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** 20260810-142548 -> { day: '2026-08-10', time: '14:25:48', sortKey } */
const parseName = (filename) => {
  const [stamp, ...rest] = filename.split('_');
  const kind = rest.at(-1)?.replace(/\.(mp4|jpg)$/, '') ?? '';
  const camera = rest.slice(0, -1).join('_');
  const day = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`;
  const time = `${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}`;
  return { stamp, day, time, camera, kind };
};

/**
 * `20260810-142548` -> a Date in local time.
 *
 * Built from parts rather than Date.parse: that string is not a format Date
 * understands, and the components are already local time (the recorder names
 * files using TZ), so a local-time constructor is the correct reading.
 */
export const eventTime = (stamp) => {
  const [date, time] = stamp.split('-');
  return new Date(
    Number(date.slice(0, 4)),
    Number(date.slice(4, 6)) - 1,
    Number(date.slice(6, 8)),
    Number(time.slice(0, 2)),
    Number(time.slice(2, 4)),
    Number(time.slice(4, 6)),
  );
};

/**
 * "12 min ago" — the whole point of the TV view, which answers "has anything
 * happened?" rather than "what is in the archive?".
 *
 * Floors each unit rather than rounding, so 119 seconds reads "1 min ago" and
 * never the impossible "60 min ago". A future timestamp means the container and
 * the viewer disagree about the clock, which is not worth rendering as a
 * negative: treat it as now.
 */
export const relativeTime = (at, now) => {
  const seconds = Math.floor((now - at) / 1000);
  if (seconds < 90) {
    return 'just now';
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  }
  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
};

const formatBytes = (bytes) => {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${bytes} B`;
};

/**
 * Lists recordings newest-first, pairing each video with its snapshot.
 *
 * `.part` files are skipped: a recording still in flight is not yet playable and
 * would only show up as a broken entry.
 */
const listRecordings = async (outputDir) => {
  let entries;
  try {
    entries = await readdir(outputDir);
  } catch (error) {
    log.warn('Could not read recordings directory', { error: error.message });
    return [];
  }

  const snapshots = new Set(entries.filter((name) => name.endsWith('.jpg')));
  const videos = entries.filter((name) => name.endsWith('.mp4') && FILENAME_PATTERN.test(name));

  const items = await Promise.all(
    videos.map(async (name) => {
      const meta = parseName(name);
      const snapshot = name.replace(/\.mp4$/, '.jpg');
      let size = 0;
      try {
        ({ size } = await stat(join(outputDir, name)));
      } catch {
        // Pruned between readdir and stat; report it as zero rather than fail
        // the whole listing.
      }
      return {
        name,
        size,
        snapshot: snapshots.has(snapshot) ? snapshot : null,
        ...meta,
      };
    }),
  );

  // Snapshots with no video: an event where recording failed. Worth surfacing
  // rather than hiding, since it is the only trace that something happened.
  const orphanSnapshots = [...snapshots]
    .filter((name) => FILENAME_PATTERN.test(name) && !videos.includes(name.replace(/\.jpg$/, '.mp4')))
    .map((name) => ({ name: null, snapshot: name, size: 0, ...parseName(name) }));

  return [...items, ...orphanSnapshots].sort((a, b) => b.stamp.localeCompare(a.stamp));
};

const PAGE_STYLE = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         background: #14161a; color: #e6e8eb; }
  header { padding: 16px 20px; border-bottom: 1px solid #2a2f36; display: flex;
           align-items: baseline; gap: 12px; flex-wrap: wrap; }
  h1 { font-size: 17px; margin: 0; font-weight: 600; }
  .muted { color: #8b939e; font-size: 13px; }
  main { padding: 20px; max-width: 1200px; margin: 0 auto; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: #8b939e;
       margin: 28px 0 12px; font-weight: 600; }
  h2:first-child { margin-top: 0; }
  .grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); }
  .card { background: #1c1f25; border: 1px solid #2a2f36; border-radius: 8px; overflow: hidden;
          display: flex; flex-direction: column; }
  .card a.thumb { display: block; aspect-ratio: 16/9; background: #000; position: relative; }
  .card img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .card .noimg { display: grid; place-items: center; height: 100%; color: #5a6270; font-size: 13px; }
  .meta { padding: 10px 12px; display: flex; flex-direction: column; gap: 3px; }
  .time { font-weight: 600; font-variant-numeric: tabular-nums; }
  .tags { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .tag { font-size: 11px; padding: 1px 7px; border-radius: 20px; border: 1px solid #333a44;
         color: #a9b2bd; text-transform: capitalize; }
  .tag.ding { border-color: #4a5a2e; color: #b6d178; }
  .tag.motion { border-color: #2e4a5a; color: #78b6d1; }
  .tag.nofile { border-color: #5a2e2e; color: #d17878; text-transform: none; }
  video { width: 100%; background: #000; display: block; }
  .empty { color: #8b939e; padding: 40px 0; text-align: center; }
  a { color: inherit; text-decoration: none; }
  .back { display: inline-block; margin-bottom: 16px; color: #78b6d1; font-size: 14px; }
  .dl { font-size: 12px; color: #78b6d1; }
  .live { font-size: 12px; color: #6fbf73; }
  /* The auto margin lives on the link, not on .live: .live is hidden whenever the
     event stream is down, and a hidden element cannot hold the layout open. */
  header .dl { margin-left: auto; font-size: 12px; }
  .card.new { animation: flash 1.4s ease-out; }
  @keyframes flash { from { box-shadow: 0 0 0 2px #6fbf73; } to { box-shadow: none; } }
`;

/**
 * Overrides for the /tv view, layered on top of PAGE_STYLE.
 *
 * Three things make a TV different from a monitor, and all three are sizing
 * problems rather than layout ones:
 *
 *   - Viewing distance. Read from across a room, not at arm's length, so
 *     everything is roughly doubled and the answer to "anything new?" is set in
 *     the largest type on the page.
 *   - Overscan. Some sets still crop a few percent of every edge, so content sits
 *     inside a safe area rather than against the viewport edge.
 *   - A d-pad instead of a pointer. There is no hover and no cursor, so focus has
 *     to be unmistakable — a thick outline plus a lift, not a 1px border change.
 */
const TV_STYLE = `
  body { font-size: 22px; }
  /* Safe area: TVs may crop the outer few percent of the picture. */
  .tv { padding: 4vh 4vw; max-width: none; margin: 0; }
  .tv-head { display: flex; align-items: baseline; gap: 20px; margin-bottom: 3vh; }
  .tv-head h1 { font-size: 30px; }
  .tv-head .muted { font-size: 22px; }
  .tv-head .live { font-size: 20px; }

  /* The headline answer, in the biggest type on the page. */
  .hero { display: grid; grid-template-columns: 1.35fr 1fr; gap: 3vw; align-items: center; }
  .hero-shot { display: block; aspect-ratio: 16/9; background: #000; border-radius: 12px;
               overflow: hidden; border: 3px solid #2a2f36; position: relative; }
  .hero-shot img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .hero-shot .noimg { display: grid; place-items: center; height: 100%; font-size: 24px; }
  .hero-shot .play { position: absolute; inset: 0; display: grid; place-items: center; }
  .hero-shot .play span { width: 96px; height: 96px; border-radius: 50%; display: grid;
                          place-items: center; background: rgba(20,22,26,.72); font-size: 38px;
                          border: 3px solid rgba(230,232,235,.85); padding-left: 6px; }
  .ago { font-size: 64px; font-weight: 700; line-height: 1.1; margin: 0 0 10px; }
  .hero-when { font-size: 30px; font-variant-numeric: tabular-nums; margin: 0 0 18px; }
  .hero-meta { font-size: 24px; color: #8b939e; margin: 0; }
  .hero .tag { font-size: 20px; padding: 4px 16px; border-radius: 24px; }
  .quiet { font-size: 40px; font-weight: 600; text-align: center; padding: 12vh 0; }
  .quiet small { display: block; font-size: 24px; font-weight: 400; color: #8b939e;
                 margin-top: 14px; }

  /* Earlier events: a strip, not a grid. Enough to scan, not to browse. */
  .tv h2 { font-size: 20px; margin: 4vh 0 16px; }
  .strip { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1.6vw; }
  .strip .card { border-radius: 10px; }
  .strip .time { font-size: 24px; }
  .strip .meta { padding: 14px 16px; }
  .strip .tag { font-size: 16px; padding: 2px 12px; }
  .strip .muted { font-size: 18px; }

  /* Focus, not hover: this is driven by a remote. */
  a:focus-visible, a:focus { outline: 5px solid #6fbf73; outline-offset: 4px; }
  .strip a.thumb:focus-visible, .strip a.thumb:focus { outline-offset: 0; }
`;

/**
 * Client-side live refresh.
 *
 * Swaps in fresh markup rather than calling location.reload(), so the page does
 * not jump to the top and any open <video> keeps playing. EventSource reconnects
 * on its own, which covers the container restarting.
 */
const LIVE_SCRIPT = `
  (() => {
    const indicator = document.getElementById('live');
    const source = new EventSource('/events');
    source.onopen = () => { indicator.hidden = false; };
    source.onerror = () => { indicator.hidden = true; };
    source.addEventListener('changed', async () => {
      try {
        const response = await fetch('/', { headers: { 'Accept': 'text/html' } });
        if (!response.ok) return;
        const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
        const fresh = doc.getElementById('content');
        const current = document.getElementById('content');
        if (fresh && current && fresh.innerHTML !== current.innerHTML) {
          current.innerHTML = fresh.innerHTML;
          const count = doc.querySelector('header .muted');
          const shown = document.querySelector('header .muted');
          if (count && shown) shown.textContent = count.textContent;
        }
      } catch {
        // Offline or mid-restart; EventSource will retry and we try again then.
      }
    });
  })();
`;

const renderIndex = (items, hostPath) => {
  const byDay = new Map();
  for (const item of items) {
    if (!byDay.has(item.day)) byDay.set(item.day, []);
    byDay.get(item.day).push(item);
  }

  const days = [...byDay.entries()]
    .map(([day, dayItems]) => {
      const cards = dayItems
        .map((item) => {
          const thumb = item.snapshot
            ? `<img src="/media/${encodeURIComponent(item.snapshot)}" alt="" loading="lazy">`
            : '<div class="noimg">no snapshot</div>';
          // An entry with no video links nowhere: there is nothing to play.
          const inner = item.name
            ? `<a class="thumb" href="/watch/${encodeURIComponent(item.name)}">${thumb}</a>`
            : `<div class="thumb">${thumb}</div>`;
          const sizeTag = item.name
            ? `<span class="muted">${formatBytes(item.size)}</span>`
            : '<span class="tag nofile">no video</span>';
          return `<div class="card">${inner}
            <div class="meta">
              <span class="time">${escapeHtml(item.time)}</span>
              <div class="tags">
                <span class="tag ${item.kind}">${escapeHtml(item.kind)}</span>
                ${sizeTag}
              </div>
              <span class="muted">${escapeHtml(item.camera)}</span>
            </div></div>`;
        })
        .join('\n');
      return `<h2>${escapeHtml(day)} <span class="muted">· ${dayItems.length}</span></h2>
        <div class="grid">${cards}</div>`;
    })
    .join('\n');

  const total = items.reduce((sum, item) => sum + item.size, 0);

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Ring recordings</title><style>${PAGE_STYLE}</style></head>
    <body><header><h1>Ring recordings</h1>
      <span class="muted">${items.length} events · ${formatBytes(total)}${
        hostPath ? ` · ${escapeHtml(hostPath)}` : ''
      }</span>
      <span id="live" class="live" hidden>● live</span>
      <a class="dl" href="/tv">TV view →</a></header>
    <main id="content">${days || '<p class="empty">No recordings yet.</p>'}</main>
    <script>${LIVE_SCRIPT}</script></body></html>`;
};

/**
 * Live refresh for the TV view.
 *
 * Replaces the whole <body> rather than a subtree, because the hero is the page:
 * a new event changes the headline, not just a list. Also re-ticks the relative
 * time every 30s, so a screen left on all day never reads "just now" an hour
 * later. Both go through the same swap function, so there is one code path.
 */
const TV_SCRIPT = `
  (() => {
    let busy = false;
    const swap = async () => {
      if (busy) return;
      busy = true;
      try {
        const response = await fetch(location.pathname + location.search,
          { headers: { 'Accept': 'text/html' } });
        if (!response.ok) return;
        const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
        const fresh = doc.getElementById('tv');
        const current = document.getElementById('tv');
        if (fresh && current && fresh.innerHTML !== current.innerHTML) {
          current.innerHTML = fresh.innerHTML;
        }
      } catch {
        // Offline or container restarting; the next tick or SSE retry covers it.
      } finally {
        busy = false;
      }
    };

    const source = new EventSource('/events');
    const indicator = () => document.getElementById('live');
    source.onopen = () => { const el = indicator(); if (el) el.hidden = false; };
    source.onerror = () => { const el = indicator(); if (el) el.hidden = true; };
    source.addEventListener('changed', swap);

    // Keeps "12 min ago" honest on a display nobody is touching.
    setInterval(swap, 30000);
  })();
`;

/**
 * The TV view: answers "has anything happened?" from across the room.
 *
 * Deliberately not the desktop grid at a larger size. That page is for browsing an
 * archive; this one leads with the single most recent event — how long ago, and a
 * still from it — because on a TV that is the only question worth asking. Earlier
 * events get a short strip below, capped, since scrolling with a remote is
 * miserable and the desktop page already does browsing properly.
 */
const renderTv = (items, now) => {
  const [latest, ...earlier] = items;

  const hero = latest
    ? (() => {
        const shot = latest.snapshot
          ? `<img src="/media/${encodeURIComponent(latest.snapshot)}" alt="">`
          : '<div class="noimg">no snapshot</div>';
        // Only wrap in a link if there is something to play.
        const inner = latest.name
          ? `<a class="hero-shot" href="/watch/${encodeURIComponent(latest.name)}">${shot}
               <span class="play"><span>▶</span></span></a>`
          : `<div class="hero-shot">${shot}</div>`;
        return `<div class="hero">${inner}
          <div>
            <p class="ago">${escapeHtml(relativeTime(eventTime(latest.stamp), now))}</p>
            <p class="hero-when">${escapeHtml(latest.day)} · ${escapeHtml(latest.time)}</p>
            <p class="hero-meta">
              <span class="tag ${latest.kind}">${escapeHtml(latest.kind)}</span>
              ${escapeHtml(latest.camera)}
              ${latest.name ? '' : ' · <span class="tag nofile">no video</span>'}
            </p>
          </div></div>`;
      })()
    : `<p class="quiet">All quiet<small>No recordings yet</small></p>`;

  // Four across, one row: a glanceable strip rather than an archive.
  const strip = earlier
    .slice(0, 4)
    .map((item) => {
      const thumb = item.snapshot
        ? `<img src="/media/${encodeURIComponent(item.snapshot)}" alt="" loading="lazy">`
        : '<div class="noimg">no snapshot</div>';
      const inner = item.name
        ? `<a class="thumb" href="/watch/${encodeURIComponent(item.name)}">${thumb}</a>`
        : `<div class="thumb">${thumb}</div>`;
      return `<div class="card">${inner}
        <div class="meta">
          <span class="time">${escapeHtml(relativeTime(eventTime(item.stamp), now))}</span>
          <div class="tags"><span class="tag ${item.kind}">${escapeHtml(item.kind)}</span></div>
          <span class="muted">${escapeHtml(item.time)}</span>
        </div></div>`;
    })
    .join('\n');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Ring — latest</title>
    <style>${PAGE_STYLE}${TV_STYLE}</style></head>
    <body><main class="tv" id="tv">
      <div class="tv-head"><h1>Front door</h1>
        <span class="muted">${items.length} recorded</span>
        <span id="live" class="live" hidden>● live</span></div>
      ${hero}
      ${strip ? `<h2>Earlier</h2><div class="strip">${strip}</div>` : ''}
    </main><script>${TV_SCRIPT}</script></body></html>`;
};

const renderWatch = (item) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(item.time)} ${escapeHtml(item.kind)}</title><style>${PAGE_STYLE}</style></head>
  <body><header><h1>${escapeHtml(item.day)} ${escapeHtml(item.time)}</h1>
    <span class="muted">${escapeHtml(item.camera)} · ${escapeHtml(item.kind)}</span></header>
  <main><a class="back" href="/">← All recordings</a>
    <video controls autoplay playsinline preload="metadata"
      ${item.snapshot ? `poster="/media/${encodeURIComponent(item.snapshot)}"` : ''}
      src="/media/${encodeURIComponent(item.name)}"></video>
    <p><a class="dl" href="/media/${encodeURIComponent(item.name)}?download=1">Download</a></p>
  </main></body></html>`;

/**
 * Streams a file, honouring HTTP Range requests.
 *
 * Range support is not optional here: browsers seek in an MP4 by requesting byte
 * ranges, and without a 206 response the scrub bar does not work. Safari will not
 * play the video at all.
 */
const serveMedia = async (request, response, path, download) => {
  let size;
  try {
    ({ size } = await stat(path));
  } catch {
    response.writeHead(404).end('Not found');
    return;
  }

  const extension = path.slice(path.lastIndexOf('.'));
  const headers = {
    'Content-Type': CONTENT_TYPES[extension] ?? 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    // Filenames are timestamped and never rewritten, so they are safe to cache.
    'Cache-Control': 'private, max-age=3600',
  };
  if (download) {
    headers['Content-Disposition'] = `attachment; filename="${basename(path)}"`;
  }

  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? '');
  if (range) {
    const [, rawStart, rawEnd] = range;
    // An open-ended "bytes=-500" means the *last* 500 bytes, not from zero.
    const start = rawStart === '' ? size - Number(rawEnd) : Number(rawStart);
    const end = rawStart === '' || rawEnd === '' ? size - 1 : Number(rawEnd);

    if (Number.isNaN(start) || start < 0 || start >= size || end < start) {
      response.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
      return;
    }

    const last = Math.min(end, size - 1);
    response.writeHead(206, {
      ...headers,
      'Content-Range': `bytes ${start}-${last}/${size}`,
      'Content-Length': last - start + 1,
    });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    createReadStream(path, { start, end: last }).pipe(response);
    return;
  }

  response.writeHead(200, { ...headers, 'Content-Length': size });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  createReadStream(path).pipe(response);
};

/** Constant-time credential comparison, so timing cannot leak the password. */
const credentialsMatch = (provided, expected) => {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * Notifies connected browsers when recordings change, over Server-Sent Events.
 *
 * SSE rather than WebSockets: the traffic is one-way and infrequent, and SSE is a
 * plain HTTP response with automatic client-side reconnection, so it needs no
 * dependency and survives the container restarting.
 *
 * fs.watch is coalesced behind a debounce because a single recording produces a
 * burst of events (`.part` created, written repeatedly, renamed, snapshot added)
 * and the browser only needs to know that *something* changed.
 */
const createEventStream = (outputDir) => {
  const clients = new Set();
  let debounce = null;
  let watcher = null;

  const broadcast = () => {
    debounce = null;
    for (const client of clients) {
      // A slow or dead client must not throw and take out the loop.
      try {
        client.write('event: changed\ndata: {}\n\n');
      } catch {
        clients.delete(client);
      }
    }
  };

  try {
    watcher = watch(outputDir, () => {
      if (debounce) {
        clearTimeout(debounce);
      }
      // 1s: long enough to collapse a recording's write burst, short enough that
      // the page updates while you are still looking at it.
      debounce = setTimeout(broadcast, 1000);
    });
    watcher.on('error', (error) => {
      // Some network filesystems do not support inotify. The UI still works, it
      // just will not live-update, so log it rather than crash the server.
      log.warn('Cannot watch recordings directory for changes', { error: error.message });
    });
  } catch (error) {
    log.warn('Live updates unavailable', { error: error.message });
  }

  return {
    add(response) {
      clients.add(response);
    },
    remove(response) {
      clients.delete(response);
    },
    close() {
      if (debounce) {
        clearTimeout(debounce);
      }
      watcher?.close();
      for (const client of clients) {
        client.end();
      }
      clients.clear();
    },
  };
};

export const startServer = (config) => {
  const { outputDir, webPort, webUsername, webPassword, hostOutputPath, trustedNetworks } = config;
  const authConfigured = Boolean(webUsername && webPassword);
  const expectedAuth = authConfigured
    ? `Basic ${Buffer.from(`${webUsername}:${webPassword}`).toString('base64')}`
    : null;

  /**
   * Whether this request may skip authentication.
   *
   * Uses the raw socket address only. X-Forwarded-For is deliberately ignored:
   * it is a client-supplied header, so honouring it would let anyone bypass
   * authentication by sending `X-Forwarded-For: 192.168.1.5`.
   */
  const isTrusted = (request) => {
    if (trustedNetworks.length === 0) {
      return false;
    }
    const address = request.socket.remoteAddress;
    return trustedNetworks.some((network) => ipInCidr(address, network));
  };

  const events = createEventStream(outputDir);

  const server = createServer((request, response) => {
    void handle(request, response).catch((error) => {
      log.error('Web request failed', { url: request.url, error: error.message });
      if (!response.headersSent) {
        response.writeHead(500).end('Internal error');
      }
    });
  });

  const handle = async (request, response) => {
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end('Method not allowed');
      return;
    }

    // Parsed against a dummy origin purely to split path from query safely.
    const url = new URL(request.url, 'http://localhost');
    const path = decodeURIComponent(url.pathname);

    // Ahead of the auth gate: its whole purpose is diagnosing why the gate did or
    // did not trigger, and it discloses only the caller's own address. Behind
    // Docker's userland proxy every client appears as the bridge gateway, which
    // would make TRUSTED_NETWORKS either useless or dangerously broad.
    if (path === '/whoami') {
      response.writeHead(200, { 'Content-Type': 'text/plain' }).end(
        `remoteAddress: ${request.socket.remoteAddress}\n` +
          `trusted: ${isTrusted(request)}\n` +
          `authConfigured: ${authConfigured}\n`,
      );
      return;
    }

    if (
      authConfigured &&
      !isTrusted(request) &&
      !credentialsMatch(request.headers.authorization ?? '', expectedAuth)
    ) {
      response
        .writeHead(401, {
          'WWW-Authenticate': 'Basic realm="Ring recordings", charset="UTF-8"',
        })
        .end('Unauthorized');
      return;
    }

    if (path === '/' || path === '/index.html') {
      const body = renderIndex(await listRecordings(outputDir), hostOutputPath);
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        // The listing changes whenever an event fires, so never cache it.
        'Cache-Control': 'no-store',
      });
      response.end(request.method === 'HEAD' ? undefined : body);
      return;
    }

    // Big-screen view for a TV or wall display. Same data, different question:
    // "has anything happened?" rather than "what is in the archive?".
    if (path === '/tv') {
      const body = renderTv(await listRecordings(outputDir), Date.now());
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(request.method === 'HEAD' ? undefined : body);
      return;
    }

    if (path === '/healthz') {
      response.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok\n');
      return;
    }

    if (path === '/events') {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        // Defeats response buffering in any reverse proxy sitting in front.
        'X-Accel-Buffering': 'no',
      });
      // Retry hint plus an initial comment, so the client knows it is connected.
      response.write('retry: 5000\n: connected\n\n');
      events.add(response);
      request.on('close', () => events.remove(response));
      return;
    }

    const mediaMatch = /^\/media\/(.+)$/.exec(path);
    if (mediaMatch) {
      const name = basename(mediaMatch[1]);
      if (!FILENAME_PATTERN.test(name)) {
        response.writeHead(404).end('Not found');
        return;
      }
      await serveMedia(request, response, join(outputDir, name), url.searchParams.has('download'));
      return;
    }

    const watchMatch = /^\/watch\/(.+)$/.exec(path);
    if (watchMatch) {
      const name = basename(watchMatch[1]);
      if (!FILENAME_PATTERN.test(name) || !name.endsWith('.mp4')) {
        response.writeHead(404).end('Not found');
        return;
      }
      const items = await listRecordings(outputDir);
      const item = items.find((candidate) => candidate.name === name);
      if (!item) {
        response.writeHead(404).end('Not found');
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(request.method === 'HEAD' ? undefined : renderWatch(item));
      return;
    }

    response.writeHead(404).end('Not found');
  };

  server.listen(webPort, () => {
    log.step('Web interface listening', {
      port: webPort,
      auth: authConfigured ? 'basic' : 'none',
      trustedNetworks: config.trustedNetworkSource,
    });
    if (!authConfigured) {
      log.warn(
        'Web interface has no authentication — anyone who can reach this port can view your ' +
          'footage. Set WEB_USERNAME and WEB_PASSWORD, and do not expose the port to the internet.',
      );
    } else if (trustedNetworks.length > 0) {
      log.substep(
        'Clients in the trusted networks skip the password. Check GET /whoami: if it reports a ' +
          'Docker bridge address rather than the real client IP, every request would look local — ' +
          'set TRUSTED_NETWORKS="" in that case.',
      );
    }
  });

  server.on('error', (error) => {
    // Non-fatal: a port clash should not stop the recorder from capturing events,
    // which is the job that actually matters.
    log.error('Web interface failed to start', { port: webPort, error: error.message });
  });

  return () =>
    new Promise((resolve) => {
      // SSE clients hold their connection open indefinitely by design, so they
      // must be ended explicitly or close() would never fire.
      events.close();
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
};
