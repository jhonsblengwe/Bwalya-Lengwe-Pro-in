// v2 - view count fix
// =============================================
// Public App JS
// =============================================

// =============================================
// API URL — your Render backend
// Change this if your backend URL changes
const API = 'https://bwalya.onrender.com/api';


// =============================================
// IMAGE CACHE
// Stores blob URLs of already-loaded images so
// clicking a card doesn't re-download the image
// that was already shown in the grid
// =============================================
const imgCache = new Map();

function cacheImg(url) {
  if (!url || imgCache.has(url)) return;
  const img = new Image();
  img.onload = () => {
    // Create a blob URL only if browser supports it and image is loaded
    imgCache.set(url, url); // mark as cached (already in browser cache)
  };
  img.src = url;
}

// Return cached URL or original — browser HTTP cache does the real work
// once an image has been loaded with the same URL it won't re-fetch
function cachedUrl(url) {
  return url; // browser cache handles this automatically via same URL
}

// =============================================
// CLOUDINARY CDN IMAGE OPTIMIZER
// Transforms raw Cloudinary URLs to serve
// correctly sized, auto-format, auto-quality
// images via Cloudinary's global CDN.
//
// Sizes used:
//   'thumb' → w_400  (card grid thumbnails)
//   'hero'  → w_800  (featured hero image)
//   'full'  → w_1200 (detail page cover)
// =============================================
function cdnImg(url, size) {
  if (!url || !url.includes('res.cloudinary.com')) return url;
  const widths = { thumb: 400, hero: 800, full: 1200 };
  const w = widths[size] || 400;
  // Insert transformation before /upload/
  // e.g. .../upload/v123/... → .../upload/f_auto,q_auto,w_400/v123/...
  return url.replace('/upload/', `/upload/f_auto,q_auto,w_${w},c_fill/`);
}

// =============================================
let currentFilter = 'all';
let offset = 0;
const LIMIT = 12;
let searchTimer = null;
let isSearching = false;
let activeTag = null;
let collectedTags = new Set();

// ---- CACHE ----
// Stores already-fetched grid results and rich content per post
const cache = {
  grids:    {},   // key: "type|search|offset" → {items, timestamp}
  posts:    {},   // key: slug → full post data with rich_content
  featured: null, // cached featured hero item
  cards:    {},   // key: item.id → built DOM card element
  items:    {},   // key: item.id → raw item data (type, title, tags, etc.)
  TTL: 5 * 60 * 1000
};
function cacheKey(filter, search, off) { return `${filter}|${search}|${off}`; }
function cacheValid(entry) { return entry && (Date.now() - entry.ts < cache.TTL); }

// ---- INIT ----
document.addEventListener('DOMContentLoaded', () => {
  // Filter pills
  document.querySelectorAll('.filter-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      filterByType(pill.dataset.type);
    });
  });

  // Search input
  const searchInput = document.getElementById('search-input');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        const q = searchInput.value.trim();
        if (q.length > 1) {
          offset = 0;
          loadGrid(q);
          document.getElementById('grid-title').textContent = `Results for "${q}"`;
        } else if (q.length === 0) {
          offset = 0;
          loadGrid();
          document.getElementById('grid-title').textContent = 'Latest';
        }
      }, 350);
    });
  }

  // Check for slug in hash
  const hash = window.location.hash.slice(1);
  if (hash && hash.startsWith('post/')) {
    openDetail(hash.replace('post/', ''));
  } else if (hash === 'about') {
    showAboutPage();
    init();
  } else {
    init();
  }

  // Force all external links to open in system browser (Cordova InAppBrowser)
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a) return;
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('tel:') || href.startsWith('mailto:')) return;
    if (href.startsWith('http://') || href.startsWith('https://')) {
      e.preventDefault();
      // Use Cordova InAppBrowser if available, otherwise window.open
      if (window.cordova && window.cordova.InAppBrowser) {
        window.cordova.InAppBrowser.open(href, '_system');
      } else {
        window.open(href, '_blank');
      }
    }
  });

  // Fade in non-lazy CDN images once they load
  document.addEventListener('load', (e) => {
    if (e.target.tagName === 'IMG' && e.target.classList.contains('cdn-img')) {
      e.target.classList.add('loaded');
    }
  }, true);

  // IntersectionObserver lazy loader — loads images only when near viewport
  // Falls back to eager loading on old browsers
  if ('IntersectionObserver' in window) {
    const imgObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const img = entry.target;
          if (img.dataset.src) {
            img.src = img.dataset.src;
            img.removeAttribute('data-src');
            img.classList.add('lazy-loaded');
          }
          imgObserver.unobserve(img);
        }
      });
    }, { rootMargin: '200px 0px' }); // start loading 200px before visible

    // Observe all current and future lazy images
    function observeLazyImgs() {
      document.querySelectorAll('img.lazy-img[data-src]').forEach(img => imgObserver.observe(img));
    }
    observeLazyImgs();

    // Re-observe after new cards are added (after loadGrid, loadMore)
    const _origGrid = document.getElementById.bind(document);
    const gridObserver = new MutationObserver(observeLazyImgs);
    const grid = document.getElementById('content-grid');
    if (grid) gridObserver.observe(grid, { childList: true });
  } else {
    // Fallback: just set src from data-src immediately
    document.querySelectorAll('img.lazy-img[data-src]').forEach(img => {
      img.src = img.dataset.src;
    });
  }

  window.addEventListener('popstate', () => {
    const h = window.location.hash.slice(1);
    if (h && h.startsWith('post/')) {
      openDetail(h.replace('post/', ''));
    } else if (h === 'about') {
      showAboutPage();
    } else {
      showHome();
    }
  });
});

async function init() {
  await Promise.all([loadFeatured(), loadGrid()]);
}

// ---- FEATURED HERO ----
async function loadFeatured() {
  const hero = document.getElementById('featured-hero');
  // Use cache if valid
  if (cacheValid(cache.featured)) { renderHero(cache.featured.data); return; }
  try {
    const res = await fetch(`${API}/content?featured=true&limit=1`);
    const { items } = await res.json();
    if (!items || items.length === 0) {
      const res2 = await fetch(`${API}/content?limit=1`);
      const data2 = await res2.json();
      if (data2.items && data2.items.length > 0) {
        cache.featured = { data: data2.items[0], ts: Date.now() };
        renderHero(data2.items[0]);
      } else {
        hero.innerHTML = ''; hero.style.minHeight = '0';
      }
      return;
    }
    cache.featured = { data: items[0], ts: Date.now() };
    renderHero(items[0]);
  } catch {
    hero.innerHTML = ''; hero.style.minHeight = '0';
  }
}

function renderHero(item) {
  const hero = document.getElementById('featured-hero');
  const typeIcon = getTypeIcon(item.type);
  hero.innerHTML = `
    <div class="hero-card">
      <div class="hero-meta">
        <span class="hero-type-badge">${item.type}</span>
        <h1 class="hero-title">${escHtml(item.title)}</h1>
        <p class="hero-desc" id="hero-desc-${item.id}">Loading...</p>
        <div class="hero-cta-row">
          <button class="hero-cta" onclick="openDetail('${item.slug}')">
            ${item.type === 'book' ? '📖 Read Now' : item.type === 'video' ? '▶ Watch Now' : item.type === 'audio' ? '🎧 Listen Now' : '→ Read More'}
          </button>
        </div>
      </div>
      <div class="hero-image">
        ${item.cover_url
          ? `<img src="${cdnImg(item.cover_url,'hero')}" alt="${escHtml(item.title)}" loading="eager" class="cdn-img">`
          : `<div class="hero-no-image">${typeIcon}</div>`
        }
      </div>
    </div>
  `;

  // Fetch description in background
  fetchDescription(item, `hero-desc-${item.id}`);
}

