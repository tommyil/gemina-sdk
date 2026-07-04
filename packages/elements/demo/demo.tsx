/**
 * Tiny manual demo for <GeminaChat> — no build system, one esbuild line
 * (see demo/index.html for build + serve + token-minting instructions).
 *
 * The token is PASTED into the page, simulating what the tenant backend's
 * fetchToken endpoint would return. Real integrations point fetchToken at
 * their own backend; the Gemina API key never appears in browser code —
 * not even in this demo.
 */
import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { GeminaChat } from '../src/chat';
import { GeminaTokenManager } from '../src/token-manager';

function DemoApp() {
  const [baseUrl, setBaseUrl] = useState('https://api.gemina.co');
  const [pastedToken, setPastedToken] = useState('');
  const [session, setSession] = useState<{
    tokenManager: GeminaTokenManager;
    baseUrl: string;
  } | null>(null);

  // fetchToken reads the LATEST pasted value, so re-pasting a fresh token
  // (after the 15-minute expiry) works without re-mounting the chat.
  const tokenRef = useRef('');
  tokenRef.current = pastedToken.trim();

  const mountChat = () => {
    const tokenManager = new GeminaTokenManager({
      // In production this calls YOUR backend, e.g.:
      //   const res = await fetch("/api/gemina-session", { method: "POST" });
      //   return res.json(); // { token, expiresIn }
      fetchToken: async () => ({ token: tokenRef.current, expiresIn: 900 }),
    });
    setSession({ tokenManager, baseUrl: baseUrl.trim() });
  };

  return (
    <div>
      <label htmlFor="base-url">API base URL</label>
      <input
        id="base-url"
        value={baseUrl}
        onChange={(event) => setBaseUrl(event.target.value)}
      />

      <label htmlFor="token">Session token (from your backend's mint endpoint)</label>
      <textarea
        id="token"
        rows={4}
        placeholder="eyJhbGciOiJIUzI1NiIs..."
        value={pastedToken}
        onChange={(event) => setPastedToken(event.target.value)}
      />

      <button type="button" onClick={mountChat} disabled={pastedToken.trim().length === 0}>
        {session === null ? 'Mount chat' : 'Remount chat'}
      </button>

      {session !== null && (
        <div id="chat-slot">
          <GeminaChat
            tokenManager={session.tokenManager}
            baseUrl={session.baseUrl}
            onCitationClick={(documentId) => {
              // eslint-disable-next-line no-alert
              window.alert(`Citation clicked: ${documentId}`);
            }}
          />
        </div>
      )}
    </div>
  );
}

const rootElement = document.getElementById('root');
if (rootElement === null) {
  throw new Error('demo: #root element missing');
}
createRoot(rootElement).render(<DemoApp />);
