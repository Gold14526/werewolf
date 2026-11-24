// The published manifest identifies the current deployment. Never interrupt a
// game automatically: a player chooses when to load the new HTML and assets.
const currentRelease = document.querySelector('meta[name="moonwolf-release"]')?.content;

if (currentRelease) {
  const checkInterval = 5 * 60 * 1000;
  const manifestUrl = new URL('./release.json', location.href);
  let lastCheck = -Infinity;
  let checking = false;
  let notice = null;
  let offeredRelease = '';
  let dismissedRelease = '';

  function removeNotice() {
    notice?.remove();
    notice = null;
    offeredRelease = '';
  }

  function offerRefresh(releaseId) {
    if (releaseId === dismissedRelease) {
      removeNotice();
      return;
    }
    if (releaseId === offeredRelease) return;
    removeNotice();
    offeredRelease = releaseId;

    notice = document.createElement('div');
    notice.id = 'release-notice';
    notice.setAttribute('role', 'status');
    notice.setAttribute('aria-live', 'polite');
    notice.setAttribute('aria-atomic', 'true');
    notice.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:90;display:flex;align-items:center;gap:8px;flex-wrap:wrap;max-width:calc(100vw - 32px);padding:10px 12px;border:1px solid #dce0e4;border-radius:5px;background:#fff;color:#343a40;box-shadow:0 3px 14px #0002;font-size:14px';

    const message = document.createElement('span');
    message.textContent = '网页有新版，';
    const refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.className = 'btn primary small';
    refresh.textContent = '刷新';
    refresh.setAttribute('aria-label', '刷新网页，加载新版本');
    refresh.addEventListener('click', event => {
      event.stopPropagation();
      const url = new URL(location.href);
      // Keep the room invitation, hash and same-tab session while bypassing a
      // cached HTML response. No automatic navigation or reload retry is used.
      url.searchParams.set('__moonwolf_refresh', Date.now().toString(36));
      location.replace(url.href);
    });

    const later = document.createElement('button');
    later.type = 'button';
    later.className = 'btn secondary small';
    later.textContent = '稍后';
    later.addEventListener('click', event => {
      event.stopPropagation();
      dismissedRelease = releaseId;
      removeNotice();
    });
    notice.append(message, refresh, later);
    document.body.append(notice);
  }

  async function checkRelease() {
    if (checking || document.visibilityState === 'hidden' || Date.now() - lastCheck < checkInterval) return;
    checking = true;
    lastCheck = Date.now();
    try {
      const response = await fetch(manifestUrl.href, {
        cache: 'no-store', credentials: 'same-origin', signal: globalThis.AbortSignal?.timeout?.(8000),
      });
      if (!response.ok) return;
      const release = await response.json();
      if (typeof release.id !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/.test(release.id)) return;
      if (release.id === currentRelease) removeNotice();
      else offerRefresh(release.id);
    } catch {
      // Offline checks and a manifest being replaced during deployment are
      // harmless. The game connection and the next scheduled check continue.
    } finally {
      checking = false;
    }
  }

  document.addEventListener('visibilitychange', checkRelease);
  window.addEventListener('focus', checkRelease);
  setInterval(checkRelease, checkInterval);
  checkRelease();
}
