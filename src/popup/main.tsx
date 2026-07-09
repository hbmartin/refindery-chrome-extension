import { render } from 'preact';
import { useEffect, useState, useCallback } from 'preact/hooks';
import '@/ui/styles.css';
import { send } from '@/ui/messaging';
import type { RecentEntry } from '@/common/types';
import type { Settings } from '@/common/settings';
import { domainOf } from '@/common/canonical';

interface State {
  settings: Settings;
  recent: RecentEntry[];
  queueCount: number;
  pending: number;
  authError: boolean;
}

function timeAgo(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function Popup() {
  const [state, setState] = useState<State | null>(null);
  const [conn, setConn] = useState<{ ready: boolean; authOk: boolean } | null>(null);
  const [tabDomain, setTabDomain] = useState<string | null>(null);
  const [confirmForget, setConfirmForget] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setState(await send({ type: 'getState' }));
  }, []);

  useEffect(() => {
    void refresh();
    void send({ type: 'testConnection' }).then(setConn);
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab?.url) setTabDomain(domainOf(tab.url));
    });
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [refresh]);

  const togglePause = async (paused: boolean) => {
    await send({ type: 'setPaused', paused });
    await refresh();
  };

  const doForget = async () => {
    if (!tabDomain) return;
    setBusy(true);
    const res = await send<{ ok: boolean; result?: any }>({
      type: 'forgetDomain',
      domain: tabDomain,
      reason: 'user requested from popup',
    });
    setBusy(false);
    setConfirmForget(false);
    if (res.ok) {
      alert(
        `Forgot ${tabDomain}: purged ${res.result?.pages_purged ?? 0} page(s). This domain is now blacklisted.`,
      );
    } else {
      alert('Forget failed — check the server connection in Options.');
    }
    await refresh();
  };

  const retry = async (localId: string) => {
    await send({ type: 'retryDead', localId });
    await refresh();
  };

  if (!state) return <div class="popup">Loading…</div>;

  const { settings } = state;
  const statusDot = state.authError
    ? 'err'
    : conn == null
      ? 'off'
      : conn.ready && conn.authOk
        ? 'ok'
        : 'warn';
  const statusText = state.authError || conn?.authOk === false
    ? 'Bad token — check Options'
    : conn?.ready
      ? 'Server ready'
      : settings.token
        ? 'Server unreachable — captures are queued'
        : 'Not configured — open Options';

  return (
    <div class="popup">
      <div class="row header">
        <h1>
          <span class={`dot ${statusDot}`} /> Refindery
        </h1>
        <label class="switch" title={settings.paused ? 'Paused' : 'Capturing'}>
          <input
            type="checkbox"
            checked={!settings.paused}
            onChange={(e) => togglePause(!(e.target as HTMLInputElement).checked)}
          />
          <span class="slider" />
        </label>
      </div>
      <div class="small muted mb">
        {settings.paused ? 'Auto-capture paused' : 'Auto-capturing pages you read'}
      </div>

      <div class="card small">
        <div class={statusDot === 'ok' ? 'ok-text' : statusDot === 'err' ? 'err-text' : ''}>
          {statusText}
        </div>
        <div class="muted mt">
          Queued: {state.queueCount} · Tracking: {state.pending}
        </div>
      </div>

      {tabDomain && (
        <div class="card mt small">
          <div class="row">
            <span>
              This site: <strong>{tabDomain}</strong>
            </span>
            {!confirmForget ? (
              <button class="danger" onClick={() => setConfirmForget(true)}>
                Forget domain…
              </button>
            ) : (
              <span class="inline">
                <button class="danger" disabled={busy} onClick={doForget}>
                  {busy ? '…' : 'Purge + block'}
                </button>
                <button onClick={() => setConfirmForget(false)}>Cancel</button>
              </span>
            )}
          </div>
          {confirmForget && (
            <div class="err-text small mt">
              Destructive & irreversible: permanently deletes all pages from{' '}
              <strong>{tabDomain}</strong> in Refindery and blacklists the domain.
            </div>
          )}
        </div>
      )}

      <div class="recent">
        {state.recent.length === 0 && (
          <div class="muted small mt">No captures yet.</div>
        )}
        {state.recent.map((e) => (
          <div class="entry" key={e.localId}>
            <div class="row">
              <span class="title">{e.title || e.url}</span>
              <span class={`badge ${e.state}`}>{e.state}</span>
            </div>
            <div class="row">
              <span class="url">{e.domain}</span>
              <span class="muted small">{timeAgo(e.updatedAt)}</span>
            </div>
            {e.contentChanged && (
              <div class="small" style="color: var(--amber)">
                content changed since first indexed
              </div>
            )}
            {e.lastError && <div class="small err-text">{e.lastError}</div>}
            {e.state === 'dead' && (
              <button class="small mt" onClick={() => retry(e.localId)}>
                Retry indexing
              </button>
            )}
          </div>
        ))}
      </div>

      <div class="row mt small">
        <a href="#" onClick={(ev) => { ev.preventDefault(); chrome.runtime.openOptionsPage(); }}>
          Settings & privacy
        </a>
        <span class="muted">v{chrome.runtime.getManifest().version}</span>
      </div>
    </div>
  );
}

render(<Popup />, document.getElementById('app')!);