// Fetch grid in background — replaces grid with exact API results (source of truth)
async function _fetchGridBackground(filter, search, ck, grid) {
  try {
    const params = new URLSearchParams({ limit: LIMIT, offset: 0 });
    if (filter !== 'all') params.set('type', filter);
    if (search) params.set('search', search);
    const res = await fetch(`${API}/content?${params}`);
    const { items } = await res.json();
    if (!items) return;

    // Only update if this filter is still the active one
    if (filter !== currentFilter) return;

    cache.grids[ck] = { items, ts: Date.now() };
    items.forEach(item => { cache.items[item.id] = item; });

    // Replace grid entirely with correct items
    collectedTags.clear();
    grid.innerHTML = '';
    items.forEach(item => {
      const card = cache.cards[item.id] || createCard(item);
      if (!cache.cards[item.id]) cache.cards[item.id] = card;
      grid.appendChild(card);
      (item.tags || []).forEach(t => { if (t) collectedTags.add(t.trim()); });
      const el = document.getElementById(`card-desc-${item.id}`);
      if (el && el.innerHTML.trim() === '') fetchDescription(item, `card-desc-${item.id}`);
    });
    renderTagBar();
    document.getElementById('load-more-btn').style.display =
      items.length === LIMIT ? 'inline-block' : 'none';
  } catch { /* silent — user already sees cached content */ }
}

// ---- CONTENT GRID ----
async function loadGrid(search = '') {
  const grid = document.getElementById('content-grid');
  const ck = cacheKey(currentFilter, search, offset);

  if (offset === 0) {
    collectedTags.clear();

    // 1. If exact cache hit — render instantly, no skeleton
    if (cacheValid(cache.grids[ck])) {
      grid.innerHTML = '';
      cache.grids[ck].items.forEach(item => {
        const card = cache.cards[item.id] || createCard(item);
        if (!cache.cards[item.id]) cache.cards[item.id] = card;
        grid.appendChild(card);
        (item.tags || []).forEach(t => { if (t) collectedTags.add(t.trim()); });
      });
      renderTagBar();
      cache.grids[ck].items.forEach(item => {
        const el = document.getElementById(`card-desc-${item.id}`);
        if (el && el.innerHTML.trim() === '') fetchDescription(item, `card-desc-${item.id}`);
      });
      document.getElementById('load-more-btn').style.display =
        cache.grids[ck].items.length === LIMIT ? 'inline-block' : 'none';
      return;
    }

    // 2. No exact cache but we have items in cache.items — show known items instantly
    //    while fetching the rest in background (no skeleton flash)
    if (!search && Object.keys(cache.items).length > 0) {
      const known = Object.values(cache.items).filter(item =>
        currentFilter === 'all' || item.type === currentFilter
      );
      if (known.length > 0) {
        grid.innerHTML = '';
        known.forEach(item => {
          const card = cache.cards[item.id] || createCard(item);
          if (!cache.cards[item.id]) cache.cards[item.id] = card;
          grid.appendChild(card);
          (item.tags || []).forEach(t => { if (t) collectedTags.add(t.trim()); });
        });
        renderTagBar();
        known.forEach(item => {
          const el = document.getElementById(`card-desc-${item.id}`);
          if (el && el.innerHTML.trim() === '') fetchDescription(item, `card-desc-${item.id}`);
        });
        // Show load more tentatively — will update after fetch
        document.getElementById('load-more-btn').style.display = 'inline-block';
        // Fetch in background to get accurate data and any items not yet cached
        _fetchGridBackground(currentFilter, search, ck, grid);
        return;
      }
    }

    // 3. Nothing cached at all — show skeleton and fetch
    grid.innerHTML = Array(6).fill('<div class="skeleton-card"></div>').join('');
  }

  try {
    const params = new URLSearchParams({ limit: LIMIT, offset });
    if (currentFilter !== 'all') params.set('type', currentFilter);
    if (search) params.set('search', search);

    const res = await fetch(`${API}/content?${params}`);
    const { items } = await res.json();
    // Store in cache
    if (offset === 0) cache.grids[ck] = { items: items || [], ts: Date.now() };

    if (offset === 0) grid.innerHTML = '';

    if (!items || items.length === 0) {
      if (offset === 0) {
        grid.innerHTML = `
          <div class="empty-state">
            <h3>Nothing here yet</h3>
            <p>Check back soon for new content.</p>
          </div>
        `;
      }
      document.getElementById('load-more-btn').style.display = 'none';
      return;
    }

    items.forEach(item => {
      // Store raw item data globally
      cache.items[item.id] = item;

      let card;
      if (cache.cards[item.id]) {
        // Reuse already-built DOM card — no re-render, no re-fetch of image
        card = cache.cards[item.id];
      } else {
        card = createCard(item);
        cache.cards[item.id] = card; // store for reuse next time
        if (item.cover_url) cacheImg(cdnImg(item.cover_url, 'thumb'));
      }
      grid.appendChild(card);
      // Collect tags from all items seen so far
      (item.tags || []).forEach(t => { if (t) collectedTags.add(t.trim()); });
    });

    // Render tag filter bar — always update so load-more adds new tags
    renderTagBar();

    // Load descriptions for cards that don't have content yet
    items.forEach(item => {
      const descEl = document.getElementById(`card-desc-${item.id}`);
      // Skip if already populated (cached card)
      if (descEl && descEl.innerHTML.trim() === '') {
        fetchDescription(item, `card-desc-${item.id}`);
      }
    });

    const btn = document.getElementById('load-more-btn');
    btn.style.display = items.length === LIMIT ? 'inline-block' : 'none';
  } catch (err) {
    if (offset === 0) {
      grid.innerHTML = `<div class="empty-state"><h3>Failed to load content</h3><p>${err.message}</p></div>`;
    }
  }
}

