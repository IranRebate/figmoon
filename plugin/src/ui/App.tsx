import React, { useEffect, useRef, useState } from 'react';

type Status = {
  fileName: string;
  fileKey: string;
  currentPageName: string;
  pageCount: number;
  selectionCount: number;
};
type Identity = {
  protocol: string;
  plugin: { id: string; version: string; build: string };
  file: { key: string | null; name: string };
};
type Tab = 'home' | 'reference' | 'system' | 'activity';
type Activity = { tone: 'ok' | 'info' | 'error'; label: string; detail: string; time: number };
type Feedback = Pick<Activity, 'tone' | 'label' | 'detail'>;
type IconName =
  | 'moon'
  | 'home'
  | 'reference'
  | 'system'
  | 'activity'
  | 'arrow'
  | 'check'
  | 'shield'
  | 'download'
  | 'layers';

const NAV: Array<[Tab, IconName, string]> = [
  ['home', 'home', 'Connect'],
  ['reference', 'reference', 'References'],
  ['system', 'system', 'Design System'],
  ['activity', 'activity', 'Activity'],
];

const BRIDGE_URL = 'ws://localhost:29194/ws';
const ACQUISITION_URL = 'ws://localhost:29195/ws';

const post = (message: unknown) => parent.postMessage({ pluginMessage: message }, '*');

