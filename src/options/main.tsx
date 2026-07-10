import { render } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import '@/ui/styles.css';
import { send } from '@/ui/messaging';
import {
  DEFAULT_SETTINGS,
  getSettings,
  setSettings,
  type Settings,
  type UserSkipRule,
} from '@/common/settings';
import { DEFAULT_SENSITIVE_DOMAINS } from '@/common/exclusions';
import type { BlacklistEntry } from '@/common/types';
import { browserApi } from '@/common/browser';

const CATEGORIES = Array.from(new Set(DEFAULT_SENSITIVE_DOMAINS.map((d) => d.category)));

async function ensureHostPermission(baseUrl: string): Promise<boolean> {
  try {
    const origin = new URL(baseUrl).origin + '/*';
    if (await browserApi.permissions.contains({ origins: [origin] })) return true;
    return await browserApi.permissions.request({ origins: [origin] });
  } catch {
    return false;
  }
}

async function fetchBlacklist(): Promise<BlacklistEntry[]> {
  const res = await send<{ ok: boolean; entries: BlacklistEntry[] }>({
    type: 'listBlacklist',
  });
  return res.entries ?? [];
}

function Options() {
  const [s, setS] = useState<Settings | null>(null);
  const [saved, setSaved] = useState<string>('');
  const [conn, setConn] = useState<{ ready: boolean; authOk: boolean } | null>(null);
  const [blacklist, setBlacklist] = useState<BlacklistEntry[]>([]);
  const [newRule, setNewRule] = useState<UserSkipRule>({ pattern: '', kind: 'domain' });
  const [forgetInput, setForgetInput] = useState('');
  const [cooldownInput, setCooldownInput] = useState<string | null>(null);

  const loadBlacklist = async () => {
    setBlacklist(await fetchBlacklist());
  };

  useEffect(() => {
    void getSettings().then(setS);
    void fetchBlacklist().then(setBlacklist);
  }, []);

  const patch = (p: Partial<Settings>) => setS((prev) => (prev ? { ...prev, ...p } : prev));

  const save = async () => {
    if (!s) return;
    const okPerm = await ensureHostPermission(s.baseUrl);
    if (!okPerm) {
      setSaved('Host permission denied for that server URL.');
      return;
    }
    await setSettings(s);
    await send({ type: 'settingsChanged' });
    setSaved('Saved.');
    setTimeout(() => setSaved(''), 2000);
  };

  const test = async () => {
    if (!s) return;
    await setSettings(s);
    setConn(await send({ type: 'testConnection' }));
  };

  const cooldownHours = useMemo(() => (s ? Math.round(s.cooldownMs / 3600000) : 24), [s]);

  if (!s) return <div class="options">Loading…</div>;

  const toggleCategory = (cat: string, on: boolean) => {
    const set = new Set(s.disabledDefaultCategories);
    if (on) set.delete(cat);
    else set.add(cat);
    patch({ disabledDefaultCategories: [...set] });
  };

  const addRule = () => {
    const pattern = newRule.pattern.trim();
    if (!pattern) return;
    // De-dupe so two identical rules can't collide on the `kind:pattern` render key.
    const exists = s.userSkipRules.some((r) => r.kind === newRule.kind && r.pattern === pattern);
    if (!exists) patch({ userSkipRules: [...s.userSkipRules, { ...newRule, pattern }] });
    setNewRule({ pattern: '', kind: 'domain' });
  };

  const removeRule = (i: number) => {
    patch({ userSkipRules: s.userSkipRules.filter((_, idx) => idx !== i) });
  };

  const doForget = async () => {
    const v = forgetInput.trim();
    if (!v) return;
    if (!confirm(`Permanently purge and blacklist "${v}"? This cannot be undone.`)) return;
    const isUrl = /^https?:\/\//i.test(v);
    const res = await send<{ ok: boolean; error?: string }>(
      isUrl ? { type: 'forgetUrl', url: v } : { type: 'forgetDomain', domain: v },
    );
    if (res.ok) {
      setForgetInput('');
      await loadBlacklist();
    } else {
      alert(`Forget failed: ${res.error ?? 'unknown error'}`);
    }
  };

  const removeBlacklist = async (id: string) => {
    await send({ type: 'deleteBlacklist', id });
    await loadBlacklist();
  };

  return (
    <div class="options">
      <h1>Refindery Capture — Settings</h1>

      <div class="section">
        <h2>Server</h2>
        <label class="field">
          <span>Base URL</span>
          <input
            type="text"
            value={s.baseUrl}
            placeholder={DEFAULT_SETTINGS.baseUrl}
            onInput={(e) => patch({ baseUrl: (e.target as HTMLInputElement).value })}
          />
        </label>
        <label class="field">
          <span>Bearer token (REFINDERY_AUTH_TOKEN)</span>
          <input
            type="password"
            value={s.token}
            placeholder="paste the server token"
            onInput={(e) => patch({ token: (e.target as HTMLInputElement).value })}
          />
        </label>
        <div class="inline">
          <button class="primary" onClick={save}>
            Save
          </button>
          <button onClick={test}>Test connection</button>
          <span class="status-line">{saved}</span>
        </div>
        {conn && (
          <div class="status-line">
            Ready: <span class={conn.ready ? 'ok-text' : 'err-text'}>{String(conn.ready)}</span>
            {'  ·  '}Auth:{' '}
            <span class={conn.authOk ? 'ok-text' : 'err-text'}>{String(conn.authOk)}</span>
          </div>
        )}
        <div class="small muted status-line">
          The token is stored only on this device (chrome.storage.local), never synced.
        </div>
      </div>

      <div class="section">
        <h2>Capture</h2>
        <label class="field">
          <span>Re-capture cooldown (hours)</span>
          <input
            type="number"
            min={1}
            step={1}
            value={cooldownInput ?? String(cooldownHours)}
            onInput={(e) => {
              // Track the raw text so the field can be cleared while retyping;
              // only valid values reach settings.
              const raw = (e.target as HTMLInputElement).value;
              setCooldownInput(raw);
              const hours = Number(raw);
              if (Number.isInteger(hours) && hours >= 1) patch({ cooldownMs: hours * 3600000 });
            }}
            onBlur={() => setCooldownInput(null)}
          />
          {cooldownInput !== null &&
            (!Number.isInteger(Number(cooldownInput)) || Number(cooldownInput) < 1) && (
              <span class="err-text small">Enter a whole number of hours, 1 or more.</span>
            )}
        </label>
        <label class="inline">
          <input
            type="checkbox"
            checked={s.paused}
            onChange={(e) => patch({ paused: (e.target as HTMLInputElement).checked })}
          />
          <span>Pause all auto-capture</span>
        </label>
        <div class="inline" style="margin-top:10px">
          <button class="primary" onClick={save}>
            Save
          </button>
        </div>
      </div>

      <div class="section">
        <h2>Notifications</h2>
        <label class="inline mb">
          <input
            type="checkbox"
            checked={s.notify.onDead}
            onChange={(e) =>
              patch({ notify: { ...s.notify, onDead: (e.target as HTMLInputElement).checked } })
            }
          />
          <span>Notify when a page fails to index (dead)</span>
        </label>
        <label class="inline">
          <input
            type="checkbox"
            checked={s.notify.onServerDown}
            onChange={(e) =>
              patch({
                notify: { ...s.notify, onServerDown: (e.target as HTMLInputElement).checked },
              })
            }
          />
          <span>Notify when the server is unreachable</span>
        </label>
        <div class="inline" style="margin-top:10px">
          <button class="primary" onClick={save}>
            Save
          </button>
        </div>
      </div>

      <div class="section">
        <h2>Privacy exclusions (local — never sent)</h2>
        <p class="small muted">
          Default sensitive-category domains are skipped before anything is sent. Turn a category
          off to allow capturing those sites.
        </p>
        {CATEGORIES.map((cat) => (
          <label class="inline mb" key={cat}>
            <input
              type="checkbox"
              checked={!s.disabledDefaultCategories.includes(cat)}
              onChange={(e) => toggleCategory(cat, (e.target as HTMLInputElement).checked)}
            />
            <span style="text-transform:capitalize">{cat}</span>
          </label>
        ))}

        <h3 style="font-size:13px;margin:14px 0 6px">Your skip rules</h3>
        {s.userSkipRules.length === 0 && <div class="small muted">No custom rules.</div>}
        {s.userSkipRules.map((r, i) => (
          <div class="list-item" key={`${r.kind}:${r.pattern}`}>
            <span>
              <span class="tag">{r.kind}</span> {r.pattern}
            </span>
            <button class="danger" onClick={() => removeRule(i)}>
              Remove
            </button>
          </div>
        ))}
        <div class="inline" style="margin-top:10px">
          <select
            value={newRule.kind}
            onChange={(e) =>
              setNewRule({
                ...newRule,
                kind: (e.target as HTMLSelectElement).value as 'domain' | 'url',
              })
            }
          >
            <option value="domain">domain</option>
            <option value="url">url glob</option>
          </select>
          <input
            type="text"
            style="flex:1"
            placeholder={
              newRule.kind === 'domain' ? 'example.com' : 'https://example.com/private/*'
            }
            value={newRule.pattern}
            onInput={(e) =>
              setNewRule({ ...newRule, pattern: (e.target as HTMLInputElement).value })
            }
          />
          <button onClick={addRule}>Add</button>
          <button class="primary" onClick={save}>
            Save
          </button>
        </div>
      </div>

      <div class="section">
        <h2>Server blacklist (destructive forget)</h2>
        <p class="small muted">
          Purges matching pages from Refindery and blocks future ingests. Irreversible — removing a
          rule later does not restore purged content.
        </p>
        <div class="inline mb">
          <input
            type="text"
            style="flex:1"
            placeholder="domain (example.com) or full URL to forget"
            value={forgetInput}
            onInput={(e) => setForgetInput((e.target as HTMLInputElement).value)}
          />
          <button class="danger" onClick={doForget}>
            Forget
          </button>
        </div>
        {blacklist.length === 0 && <div class="small muted">No blacklist rules.</div>}
        {blacklist.map((b) => (
          <div class="list-item" key={b.id}>
            <span>
              <span class="tag">{b.kind}</span> {b.pattern}
              {b.reason && <span class="muted small"> — {b.reason}</span>}
            </span>
            <button onClick={() => removeBlacklist(b.id)}>Unblock</button>
          </div>
        ))}
      </div>
    </div>
  );
}

render(<Options />, document.getElementById('app')!);