function createCard(item) {
  const el = document.createElement('article');
  el.className = 'content-card';
  el.dataset.id   = item.id;
  el.dataset.slug = item.slug; // used by incrementView
  el.onclick = () => openDetail(item.slug);

  const date = new Date(item.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const tags = (item.tags || []).slice(0, 3);
  const icon = getTypeIcon(item.type);

  // VIDEO card — custom inline player (no native controls)
  let coverSection;
  if (item.type === 'video' && item.file_url) {
    const vid_id = 'cv_' + item.id;
    coverSection = `
      <div class="card-cover card-cover-video" onclick="event.stopPropagation()">
        <video id="${vid_id}"
          class="card-video-el"
          src="${item.file_url}"
          poster="${item.cover_url ? cdnImg(item.cover_url,'thumb') : ''}"
          preload="none"
          playsinline
        ></video>
        <div class="card-vid-overlay" id="ov_${item.id}">
          <button class="card-vid-play-btn" onclick="cardVideoToggle('${item.id}')">
            <svg viewBox="0 0 24 24" fill="currentColor" width="36" height="36"><path d="M8 5v14l11-7z"/></svg>
          </button>
        </div>
        <div class="card-vid-controls" id="vctl_${item.id}">
          <button class="card-vid-btn" onclick="cardVideoToggle('${item.id}')">
            <svg class="cv-play" viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M8 5v14l11-7z"/></svg>
            <svg class="cv-pause" viewBox="0 0 24 24" fill="currentColor" width="20" height="20" style="display:none"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
          </button>
          <div class="card-vid-prog" onclick="cardVideoSeek(event,'${item.id}')">
            <div class="card-vid-prog-fill" id="vp_${item.id}"></div>
          </div>
          <button class="card-vid-btn" onclick="cardVideoMute('${item.id}')">
            <svg class="cv-vol" viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/></svg>
            <svg class="cv-mute" viewBox="0 0 24 24" fill="currentColor" width="18" height="18" style="display:none"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>
          </button>
        </div>
        <span class="card-type-overlay ${item.type}">${item.type}</span>
      </div>`;
  } else if (item.type === 'audio' && item.file_url) {
    // AUDIO card — mini player with cover as background
    const hasCover = !!item.cover_url;
    coverSection = `
      <div class="card-cover card-cover-audio ${hasCover ? 'card-audio-has-cover' : ''}"
           onclick="event.stopPropagation()"
           ${hasCover ? `style="background-image:url('${cdnImg(item.cover_url,'thumb')}')"` : ''}>
        ${hasCover ? `<div class="card-audio-blur"></div>` : ''}
        <audio id="ca_${item.id}" src="${item.file_url}" preload="none"></audio>
        <div class="card-audio-inner">
          <button class="card-audio-play-btn" onclick="cardAudioToggle('${item.id}')">
            <svg class="ca-play" viewBox="0 0 24 24" fill="currentColor" width="28" height="28"><path d="M8 5v14l11-7z"/></svg>
            <svg class="ca-pause" viewBox="0 0 24 24" fill="currentColor" width="28" height="28" style="display:none"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
          </button>
          <div class="card-audio-prog" onclick="cardAudioSeek(event,'${item.id}')">
            <div class="card-audio-fill" id="ap_${item.id}"></div>
          </div>
        </div>
        <span class="card-type-overlay ${item.type}">${item.type}</span>
      </div>`;
  } else {
    coverSection = `
      <div class="card-cover">
        ${item.cover_url
          ? `<img data-src="${cdnImg(item.cover_url,'thumb')}" alt="${escHtml(item.title)}" class="cdn-img lazy-img">`
          : `<div class="card-cover-placeholder">${icon}</div>`
        }
        <span class="card-type-overlay ${item.type}">${item.type}</span>
      </div>`;
  }

  el.innerHTML = `
    ${coverSection}
    <div class="card-body">
      ${tags.length > 0 ? `<div class="tags-row">${tags.map(t => `<span class="tag">${escHtml(t)}</span>`).join('')}</div>` : ''}
      <h3 class="card-title">${escHtml(item.title)}</h3>
      <div class="card-desc" id="card-desc-${item.id}"></div>
      ${item.type === 'event' ? `<div class="card-event-date" id="card-evdate-${item.id}">📅 Loading...</div>` : ''}
      <div class="card-footer">
        <span class="card-author" id="card-author-${item.id}"></span>
        <span class="card-views-count" data-views="${item.views || 0}">👁 ${formatNum(item.views || 0)}</span>
        <span class="card-date">${date}</span>
      </div>
    </div>
  `;

  return el;
}

// Fetch rich content (description/author) from Cloudinary via API
async function fetchDescription(item, targetId) {
  try {
    // Use cached post data if available
    let data;
    if (cacheValid(cache.posts[item.slug])) {
      data = cache.posts[item.slug].data;
    } else {
      const res = await fetch(`${API}/content/${item.slug}?nocount=1`);
      data = await res.json();
      cache.posts[item.slug] = { data, ts: Date.now() };
    }
    const rc = data.rich_content || {};

    const descEl = document.getElementById(targetId);
    if (descEl) {
      let html = '';
      if (rc.description) {
        html += `<span class="card-desc-text">${escHtml(rc.description)}</span>`;
      }
      if (rc.body && (data.type === 'article' || data.type === 'announcement')) {
        if (rc.description) {
          html += `<div class="card-body-html">${rc.body}</div>`;
        } else {
          html += `<div class="card-body-html">${rc.body}</div>`;
        }
      }
      descEl.innerHTML = html || '';
    }

    const authorEl = document.getElementById(`card-author-${item.id}`);
    if (authorEl && rc.author) {
      authorEl.textContent = rc.author;
    }

    // Event date on card
    const evDateEl = document.getElementById(`card-evdate-${item.id}`);
    if (evDateEl && rc.extra_metadata && rc.extra_metadata.event_date) {
      const ev = rc.extra_metadata;
      const d = new Date(ev.event_date + (ev.event_time ? 'T' + ev.event_time : 'T00:00'));
      const str = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
      evDateEl.textContent = '📅 ' + str + (ev.event_time ? ' · ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '');
    } else if (evDateEl) {
      evDateEl.textContent = '';
    }
  } catch { /* silently fail */ }
}


// ---- VIEW COUNTER ----
// ---- VIEW COUNTING ----
// =============================================
// VIEW COUNTING — simple and correct
// - In-memory only (resets on refresh/reopen)
// - Click card = count once per session
// - Same card again = no count
// - Refresh/reopen = no count (session reset)
// =============================================
const _viewed = new Set();     // non-media: counted once per session
const _mediaPlayed = new Map(); // media: reset after each full play

function _updateCardViews(slug, n) {
  const card = document.querySelector(`.content-card[data-slug="${slug}"]`);
  if (!card) return;
  const el = card.querySelector('.card-views-count');
  if (el) { el.dataset.views = n; el.textContent = '👁 ' + formatNum(n); }
}

function markMediaPlaying(slug) {
  if (_mediaPlayed.get(slug) === 'counted') return;
  _mediaPlayed.set(slug, 'counted');
  // Fire and forget — increment on server
  fetch(`${API}/content/${slug}`).then(r => r.json()).then(d => {
    if (cache.posts[slug]) cache.posts[slug].data.views = d.views;
    _updateCardViews(slug, d.views || 0);
  }).catch(() => {});
}

function resetMediaCount(slug) {
  _mediaPlayed.delete(slug); // allows next play to count again
}

// Legacy alias — not used for counting, just kept for safety
function incrementView(slug) {}
// ---- FILTER ----
function filterByType(type) {
  currentFilter = type;
  offset = 0;
  activeTag = null;
  collectedTags.clear();

  // Always show home page when filtering (works from about or detail too)
  document.getElementById('page-home').style.display = 'block';
  document.getElementById('page-detail').style.display = 'none';
  document.getElementById('page-about').style.display = 'none';
  window.location.hash = '';

  // Update nav
  document.querySelectorAll('.nav-link').forEach(l => {
    l.classList.toggle('active', l.dataset.filter === type);
  });
  document.querySelectorAll('.filter-pill').forEach(p => {
    p.classList.toggle('active', p.dataset.type === type);
  });
  // Keep sidebar pills in sync
  document.querySelectorAll('.sidebar-filter-pill').forEach(p => {
    p.classList.toggle('active', p.dataset.type === type);
  });

  const titles = { all: 'Latest', article: 'Articles', book: 'Books', video: 'Videos', link: 'Links', event: 'Events', work: 'My Works' };
  document.getElementById('grid-title').textContent = titles[type] || 'Latest';
  renderTagBar(); // clear it
  loadGrid();
}

// ---- TAG FILTER BAR ----
function renderTagBar() {
  let bar = document.getElementById('tag-filter-bar');
  if (!bar) return;

  const tags = Array.from(collectedTags).sort();
  if (tags.length === 0) {
    bar.innerHTML = '';
    bar.style.display = 'none';
    return;
  }

  bar.style.display = 'flex';
  bar.innerHTML = `
    <button class="tag-filter-btn ${activeTag === null ? 'active' : ''}" onclick="filterByTag(null)">All</button>
    ${tags.map(t => `<button class="tag-filter-btn ${activeTag === t ? 'active' : ''}" onclick="filterByTag('${escHtml(t)}')">${escHtml(t)}</button>`).join('')}
  `;
}

function filterByTag(tag) {
  activeTag = tag;
  // Re-render visible cards based on tag
  const cards = document.querySelectorAll('#content-grid .content-card');
  cards.forEach(card => {
    if (!tag) {
      card.style.display = '';
    } else {
      const cardTags = Array.from(card.querySelectorAll('.tag')).map(el => el.textContent.trim());
      card.style.display = cardTags.includes(tag) ? '' : 'none';
    }
  });
  // Update active state on buttons
  document.querySelectorAll('.tag-filter-btn').forEach(btn => {
    const btnTag = btn.textContent === 'All' ? null : btn.textContent;
    btn.classList.toggle('active', btnTag === tag);
  });
}

function loadMore() {
  offset += LIMIT;
  loadGrid(document.getElementById('search-input')?.value || '');
}

// ---- DETAIL PAGE ----
let _openingSlug = null;
let _pendingCardUpdate = null; // update card views when returning to home
async function openDetail(slug) {
  if (_openingSlug === slug) return; // already opening this slug
  _openingSlug = slug;
  window.location.hash = `post/${slug}`;
  document.getElementById('page-home').style.display = 'none';
  document.getElementById('page-detail').style.display = 'block';
  document.getElementById('page-about').style.display = 'none';
  document.getElementById('detail-content').innerHTML = `
    <div style="text-align:center;padding:80px"><div class="hero-loader" style="margin:0 auto"></div></div>
  `;
  window.scrollTo(0, 0);

  try {
    let data;
    if (_viewed.has(slug) && cacheValid(cache.posts[slug])) {
      // Already viewed + cached — serve from cache, no network, no count
      data = cache.posts[slug].data;
    } else if (_viewed.has(slug)) {
      // Already viewed but cache expired — fetch without counting
      const res = await fetch(`${API}/content/${slug}?nocount=1`);
      if (!res.ok) throw new Error('Post not found');
      data = await res.json();
      cache.posts[slug] = { data, ts: Date.now() };
    } else {
      // Not yet viewed this session — fetch normally
      // Server increments on GET (no ?nocount)
      // Media types: openDetail fetch uses ?nocount — markMediaPlaying handles counting
      const itemType = Object.values(cache.items).find(i => i.slug === slug)?.type;
      const isMedia = itemType === 'video' || itemType === 'audio';
      const res = await fetch(`${API}/content/${slug}` + (isMedia ? '?nocount=1' : ''));
      if (!res.ok) throw new Error('Post not found');
      data = await res.json();
      cache.posts[slug] = { data, ts: Date.now() };
      if (!isMedia) {
        _viewed.add(slug);
        // Update immediately + again after returning to home (card visible by then)
        _updateCardViews(slug, data.views || 0);
        _pendingCardUpdate = { slug, views: data.views || 0 };
      }
    }
    renderDetail(data);
  } catch (err) {
    document.getElementById('detail-content').innerHTML = `
      <div class="empty-state"><h3>Oops!</h3><p>${err.message}</p></div>
    `;
  } finally {
    _openingSlug = null;
  }
}



// ---- BOOK REVIEWS RENDERER ----
function buildReviewsSection(reviews) {
  if (!reviews || !reviews.length) return '';
  const cards = reviews.map(r => `
    <div class="review-card">
      <div class="review-card-header">
        ${r.photo
          ? `<img src="${cdnImg(r.photo,'thumb')}" class="review-avatar" alt="${escHtml(r.name)}">`
          : `<div class="review-avatar review-avatar-initials">${escHtml((r.name || '?')[0].toUpperCase())}</div>`
        }
        <div class="review-card-meta">
          <div class="review-card-name">${escHtml(r.name)}</div>
          ${r.role ? `<div class="review-card-role">${escHtml(r.role)}</div>` : ''}
        </div>
      </div>
      ${r.review ? `<p class="review-card-text">${escHtml(r.review)}</p>` : ''}
    </div>
  `).join('');
  return `
    <div class="book-reviews-section">
      <h3 class="book-reviews-title">Reader Reviews</h3>
      <div class="book-reviews-grid">${cards}</div>
    </div>`;
}
// ---- EVENT CARD BUILDER ----
function buildEventCard(ev, item) {
  if (!ev || !Object.keys(ev).length) return '';

  function fmtDate(d, t) {
    if (!d) return '';
    const date = new Date(d + (t ? 'T' + t : 'T00:00'));
    const opts = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
    let str = date.toLocaleDateString('en-US', opts);
    if (t) str += ' · ' + date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    return str;
  }

  const startStr = fmtDate(ev.event_date, ev.event_time);
  const endStr   = fmtDate(ev.event_end_date, ev.event_end_time);

  const rows = [];
  if (startStr) rows.push(`<div class="ev-row"><span class="ev-icon">📅</span><div><div class="ev-label">Date &amp; Time</div><div class="ev-val">${escHtml(startStr)}${endStr ? '<br><span class="ev-to">until</span> ' + escHtml(endStr) : ''}</div></div></div>`);
  if (ev.event_location) rows.push(`<div class="ev-row"><span class="ev-icon">📍</span><div><div class="ev-label">Venue</div><div class="ev-val">${escHtml(ev.event_location)}</div></div></div>`);
  if (ev.event_address)  rows.push(`<div class="ev-row"><span class="ev-icon">🗺</span><div><div class="ev-label">Address</div><div class="ev-val">${escHtml(ev.event_address)}</div></div></div>`);
  if (ev.event_organizer) rows.push(`<div class="ev-row"><span class="ev-icon">👤</span><div><div class="ev-label">Organizer</div><div class="ev-val">${escHtml(ev.event_organizer)}</div></div></div>`);
  if (ev.event_price)    rows.push(`<div class="ev-row"><span class="ev-icon">🎟</span><div><div class="ev-label">Price</div><div class="ev-val">${escHtml(ev.event_price)}</div></div></div>`);

  // Ticket: phone → WhatsApp or dialler depending on ev.event_whatsapp flag
  let ticketBtn = '';
  if (ev.event_ticket_url) {
    const val = ev.event_ticket_url.trim();
    const isPhone = /^[+\d][\d\s\-()]{4,}$/.test(val);
    let href, target;
    if (isPhone) {
      const digits = val.replace(/[^\d+]/g, '');
      href = ev.event_whatsapp
        ? `https://wa.me/${digits.replace(/^\+/, '')}`
        : `tel:${digits}`;
      target = ev.event_whatsapp ? 'target="_blank" rel="noopener"' : '';
    } else {
      href = val;
      target = 'target="_blank" rel="noopener"';
    }
    ticketBtn = `<a class="ev-ticket-btn" href="${href}" ${target}>Get Tickets / RSVP ↗</a>`;
  }

  // Maps link if address exists
  const mapsBtn = ev.event_address
    ? `<a class="ev-maps-btn" href="https://maps.google.com/?q=${encodeURIComponent(ev.event_address)}" target="_blank" rel="noopener">Open in Maps ↗</a>`
    : '';

  return `<div class="event-detail-card">${rows.join('')}${ticketBtn || mapsBtn ? `<div class="ev-actions">${ticketBtn}${mapsBtn}</div>` : ''}</div>`;
}

function renderDetail(item) {
  const rc = item.rich_content || {};
  const date = new Date(item.published_at || item.created_at).toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  let mediaHtml = '';
  // Derive safe filename for downloads
  const _dlName = (item.title || 'file').replace(/[^a-zA-Z0-9_\- ]/g,'_');

  if (item.type === 'video' && item.file_url) {
    const _ext = item.file_url.split('.').pop().split('?')[0] || 'mp4';
    mediaHtml = `
      <div class="detail-file-actions" style="margin-bottom:12px">
        <button class="detail-download-btn" onclick="downloadFile('${item.file_url}','${_dlName}.${_ext}')">⬇ Download Video</button>
      </div>
      <div class="custom-video-player" id="cvp">
        <video id="cvp-video" src="${item.file_url}" preload="metadata"></video>
        <div class="cvp-overlay" id="cvp-overlay">
          <button class="cvp-big-play" id="cvp-big-play" aria-label="Play">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          </button>
        </div>
        <div class="cvp-controls" id="cvp-controls">
          <button class="cvp-btn cvp-play-pause" id="cvp-playpause" aria-label="Play/Pause">
            <svg class="icon-play" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
            <svg class="icon-pause" viewBox="0 0 24 24" fill="currentColor" style="display:none"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
          </button>
          <span class="cvp-time" id="cvp-time">0:00 / 0:00</span>
          <div class="cvp-progress-wrap" id="cvp-progress-wrap">
            <div class="cvp-progress-bg">
              <div class="cvp-progress-fill" id="cvp-fill"></div>
              <div class="cvp-progress-thumb" id="cvp-thumb"></div>
            </div>
          </div>
          <button class="cvp-btn cvp-mute" id="cvp-mute" aria-label="Mute">
            <svg class="icon-vol" viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/></svg>
            <svg class="icon-muted" viewBox="0 0 24 24" fill="currentColor" style="display:none"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>
          </button>
          <button class="cvp-btn cvp-fullscreen" id="cvp-fullscreen" aria-label="Fullscreen">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>
          </button>
        </div>
      </div>
    `;
  } else if (item.type === 'audio' && item.file_url) {
    const _aext = item.file_url.split('.').pop().split('?')[0] || 'mp3';
    const hasCover = !!item.cover_url;
    mediaHtml = `
      <div class="detail-file-actions" style="margin-bottom:12px">
        <button class="detail-download-btn" onclick="downloadFile('${item.file_url}','${_dlName}.${_aext}')">⬇ Download Audio</button>
      </div>
      <div class="custom-audio-player ${hasCover ? 'cap-has-cover' : ''}" id="cap">
        ${hasCover ? `<div class="cap-cover-wrap"><img src="${cdnImg(item.cover_url,'thumb')}" class="cap-cover-img cdn-img" alt="cover"><div class="cap-cover-blur" style="background-image:url('${cdnImg(item.cover_url,'thumb')}')"></div></div>` : ''}
        <audio id="cap-audio" src="${item.file_url}" preload="metadata"></audio>
        <div class="cap-inner">
          <div class="cap-main-row">
            <button class="cap-play-btn" id="cap-play" aria-label="Play/Pause">
              <svg class="icon-play" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
              <svg class="icon-pause" viewBox="0 0 24 24" fill="currentColor" style="display:none"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
            </button>
            <div class="cap-info">
              <div class="cap-track-title">${escHtml(item.title)}</div>
              <div class="cap-time-row">
                <span id="cap-current">0:00</span>
                <div class="cap-progress-wrap" id="cap-progress-wrap">
                  <div class="cap-progress-bg">
                    <div class="cap-progress-fill" id="cap-fill"></div>
                    <div class="cap-progress-thumb" id="cap-pthumb"></div>
                  </div>
                </div>
                <span id="cap-duration">0:00</span>
              </div>
            </div>
            <button class="cap-vol-btn" id="cap-vol" aria-label="Mute">
              <svg class="icon-vol" viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/></svg>
              <svg class="icon-muted" viewBox="0 0 24 24" fill="currentColor" style="display:none"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>
            </button>
          </div>
        </div>
      </div>
    `;
  } else if ((item.type === 'book' || item.type === 'article') && item.file_url) {
    const safeName = item.title.replace(/[^a-zA-Z0-9_\- ]/g,'_');
    mediaHtml = `
      <div class="detail-file-actions">
        <button class="detail-download-btn" onclick="downloadFile('${item.file_url}','${safeName}.pdf','application/pdf')">
          ⬇ Download PDF
        </button>
      </div>
    `;
  } else if (item.type === 'link' && rc.external_link) {
    mediaHtml = `
      <a class="detail-ext-link" href="${rc.external_link}" target="_blank" rel="noopener">
        🔗 Visit Link ↗
      </a>
    `;
  } else if (item.type === 'event') {
    mediaHtml = buildEventCard(rc.extra_metadata || {}, item);
  } else if (item.type === 'event' && rc.extra_metadata) {
    const ev = rc.extra_metadata;
    // Format date/time nicely
    function fmtEventDate(dateStr, timeStr) {
      if (!dateStr) return '';
      const d = new Date(dateStr + (timeStr ? 'T' + timeStr : ''));
      const opts = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
      let out = d.toLocaleDateString('en-US', opts);
      if (timeStr) out += ' at ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
      return out;
    }
    const startStr = fmtEventDate(ev.event_date, ev.event_time);
    const endStr = fmtEventDate(ev.event_end_date, ev.event_end_time);
    mediaHtml = `
      <div class="event-info-card">
        <div class="event-info-row">
          <span class="event-info-icon">📅</span>
          <div class="event-info-text">
            <span class="event-info-label">Date &amp; Time</span>
            <span class="event-info-value">${escHtml(startStr)}${endStr ? '<br><span class="event-until">until ' + escHtml(endStr) + '</span>' : ''}</span>
          </div>
        </div>
        ${ev.event_location ? `
        <div class="event-info-row">
          <span class="event-info-icon">📍</span>
          <div class="event-info-text">
            <span class="event-info-label">Location</span>
            <span class="event-info-value">${escHtml(ev.event_location)}${ev.event_address ? '<br><span class="event-address">' + escHtml(ev.event_address) + '</span>' : ''}</span>
          </div>
        </div>` : ''}
        ${ev.event_organizer ? `
        <div class="event-info-row">
          <span class="event-info-icon">👤</span>
          <div class="event-info-text">
            <span class="event-info-label">Organizer</span>
            <span class="event-info-value">${escHtml(ev.event_organizer)}</span>
          </div>
        </div>` : ''}
        ${ev.event_price ? `
        <div class="event-info-row">
          <span class="event-info-icon">🎟</span>
          <div class="event-info-text">
            <span class="event-info-label">Price</span>
            <span class="event-info-value">${escHtml(ev.event_price)}</span>
          </div>
        </div>` : ''}
        ${ev.event_ticket_url ? `
        <div class="event-info-row">
          <a class="event-ticket-btn" href="${ev.event_ticket_url}" target="_blank" rel="noopener">🎫 Get Tickets / RSVP ↗</a>
        </div>` : ''}
      </div>
    `;
  }

  const tagsHtml = (item.tags || []).length > 0
    ? `<div class="detail-tags">${item.tags.map(t => `<span class="detail-tag">${escHtml(t)}</span>`).join('')}</div>`
    : '';

  document.getElementById('detail-content').innerHTML = `
    <div>
      <span class="detail-type-badge ${item.type}">${item.type}</span>
      <h1 class="detail-title">${escHtml(item.title)}</h1>
      <div class="detail-meta">
        ${rc.author ? `<span>✍ ${escHtml(rc.author)}</span>` : ''}
        <span>📅 ${date}</span>
        <span>👁 ${formatNum(item.views || 0)} views</span>
      </div>
      ${item.cover_url && item.type !== 'audio' && item.type !== 'video' ? `<div class="detail-cover"><img src="${cdnImg(item.cover_url,'thumb')}" alt="${escHtml(item.title)}" class="cdn-img detail-cover-img"></div>` : ''}
      ${tagsHtml}
      ${rc.description ? `<div class="detail-description">${escHtml(rc.description)}</div>` : ''}
      ${mediaHtml}
      ${rc.body ? `<div class="detail-body">${rc.body}</div>` : ''}
      ${rc.book_reviews && rc.book_reviews.length ? buildReviewsSection(rc.book_reviews) : ''}
    </div>
  `;

  document.title = `${item.title} — ContentHub`;

  // Init custom players after DOM is set
  requestAnimationFrame(() => {
    if (item.type === 'video' && item.file_url) initVideoPlayer();
    if (item.type === 'audio' && item.file_url) initAudioPlayer();
  });
}

function showHome() {
  window.location.hash = '';
  document.getElementById('page-home').style.display = 'block';
  document.getElementById('page-detail').style.display = 'none';
  document.getElementById('page-about').style.display = 'none';
  document.title = 'ContentHub';
  window.scrollTo(0, 0);
  // Apply any pending card view count update now that the card is visible
  if (_pendingCardUpdate) {
    _updateCardViews(_pendingCardUpdate.slug, _pendingCardUpdate.views);
    _pendingCardUpdate = null;
  }
}

function closeAboutPage() {
  showHome();
}

let _aboutSettingsCache = null;

async function showAboutPage() {
  window.location.hash = 'about';
  document.getElementById('page-home').style.display = 'none';
  document.getElementById('page-detail').style.display = 'none';
  document.getElementById('page-about').style.display = 'block';
  document.title = 'About — ContentHub';
  window.scrollTo(0, 0);

  const skeleton = document.getElementById('about-skeleton');
  const content  = document.getElementById('about-page-content');

  if (_aboutSettingsCache) {
    // Already loaded this session — show real content instantly, no skeleton flash
    skeleton.style.display = 'none';
    content.style.display = 'flex';
    applyAboutSettings(_aboutSettingsCache);
    return;
  }

  // First time this session — show skeleton while fetching
  skeleton.style.display = 'flex';
  content.style.display = 'none';

  try {
    const res = await fetch(`${API}/settings`);
    _aboutSettingsCache = await res.json();
    applyAboutSettings(_aboutSettingsCache);
  } catch { /* fall back to whatever is already in the HTML */ }
  finally {
    skeleton.style.display = 'none';
    content.style.display = 'flex';
  }
}

function applyAboutSettings(s) {
  if (!s) return;
  const style = s.style || {};
  const layout = s.layout || {};

  // Photo
  const photoWrap = document.querySelector('.about-page-photo-wrap');
  const photoImg = document.querySelector('.about-page-photo');
  const initialsEl = document.getElementById('about-initials-page');
  if (s.photo_url) {
    photoImg.src = s.photo_url;
    photoImg.style.display = 'block';
    if (initialsEl) initialsEl.style.display = 'none';
  } else if (initialsEl) {
    initialsEl.textContent = (s.name || 'BL').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  }

  // Photo layout
  if (photoWrap) {
    const size = (layout.photo_size || 100) + 'px';
    photoWrap.style.width = size;
    photoWrap.style.height = size;
    photoWrap.style.borderWidth = (layout.photo_border_width ?? 3) + 'px';
    photoWrap.style.borderColor = layout.photo_border_color || '#e0dbd0';
  }
  const contentEl = document.querySelector('.about-page-content');
  if (contentEl) {
    const pos = layout.photo_position || 'center';
    contentEl.style.alignItems = pos === 'left' ? 'flex-start' : pos === 'right' ? 'flex-end' : 'center';
    contentEl.style.textAlign = pos === 'left' ? 'left' : pos === 'right' ? 'right' : 'center';
  }

  // Text content
  const nameEl = document.querySelector('.about-page-name');
  const taglineEl = document.querySelector('.about-page-tagline');
  const bioEl = document.getElementById('about-page-bio');
  if (nameEl) {
    nameEl.textContent = s.name || 'Bwalya Lengwe';
    nameEl.style.fontSize = (style.name_font_size || 32) + 'px';
    nameEl.style.color = style.name_color || '#1a1814';
  }
  if (taglineEl) {
    taglineEl.textContent = s.tagline || '';
    taglineEl.style.fontSize = (style.tagline_font_size || 16) + 'px';
    taglineEl.style.color = style.tagline_color || '#7a7060';
  }
  if (bioEl) {
    bioEl.innerHTML = s.bio || '';
    bioEl.style.fontSize = (style.bio_font_size || 17) + 'px';
    bioEl.style.color = style.bio_color || '#3d3830';
  }

  // Contacts
  const emailLink = document.querySelector('.about-page-contact[href^="mailto:"]');
  if (emailLink && s.email) {
    emailLink.href = 'mailto:' + s.email;
    const val = emailLink.querySelector('.about-contact-value');
    if (val) val.textContent = s.email;
  }
  const phoneLink = document.querySelector('.about-page-contact[href^="tel:"]');
  if (phoneLink && s.phone) {
    phoneLink.href = 'tel:' + s.phone;
    const val = phoneLink.querySelector('.about-contact-value');
    if (val) val.textContent = s.phone;
  }
  const waLink = document.querySelector('.about-page-contact-whatsapp');
  if (waLink && s.whatsapp) {
    waLink.href = 'https://wa.me/' + s.whatsapp;
    const val = waLink.querySelector('.about-contact-value');
    if (val) val.textContent = '+' + s.whatsapp;
  }
}


// ---- SEARCH TOGGLE ----
function toggleSearch() {
  const bar = document.getElementById('search-bar');
  const hero = document.getElementById('featured-hero');
  const isVisible = bar.style.display !== 'none';
  if (isVisible) {
    // Close search — restore hero
    bar.style.display = 'none';
    if (hero) hero.style.display = '';
    // Clear results and reload normal grid
    const input = document.getElementById('search-input');
    if (input && input.value) {
      input.value = '';
      offset = 0;
      document.getElementById('grid-title').textContent = 'Latest';
      loadGrid();
    }
  } else {
    // Open search — hide hero so results are right at top
    bar.style.display = 'block';
    if (hero) hero.style.display = 'none';
    document.getElementById('search-input').focus();
  }
}

// ---- HELPERS ----
function getTypeIcon(type) {
  const icons = { book: '📚', article: '📰', video: '🎬', link: '🔗', event: '📅', work: '🖊' };
  return icons[type] || '📄';
}

function escHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatNum(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

// ---- THEME TOGGLE ----
function toggleTheme() {
  const html = document.documentElement;
  const isDark = html.getAttribute('data-theme') === 'dark';
  if (isDark) {
    html.removeAttribute('data-theme');
    localStorage.setItem('ch-theme', 'light');
  } else {
    html.setAttribute('data-theme', 'dark');
    localStorage.setItem('ch-theme', 'dark');
  }
}

// =============================================
// CUSTOM VIDEO PLAYER
// =============================================
function initVideoPlayer() {
  const wrap = document.getElementById('cvp');
  const video = document.getElementById('cvp-video');
  const overlay = document.getElementById('cvp-overlay');
  const bigPlay = document.getElementById('cvp-big-play');
  const playpause = document.getElementById('cvp-playpause');
  const iconPlay = playpause.querySelector('.icon-play');
  const iconPause = playpause.querySelector('.icon-pause');
  const timeEl = document.getElementById('cvp-time');
  const fill = document.getElementById('cvp-fill');
  const thumb = document.getElementById('cvp-thumb');
  const progressWrap = document.getElementById('cvp-progress-wrap');
  const muteBtn = document.getElementById('cvp-mute');
  const fsBtn = document.getElementById('cvp-fullscreen');

  if (!video) return;

  function fmtTime(s) {
    if (isNaN(s)) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  }

  function updatePlayState(playing) {
    iconPlay.style.display = playing ? 'none' : 'block';
    iconPause.style.display = playing ? 'block' : 'none';
    overlay.style.opacity = playing ? '0' : '1';
    overlay.style.pointerEvents = playing ? 'none' : 'auto';
  }

  function updateProgress() {
    if (!video.duration) return;
    const pct = (video.currentTime / video.duration) * 100;
    fill.style.width = pct + '%';
    thumb.style.left = pct + '%';
    timeEl.textContent = `${fmtTime(video.currentTime)} / ${fmtTime(video.duration)}`;
  }

  function seek(e) {
    const rect = progressWrap.querySelector('.cvp-progress-bg').getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    video.currentTime = (x / rect.width) * video.duration;
  }

  // Big play button — toggle play/pause
  bigPlay.addEventListener('click', (e) => {
    e.stopPropagation();
    video.paused ? video.play() : video.pause();
  });

  // Clicking the video itself while playing — pause and show overlay again
  video.addEventListener('click', () => {
    video.paused ? video.play() : video.pause();
  });

  // Overlay background (not the button) — also toggles
  overlay.addEventListener('click', (e) => {
    if (e.target === bigPlay || bigPlay.contains(e.target)) return;
    video.paused ? video.play() : video.pause();
  });

  playpause.addEventListener('click', () => {
    video.paused ? video.play() : video.pause();
  });

  video.addEventListener('play',  () => {
    updatePlayState(true);
    const slug = window.location.hash.replace('#post/', '');
    if (slug) markMediaPlaying(slug);
  });
  video.addEventListener('pause', () => updatePlayState(false));
  video.addEventListener('ended', () => {
    updatePlayState(false);
    const slug = window.location.hash.replace('#post/', '');
    if (slug) resetMediaCount(slug);
  });
  video.addEventListener('timeupdate', updateProgress);
  video.addEventListener('loadedmetadata', updateProgress);

  // Seek drag
  let seeking = false;
  progressWrap.addEventListener('mousedown', e => { seeking = true; seek(e); });
  document.addEventListener('mousemove', e => { if (seeking) seek(e); });
  document.addEventListener('mouseup', () => { seeking = false; });
  progressWrap.addEventListener('touchstart', e => {
    seeking = true; seek(e.touches[0]);
  }, { passive: true });
  document.addEventListener('touchmove', e => {
    if (seeking) seek(e.touches[0]);
  }, { passive: true });
  document.addEventListener('touchend', () => { seeking = false; });

  // Mute
  muteBtn.addEventListener('click', () => {
    video.muted = !video.muted;
    muteBtn.querySelector('.icon-vol').style.display = video.muted ? 'none' : 'block';
    muteBtn.querySelector('.icon-muted').style.display = video.muted ? 'block' : 'none';
  });

  // Fullscreen
  fsBtn.addEventListener('click', () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      wrap.requestFullscreen && wrap.requestFullscreen();
    }
  });

  // Auto-hide controls
  let hideTimer;
  wrap.addEventListener('mousemove', () => {
    wrap.classList.add('cvp-show-controls');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!video.paused) wrap.classList.remove('cvp-show-controls');
    }, 2500);
  });
  wrap.addEventListener('mouseleave', () => {
    if (!video.paused) wrap.classList.remove('cvp-show-controls');
  });
  wrap.classList.add('cvp-show-controls');
}