function Icon({ name }: { name: IconName }) {
  const paths = {
    arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
    check: <path d="m5 12 4 4L19 6" />,
    shield: (
      <>
        <path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z" />
        <path d="m8 12 3 3 5-6" />
      </>
    ),
    download: (
      <>
        <path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5" />
      </>
    ),
    layers: (
      <>
        <path d="m12 3 10 5-10 5L2 8Zm-10 9 10 5 10-5M2 16l10 5 10-5" />
      </>
    ),
    moon: <path d="M15.5 2.8a6.8 6.8 0 1 0 5.7 10.5 7.7 7.7 0 0 1-5.7-10.5Z" />,
    home: (
      <>
        <path d="m3 10 9-7 9 7" />
        <path d="M5 9v11h14V9M9 20v-6h6v6" />
      </>
    ),
    reference: (
      <>
        <rect x="4" y="4" width="16" height="16" rx="3" />
        <path d="m8 15 3-3 2 2 3-4 2 3M9 8h.01" />
      </>
    ),
    system: (
      <>
        <path d="M4 7h16M4 12h16M4 17h16" />
        <circle cx="8" cy="7" r="2" />
        <circle cx="15" cy="12" r="2" />
        <circle cx="10" cy="17" r="2" />
      </>
    ),
    activity: (
      <>
        <path d="M4 19V9M10 19V5M16 19v-7M22 19V3" />
      </>
    ),
  };
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

export default function App() {
  const [tab, setTab] = useState<Tab>('home');
  const [bridgeConnected, setBridgeConnected] = useState(false);
  const [status, setStatus] = useState<Status>({
    fileName: 'Opening document…',
    fileKey: '',
    currentPageName: 'Opening page…',
    pageCount: 0,
    selectionCount: 0,
  });
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [nonce, setNonce] = useState('');
  const [acquiring, setAcquiring] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [activities, setActivities] = useState<Activity[]>([]);
  const bridgeRef = useRef<WebSocket | null>(null);
  const acquisitionRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<number | null>(null);

  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [activityFilter, setActivityFilter] = useState<'all' | 'error'>('all');
  const [nonceTouched, setNonceTouched] = useState(false);
  const tabsRef = useRef<Array<HTMLButtonElement | null>>([]);
  const contentRef = useRef<HTMLElement | null>(null);
  const validNonce = /^[A-Za-z0-9_-]{43,128}$/.test(nonce);

  const log = (entry: Feedback) => {
    setActivities((current) => [{ ...entry, time: Date.now() }, ...current].slice(0, 50));
    setFeedback(entry);
  };

  useEffect(() => {
    contentRef.current?.scrollTo(0, 0);
  }, [tab]);

  useEffect(() => () => acquisitionRef.current?.close(), []);

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const message = event.data?.pluginMessage;
      if (!message) return;
      if (message.type === 'plugin-status') return setStatus(message.payload);
      if (message.type === 'plugin-identity') return setIdentity(message.payload);
      if (message.type === 'plugin-initialization-error') {
        log({
          tone: 'error',
          label: 'Full-document features unavailable',
          detail: 'Reopen the document and restart Figmoon to retry full-document access.',
        });
        return;
      }
      if (message.type === 'design-system-error') {
        setExporting(false);
        log({
          tone: 'error',
          label: 'Design System export failed',
          detail: 'Reopen the document and try exporting again.',
        });
        return;
      }
      if (message.type === 'design-system-export') {
        setExporting(false);
        const payload = message.payload;
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `figmoon-design-system-${Date.now()}.json`;
        link.click();
        URL.revokeObjectURL(url);
        log({
          tone: 'ok',
          label: 'Design System exported',
          detail: `${payload.variables.length} variables · ${payload.components.length} components`,
        });
        return;
      }
      if (message.type === 'acquisition-result') {
        setAcquiring(false);
        if (acquisitionRef.current?.readyState === WebSocket.OPEN) {
          acquisitionRef.current.send(JSON.stringify(message.payload));
        }
        setNonce('');
        setNonceTouched(false);
        log(
          message.payload.error
            ? {
                tone: 'error',
                label: 'Reference acquisition failed',
                detail: message.payload.error.message,
              }
            : {
                tone: 'ok',
                label: 'Reference acquired',
                detail: message.payload.data.export.nodeName,
              }
        );
        return;
      }
      if ('requestId' in message && bridgeRef.current?.readyState === WebSocket.OPEN)
        bridgeRef.current.send(JSON.stringify(message));
    };
    window.addEventListener('message', receive);
    post({ type: 'ui-ready' });
    return () => window.removeEventListener('message', receive);
  }, []);

  useEffect(() => {
    if (!status.fileKey || !identity) return;
    let disposed = false;
    const connect = () => {
      if (disposed) return;
      const socket = new WebSocket(
        `${BRIDGE_URL}?fileKey=${encodeURIComponent(status.fileKey)}&fileName=${encodeURIComponent(status.fileName)}&pluginBuild=${encodeURIComponent(identity.plugin.build)}`
      );
      bridgeRef.current = socket;
      socket.onopen = () => {
        setBridgeConnected(true);
        setActivities((current) =>
          [
            {
              tone: 'ok' as const,
              time: Date.now(),
              label: 'Workspace ready',
              detail: `${status.fileName} · AI bridge connected`,
            },
            ...current.filter((item) => item.label !== 'Workspace ready'),
          ].slice(0, 50)
        );
        post({ type: 'ui-ready' });
      };
      socket.onmessage = (event) =>
        post({ type: 'server-request', payload: JSON.parse(event.data) });
      socket.onerror = () => setBridgeConnected(false);
      socket.onclose = () => {
        if (disposed) return;
        setBridgeConnected(false);
        reconnectRef.current = window.setTimeout(connect, 1500);
      };
    };
    connect();
    return () => {
      disposed = true;
      if (reconnectRef.current) window.clearTimeout(reconnectRef.current);
      bridgeRef.current?.close();
    };
  }, [identity?.plugin.build, status.fileKey, status.fileName]);

  const connectAcquisition = () => {
    if (!identity || !/^[A-Za-z0-9_-]{43,128}$/.test(nonce)) {
      log({
        tone: 'error',
        label: 'Nonce is not valid',
        detail: 'Paste the one-time nonce printed by figma:acquire',
      });
      return;
    }
    setAcquiring(true);
    const socket = new WebSocket(ACQUISITION_URL);
    acquisitionRef.current = socket;
    socket.onopen = () =>
      socket.send(
        JSON.stringify({
          type: 'hello',
          protocol: identity.protocol,
          plugin: identity.plugin,
          sessionNonce: nonce,
          file: identity.file,
        })
      );
    socket.onmessage = (event) => {
      const payload = JSON.parse(event.data);
      if (payload.type === 'hello_ack' && payload.accepted) {
        log({
          tone: 'ok',
          label: 'Secure broker authenticated',
          detail: 'Waiting for one reference request',
        });
        return;
      }
      if (payload.type === 'acquire_reference') post({ type: 'acquire-reference', payload });
    };
    socket.onerror = () => {
      setAcquiring(false);
      log({
        tone: 'error',
        label: 'Secure broker unavailable',
        detail: 'Start figma:acquire before connecting',
      });
    };
    socket.onclose = () => setAcquiring(false);
  };

  const visibleActivities = activities.filter(
    (item) => activityFilter === 'all' || item.tone === 'error'
  );
  const errorCount = activities.filter((item) => item.tone === 'error').length;

  const navigate = (next: Tab) => {
    setTab(next);
    tabsRef.current[NAV.findIndex(([id]) => id === next)]?.focus();
  };

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <Icon name="moon" />
          </span>
          <div>
            <strong>Figmoon</strong>
            <span>Design-to-code workspace</span>
          </div>
        </div>
        <span role="status" className={`connection ${bridgeConnected ? 'online' : 'offline'}`}>
          <i />
          {bridgeConnected ? 'Connected' : 'Connecting'}
        </span>
      </header>
      <nav role="tablist" aria-label="Workspace">
        {NAV.map(([id, icon, label], index) => (
          <button
            key={id}
            ref={(element) => {
              tabsRef.current[index] = element;
            }}
            id={`tab-${id}`}
            role="tab"
            aria-selected={tab === id}
            aria-controls={`panel-${id}`}
            tabIndex={tab === id ? 0 : -1}
            className={tab === id ? 'active' : ''}
            onClick={() => setTab(id)}
            onKeyDown={(event) => {
              let next: number;
              if (event.key === 'ArrowRight') next = (index + 1) % NAV.length;
              else if (event.key === 'ArrowLeft') next = (index + NAV.length - 1) % NAV.length;
              else if (event.key === 'Home') next = 0;
              else if (event.key === 'End') next = NAV.length - 1;
              else return;
              event.preventDefault();
              navigate(NAV[next][0]);
            }}
          >
            <Icon name={icon} />
            <span>{label}</span>
            {id === 'activity' && errorCount > 0 && (
              <span className="tab-count" aria-label={`${errorCount} errors`}>
                {errorCount}
              </span>
            )}
          </button>
        ))}
      </nav>
      <section
        ref={contentRef}
        className="content"
        role="tabpanel"
        id={`panel-${tab}`}
        aria-labelledby={`tab-${tab}`}
        tabIndex={0}
      >
        {feedback && (
          <div
            className={`feedback ${feedback.tone}`}
            role={feedback.tone === 'error' ? 'alert' : 'status'}
          >
            <Icon name={feedback.tone === 'ok' ? 'check' : 'activity'} />
            <div>
              <strong>{feedback.label}</strong>
              <p>{feedback.detail}</p>
            </div>
            <button
              className="text-button"
              aria-label="Dismiss notification"
              onClick={() => setFeedback(null)}
            >
              Dismiss
            </button>
          </div>
        )}
        {tab === 'home' && (
          <>
            <div className="section-heading">
              <span className="eyebrow">YOUR LOCAL WORKSPACE</span>
              <h1>Design context. Connected.</h1>
              <p>One bridge from your Figma file to your AI workflow.</p>
            </div>
            <div className="document-panel">
              <div className="document-icon">
                <Icon name="home" />
              </div>
              <div className="document-copy">
                <span>Current document</span>
                <strong>{status.fileName}</strong>
                <small>
                  {status.currentPageName} · {status.pageCount} pages
                </small>
              </div>
              <span className={`state-dot ${bridgeConnected ? 'ready' : ''}`} />
            </div>
            <div className="capabilities">
              <article>
                <b>{status.pageCount}</b>
                <span>Pages in this file</span>
              </article>
              <article>
                <b>{status.selectionCount}</b>
                <span>Selected layers</span>
              </article>
              <article>
                <b>{identity ? (identity.file.key ? 'Stable' : 'Session') : 'Pending'}</b>
                <span>File identity</span>
              </article>
            </div>
            <div className={`bridge-panel ${bridgeConnected ? 'is-connected' : ''}`}>
              <div className="panel-title">
                <Icon name={bridgeConnected ? 'check' : 'activity'} />
                <strong>
                  {bridgeConnected ? 'Your bridge is connected' : 'Waiting for your AI host'}
                </strong>
              </div>
              <p>
                {bridgeConnected
                  ? 'Keep Figmoon open. Ask your AI to list files and confirm this document before starting.'
                  : 'Start your configured MCP host. Figmoon retries automatically while this window stays open.'}
              </p>
              <details>
                <summary>Connection checklist</summary>
                <ol className="steps">
                  <li>
                    <strong>Set up once</strong>
                    <code>npm run figmoon:setup</code>
                  </li>
                  <li>
                    <strong>Restart your AI / MCP host</strong>
                    <span>Enable the repository’s Figmoon server.</span>
                  </li>
                  <li>
                    <strong>Confirm the document</strong>
                    <span>
                      Ask your AI to run <code>list_files</code>. A connection badge alone does not
                      verify file access.
                    </span>
                  </li>
                </ol>
              </details>
            </div>
            <div className="section-label">CONTINUE YOUR WORKFLOW</div>
            <div className="quick-actions">
              <button onClick={() => navigate('reference')}>
                <span className="action-icon">
                  <Icon name="reference" />
                </span>
                <span>
                  <strong>Capture a reference</strong>
                  <small>Identity-verified image & evidence</small>
                </span>
                <Icon name="arrow" />
              </button>
              <button onClick={() => navigate('system')}>
                <span className="action-icon">
                  <Icon name="system" />
                </span>
                <span>
                  <strong>Export your design system</strong>
                  <small>Variables, components & styles</small>
                </span>
                <Icon name="arrow" />
              </button>
            </div>
            <div className="notice">
              <Icon name="layers" />
              <div>
                <strong>Selection is optional</strong>
                <p>
                  Search every page or target an exact node. Selected layers are simply a shortcut.
                </p>
              </div>
            </div>
          </>
        )}
        {tab === 'reference' && (
          <>
            <div className="section-heading">
              <span className="eyebrow">VERIFIABLE DESIGN EVIDENCE</span>
              <h1>Capture with confidence.</h1>
              <p>One immutable 1× PNG, bound to its exact document identity.</p>
            </div>
            <div className="workflow-strip">
              <span>
                <b>01</b> Start acquisition
              </span>
              <span>
                <b>02</b> Paste nonce
              </span>
              <span>
                <b>03</b> Capture
              </span>
            </div>
            <div className="command-panel">
              <strong>Start in your repository terminal</strong>
              <code>npm run figma:acquire -- --id &lt;registry-id&gt;</code>
              <p>
                Use the target’s registry ID, then paste the one-time nonce printed by the command.
              </p>
            </div>
            {!identity?.file.key && (
              <div className="notice warning">
                <Icon name="shield" />
                <div>
                  <strong>Saved file identity required</strong>
                  <p>
                    Save or reopen this Figma file, then restart Figmoon before acquiring a
                    reference.
                  </p>
                </div>
              </div>
            )}
            <label className="field" htmlFor="session-nonce">
              <span>One-time session nonce</span>
              <input
                id="session-nonce"
                type="password"
                autoComplete="off"
                spellCheck={false}
                disabled={acquiring}
                value={nonce}
                onBlur={() => setNonceTouched(true)}
                onChange={(event) => setNonce(event.target.value.trim())}
                aria-invalid={nonceTouched && !validNonce}
                aria-describedby="nonce-help"
                placeholder="Paste your one-time session nonce"
              />
              <small id="nonce-help" className={nonceTouched && !validNonce ? 'field-error' : ''}>
                {nonceTouched && !validNonce
                  ? 'Enter the complete 43–128 character nonce from the terminal.'
                  : 'Session only. Never stored or added to the activity log.'}
              </small>
            </label>
            <div className="identity-grid">
              <span>
                File key<b>{identity?.file.key ? 'Available' : 'Unavailable'}</b>
              </span>
              <span>
                Protocol<b>Figmoon v1</b>
              </span>
              <span>
                Broker<b>localhost:29195</b>
              </span>
              <span>
                Operation<b>Read once</b>
              </span>
            </div>
            <button
              className="primary"
              disabled={acquiring || !validNonce || !identity?.file.key}
              onClick={connectAcquisition}
            >
              <Icon name="shield" />
              {acquiring ? 'Waiting for reference request…' : 'Connect secure broker'}
            </button>
            <p className="action-note">Read once · Local broker · No Figma changes</p>
          </>
        )}
        {tab === 'system' && (
          <>
            <div className="section-heading">
              <span className="eyebrow">FROM DESIGN TO CONTRACT</span>
              <h1>Your system, ready to share.</h1>
              <p>A reviewable JSON package of your file’s design foundations.</p>
            </div>
            <div className="export-visual">
              <span className="export-symbol">
                <Icon name="system" />
              </span>
              <span className="format-badge">JSON EXPORT</span>
              <strong>One file. Complete context.</strong>
              <span>Collect local design assets without changing your document or repository.</span>
            </div>
            <div className="section-label">INCLUDED IN YOUR EXPORT</div>
            <ul className="checklist">
              <li>
                <Icon name="check" />
                <div>
                  <strong>Variables & collections</strong>
                  <span>Values, modes and token definitions</span>
                </div>
              </li>
              <li>
                <Icon name="check" />
                <div>
                  <strong>Components & variants</strong>
                  <span>Local components and component sets</span>
                </div>
              </li>
              <li>
                <Icon name="check" />
                <div>
                  <strong>Local styles</strong>
                  <span>Paint, typography, effects and grids</span>
                </div>
              </li>
              <li>
                <Icon name="check" />
                <div>
                  <strong>File provenance</strong>
                  <span>Source identity for explicit review</span>
                </div>
              </li>
            </ul>
            <button
              className="primary"
              disabled={exporting || !identity}
              onClick={() => {
                setExporting(true);
                post({ type: 'export-design-system' });
              }}
            >
              <Icon name="download" />
              {exporting ? 'Collecting document…' : 'Export Design System'}
            </button>
          </>
        )}
        {tab === 'activity' && (
          <>
            <div className="section-heading">
              <span className="eyebrow">LOCAL SESSION HISTORY</span>
              <h1>A clear view of your session.</h1>
              <p>Connection, reference and export events. Nothing is uploaded.</p>
            </div>
            <div className="activity-toolbar">
              <div className="filter-group" role="group" aria-label="Filter events">
                <button
                  aria-pressed={activityFilter === 'all'}
                  onClick={() => setActivityFilter('all')}
                >
                  All <span>{activities.length}</span>
                </button>
                <button
                  aria-pressed={activityFilter === 'error'}
                  onClick={() => setActivityFilter('error')}
                >
                  Errors <span>{errorCount}</span>
                </button>
              </div>
              <button
                className="text-button"
                disabled={!activities.length}
                onClick={() => setActivities([])}
              >
                Clear history
              </button>
            </div>
            <div className="activity-list">
              {visibleActivities.length === 0 ? (
                <div className="activity-empty">
                  <span className="empty-icon">
                    <Icon name={activityFilter === 'error' ? 'check' : 'activity'} />
                  </span>
                  <strong>
                    {activityFilter === 'error' ? 'No errors in this session' : 'A fresh start'}
                  </strong>
                  <p>
                    {activityFilter === 'error'
                      ? 'Switch to All to review other events.'
                      : 'Connection updates and completed operations will appear here.'}
                  </p>
                </div>
              ) : (
                visibleActivities.map((item, index) => (
                  <article key={`${item.time}-${index}`}>
                    <span className={`event-icon ${item.tone}`}>
                      <Icon name={item.tone === 'ok' ? 'check' : 'activity'} />
                    </span>
                    <div className="event-copy">
                      <div className="event-heading">
                        <strong>{item.label}</strong>
                        <time dateTime={new Date(item.time).toISOString()}>
                          {new Date(item.time).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </time>
                      </div>
                      <span>{item.detail}</span>
                      <small className={`event-tone ${item.tone}`}>
                        {item.tone === 'ok' ? 'Success' : item.tone === 'error' ? 'Error' : 'Info'}
                      </small>
                    </div>
                  </article>
                ))
              )}
            </div>
            <p className="action-note">Latest 50 events · Cleared when you close Figmoon</p>
          </>
        )}
      </section>
      <footer>
        <span>
          <Icon name="shield" />
          Local workspace · v{identity?.plugin.version ?? '1.0'}
        </span>
        <button onClick={() => post({ type: 'close-plugin' })}>Close</button>
      </footer>
    </main>
  );
}