// =============================================
// CUSTOM AUDIO PLAYER
// =============================================
function initAudioPlayer() {
  const audio = document.getElementById('cap-audio');
  const playBtn = document.getElementById('cap-play');
  const fill = document.getElementById('cap-fill');
  const thumb = document.getElementById('cap-pthumb');
  const progressWrap = document.getElementById('cap-progress-wrap');
  const currentEl = document.getElementById('cap-current');
  const durationEl = document.getElementById('cap-duration');
  const volBtn = document.getElementById('cap-vol');

  if (!audio) return;

  function fmtTime(s) {
    if (isNaN(s)) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  }

  function updatePlayState(playing) {
    playBtn.querySelector('.icon-play').style.display = playing ? 'none' : 'block';
    playBtn.querySelector('.icon-pause').style.display = playing ? 'block' : 'none';
    playBtn.classList.toggle('playing', playing);
  }

  function updateProgress() {
    if (!audio.duration) return;
    const pct = (audio.currentTime / audio.duration) * 100;
    fill.style.width = pct + '%';
    thumb.style.left = pct + '%';
    currentEl.textContent = fmtTime(audio.currentTime);
  }

  function seek(e) {
    const bg = progressWrap.querySelector('.cap-progress-bg');
    const rect = bg.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    audio.currentTime = (x / rect.width) * audio.duration;
  }

  playBtn.addEventListener('click', () => {
    audio.paused ? audio.play() : audio.pause();
  });

  audio.addEventListener('play',  () => {
    updatePlayState(true);
    const slug = window.location.hash.replace('#post/', '');
    if (slug) markMediaPlaying(slug);
  });
  audio.addEventListener('pause', () => updatePlayState(false));
  audio.addEventListener('ended', () => {
    updatePlayState(false);
    const slug = window.location.hash.replace('#post/', '');
    if (slug) resetMediaCount(slug);
  });
  audio.addEventListener('timeupdate', updateProgress);
  audio.addEventListener('loadedmetadata', () => {
    durationEl.textContent = fmtTime(audio.duration);
    updateProgress();
  });

  // Seek drag
  let seeking = false;
  progressWrap.addEventListener('mousedown', e => { seeking = true; seek(e); });
  document.addEventListener('mousemove', e => { if (seeking) seek(e); });
  document.addEventListener('mouseup', () => { seeking = false; });
  progressWrap.addEventListener('touchstart', e => {
    seeking = true; seek(e.touches[0]);
  }, { passive: true });
  document.addEventListener('touchmove', e => {
    if (seeking) seek(e.touches[0]);
  }, { passive: true });
  document.addEventListener('touchend', () => { seeking = false; });

  // Volume / mute
  if (volBtn) {
    volBtn.addEventListener('click', () => {
      audio.muted = !audio.muted;
      volBtn.querySelector('.icon-vol').style.display = audio.muted ? 'none' : 'block';
      volBtn.querySelector('.icon-muted').style.display = audio.muted ? 'block' : 'none';
    });
  }
}


// ---- ABOUT SIDEBAR ----
function openAboutSidebar() {
  document.getElementById('about-sidebar').classList.add('open');
  document.getElementById('about-overlay').classList.add('active');
  document.body.style.overflow = 'hidden';
}

function closeSidebarPills(btn) {
  // Close sidebar after picking a filter
  closeAboutSidebar();
}

function closeAboutSidebar() {
  document.getElementById('about-sidebar').classList.remove('open');
  document.getElementById('about-overlay').classList.remove('active');
  document.body.style.overflow = '';
}


// =============================================
// PULL TO REFRESH
// =============================================
(function() {
  let startY = 0;
  let pulling = false;
  let pullDist = 0;
  const THRESHOLD = 72;   // px to pull before release triggers refresh
  const MAX_PULL  = 100;  // max visual stretch

  // Create indicator element
  const indicator = document.createElement('div');
  indicator.id = 'ptr-indicator';
  indicator.innerHTML = `
    <div class="ptr-inner">
      <svg class="ptr-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <path d="M12 5v14M5 12l7 7 7-7"/>
      </svg>
      <svg class="ptr-spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="display:none">
        <path d="M12 2a10 10 0 1 0 10 10" stroke-linecap="round"/>
      </svg>
      <span class="ptr-label">Pull to refresh</span>
    </div>
  `;
  document.body.prepend(indicator);

  const arrow   = indicator.querySelector('.ptr-arrow');
  const spinner = indicator.querySelector('.ptr-spinner');
  const label   = indicator.querySelector('.ptr-label');

  function setDist(d) {
    pullDist = Math.min(d, MAX_PULL);
    const pct = Math.min(pullDist / THRESHOLD, 1);
    indicator.style.height = pullDist + 'px';
    indicator.style.opacity = pct;
    arrow.style.transform = `rotate(${pct * 180}deg)`;
    label.textContent = pct >= 1 ? 'Release to refresh' : 'Pull to refresh';
  }

  function doRefresh() {
    // Show spinner
    arrow.style.display = 'none';
    spinner.style.display = 'block';
    label.textContent = 'Refreshing…';
    indicator.style.height = '60px';

    // Clear grid/card cache so content reloads fresh
    // Keep cache.posts so content stays available
    cache.grids = {}; cache.featured = null;
    cache.cards = {}; cache.items = {};
    const p = Promise.all([loadFeatured(), (function() {
      offset = 0;
      collectedTags.clear();
      activeTag = null;
      return loadGrid();
    })()]);

    p.finally(() => {
      // Snap back
      indicator.style.transition = 'height 0.3s ease, opacity 0.3s ease';
      indicator.style.height = '0px';
      indicator.style.opacity = '0';
      setTimeout(() => {
        indicator.style.transition = '';
        arrow.style.display = 'block';
        spinner.style.display = 'none';
        label.textContent = 'Pull to refresh';
        pullDist = 0;
      }, 320);
    });
  }

  document.addEventListener('touchstart', e => {
    // Only trigger when at top of page and on home page
    if (window.scrollY > 4) return;
    if (document.getElementById('page-home').style.display === 'none') return;
    startY = e.touches[0].clientY;
    pulling = true;
    indicator.style.transition = '';
  }, { passive: true });

  document.addEventListener('touchmove', e => {
    if (!pulling) return;
    const dist = e.touches[0].clientY - startY;
    if (dist <= 0) { setDist(0); return; }
    // Rubber-band: slow down as you pull further
    setDist(dist * 0.5);
  }, { passive: true });

  document.addEventListener('touchend', () => {
    if (!pulling) return;
    pulling = false;
    if (pullDist >= THRESHOLD) {
      doRefresh();
    } else {
      indicator.style.transition = 'height 0.25s ease, opacity 0.25s ease';
      indicator.style.height = '0px';
      indicator.style.opacity = '0';
    }
  });
})();

// =============================================
// IN-APP DOWNLOAD ENGINE
// Uses XHR (not fetch) — works on all Cordova
// versions without CSP/whitelist issues
// =============================================
function downloadFile(url, rawName, mimeType) {
  const filename = rawName
    .replace(/[^a-zA-Z0-9_\-. ]/g, '_')
    .replace(/\s+/g, '_');

  toast('⬇ Starting download…', 'info');
  showDL(filename, 0, 'Connecting…');

  const xhr = new XMLHttpRequest();
  xhr.open('GET', url, true);
  xhr.responseType = 'arraybuffer'; // arraybuffer avoids browser guessing mime type

  xhr.onprogress = function(e) {
    if (e.lengthComputable) {
      const pct = Math.round((e.loaded / e.total) * 100);
      updateDL(pct, fmtBytes(e.loaded) + ' / ' + fmtBytes(e.total));
    } else {
      updateDL(-1, fmtBytes(e.loaded) + ' received…');
    }
  };

  xhr.onload = function() {
    if (xhr.status !== 200) {
      hideDL();
      toast('❌ Server error: ' + xhr.status, 'error');
      return;
    }
    // Force correct MIME type so device opens file properly
    const type = mimeType || xhr.getResponseHeader('Content-Type') || 'application/octet-stream';
    const blob = new Blob([xhr.response], { type: type });
    if (window.cordova && window.resolveLocalFileSystemURL) {
      saveCordova(blob, filename);
    } else {
      saveBrowser(blob, filename);
    }
  };

  xhr.onerror  = function() { hideDL(); toast('❌ Network error — check connection', 'error'); };
  xhr.ontimeout = function() { hideDL(); toast('❌ Request timed out', 'error'); };
  xhr.timeout  = 120000;
  xhr.send();
}

// ---- Save on Cordova (Android/iOS) ----
function saveCordova(blob, filename) {
  updateDL(95, 'Saving to device…');

  const tryDirs = [
    () => new Promise((res, rej) => {
      window.resolveLocalFileSystemURL(
        cordova.file.externalRootDirectory,
        dir => dir.getDirectory('Download', {create:true}, dl =>
          dl.getDirectory('Bwalya', {create:true}, d => res(d), rej), rej), rej);
    }),
    () => new Promise((res, rej) => {
      window.resolveLocalFileSystemURL(
        cordova.file.externalRootDirectory,
        dir => dir.getDirectory('Documents', {create:true}, docs =>
          docs.getDirectory('Bwalya', {create:true}, d => res(d), rej), rej), rej);
    }),
    () => new Promise((res, rej) => {
      window.resolveLocalFileSystemURL(cordova.file.externalDataDirectory, d => res(d), rej);
    }),
    () => new Promise((res, rej) => {
      window.resolveLocalFileSystemURL(cordova.file.dataDirectory, d => res(d), rej);
    }),
  ];

  (async function tryNext(dirs) {
    for (const getDir of dirs) {
      try {
        const dirEntry  = await getDir();
        const fileEntry = await new Promise((res, rej) =>
          dirEntry.getFile(filename, {create:true, exclusive:false}, res, rej));
        const writer    = await new Promise((res, rej) => fileEntry.createWriter(res, rej));
        await new Promise((res, rej) => {
          writer.onwriteend = res;
          writer.onerror    = e => rej(new Error(JSON.stringify(e)));
          writer.write(blob);
        });
        const fileUri = fileEntry.toURL ? fileEntry.toURL() : fileEntry.nativeURL;
        hideDL();
        toast('✅ Saved to Downloads/Bwalya', 'success');
        window.open(fileUri, '_system');
        return;
      } catch(e) { /* try next dir */ }
    }
    hideDL();
    toast('❌ Could not save file to device', 'error');
  })(tryDirs);
}

// ---- Save on browser ----
function saveBrowser(blob, filename) {
  hideDL();
  if (window.showSaveFilePicker) {
    window.showSaveFilePicker({ suggestedName: filename })
      .then(fh => fh.createWritable())
      .then(w  => { w.write(blob); return w.close(); })
      .then(()  => toast('✅ ' + filename + ' saved!', 'success'))
      .catch(e  => { if (e.name !== 'AbortError') blobAnchor(blob, filename); });
  } else {
    blobAnchor(blob, filename);
  }
}

function blobAnchor(blob, filename) {
  const burl = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = burl; a.download = filename; a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(burl); a.remove(); }, 2000);
  toast('✅ ' + filename + ' saved!', 'success');
}

// ---- Progress overlay helpers ----
function showDL(name, pct, label) {
  document.getElementById('dl-title').textContent = '⬇ ' + name;
  document.getElementById('dl-bar').style.width   = (pct || 0) + '%';
  document.getElementById('dl-label').textContent = label || 'Starting…';
  document.getElementById('dl-overlay').classList.add('show');
}
function updateDL(pct, label) {
  if (pct >= 0) document.getElementById('dl-bar').style.width = pct + '%';
  document.getElementById('dl-label').textContent = label;
}
function hideDL() {
  document.getElementById('dl-overlay').classList.remove('show');
}

// ---- Toast notifications ----
function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = 'toast toast-' + type;
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

// ---- File size formatter ----
function fmtBytes(b) {
  if (!b) return '';
  return b < 1048576 ? (b/1024).toFixed(0)+' KB' : (b/1048576).toFixed(1)+' MB';
}

// =============================================
// CARD VIDEO MINI PLAYER
// =============================================
function cardVideoToggle(id) {
  const vid = document.getElementById('cv_' + id);
  const ov  = document.getElementById('ov_' + id);
  if (!vid) return;
  if (vid.paused) {
    vid.play();
    const _vcardSlug = vid.closest('.content-card')?.dataset.slug;
    if (_vcardSlug) markMediaPlaying(_vcardSlug);
    ov.style.opacity = '0';
    ov.style.pointerEvents = 'none';
    const ctl = document.getElementById('vctl_' + id);
    ctl.querySelector('.cv-play').style.display  = 'none';
    ctl.querySelector('.cv-pause').style.display = 'block';
  } else {
    vid.pause();
    ov.style.opacity = '1';
    ov.style.pointerEvents = 'auto';
    const ctl = document.getElementById('vctl_' + id);
    ctl.querySelector('.cv-play').style.display  = 'block';
    ctl.querySelector('.cv-pause').style.display = 'none';
  }
  vid.ontimeupdate = () => {
    if (!vid.duration) return;
    document.getElementById('vp_' + id).style.width =
      (vid.currentTime / vid.duration * 100) + '%';
  };
  vid.onended = () => {
    ov.style.opacity = '1';
    ov.style.pointerEvents = 'auto';
    const ctl = document.getElementById('vctl_' + id);
    ctl.querySelector('.cv-play').style.display  = 'block';
    ctl.querySelector('.cv-pause').style.display = 'none';
    const _vs = vid.closest('.content-card')?.dataset.slug;
    if (_vs) resetMediaCount(_vs); // reset so replay counts again
  };
}
function cardVideoSeek(e, id) {
  const vid  = document.getElementById('cv_' + id);
  if (!vid || !vid.duration) return;
  const rect = e.currentTarget.getBoundingClientRect();
  vid.currentTime = ((e.clientX - rect.left) / rect.width) * vid.duration;
}
function cardVideoMute(id) {
  const vid = document.getElementById('cv_' + id);
  if (!vid) return;
  vid.muted = !vid.muted;
  const ctl = document.getElementById('vctl_' + id);
  ctl.querySelector('.cv-vol').style.display  = vid.muted ? 'none'  : 'block';
  ctl.querySelector('.cv-mute').style.display = vid.muted ? 'block' : 'none';
}

// =============================================
// CARD AUDIO MINI PLAYER
// =============================================
function cardAudioToggle(id) {
  const aud = document.getElementById('ca_' + id);
  const btn = aud.closest('.card-cover-audio').querySelector('.card-audio-play-btn');
  if (!aud) return;
  if (aud.paused) {
    aud.play();
    const _acardSlug = aud.closest('.content-card')?.dataset.slug;
    if (_acardSlug) markMediaPlaying(_acardSlug);
    btn.querySelector('.ca-play').style.display  = 'none';
    btn.querySelector('.ca-pause').style.display = 'block';
  } else {
    aud.pause();
    btn.querySelector('.ca-play').style.display  = 'block';
    btn.querySelector('.ca-pause').style.display = 'none';
  }
  aud.ontimeupdate = () => {
    if (!aud.duration) return;
    const fill = document.getElementById('ap_' + id);
    if (fill) fill.style.width = (aud.currentTime / aud.duration * 100) + '%';
  };
  aud.onended = () => {
    btn.querySelector('.ca-play').style.display  = 'block';
    btn.querySelector('.ca-pause').style.display = 'none';
    const _as = aud.closest('.content-card')?.dataset.slug;
    if (_as) resetMediaCount(_as); // reset so replay counts again
  };
}
function cardAudioSeek(e, id) {
  const aud  = document.getElementById('ca_' + id);
  if (!aud || !aud.duration) return;
  const rect = e.currentTarget.getBoundingClientRect();
  aud.currentTime = ((e.clientX - rect.left) / rect.width) * aud.duration;
}
