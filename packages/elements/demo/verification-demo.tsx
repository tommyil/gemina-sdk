/**
 * Tiny manual demo for <GeminaVerification> — no build system, one esbuild
 * line (see demo/verification.html for build + serve + token-minting
 * instructions, including the extractionIds-scoped mint body).
 *
 * The token is PASTED into the page, simulating what the tenant backend's
 * fetchToken endpoint would return. Real integrations point fetchToken at
 * their own backend; the Gemina API key never appears in browser code —
 * not even in this demo.
 */
import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { GeminaVerification } from '../src/verification';
import { GeminaTokenManager } from '../src/token-manager';

function DemoApp() {
  const [baseUrl, setBaseUrl] = useState('https://api.gemina.co');
  const [extractionId, setExtractionId] = useState('');
  const [pastedToken, setPastedToken] = useState('');
  const [session, setSession] = useState<{
    tokenManager: GeminaTokenManager;
    baseUrl: string;
    extractionId: string;
  } | null>(null);

  // fetchToken reads the LATEST pasted value, so re-pasting a fresh token
  // (after the 15-minute expiry) works without re-mounting the widget.
  const tokenRef = useRef('');
  tokenRef.current = pastedToken.trim();

  const mountVerification = () => {
    const tokenManager = new GeminaTokenManager({
      // In production this calls YOUR backend, e.g.:
      //   const res = await fetch("/api/gemina-session", { method: "POST" });
      //   return res.json(); // { token, expiresIn }
      fetchToken: async () => ({ token: tokenRef.current, expiresIn: 900 }),
    });
    setSession({
      tokenManager,
      baseUrl: baseUrl.trim(),
      extractionId: extractionId.trim(),
    });
  };

  return (
    <div>
      <label htmlFor="base-url">API base URL</label>
      <input
        id="base-url"
        value={baseUrl}
        onChange={(event) => setBaseUrl(event.target.value)}
      />

      <label htmlFor="extraction-id">Extraction id (inside the token's scope)</label>
      <input
        id="extraction-id"
        placeholder="00000000-0000-0000-0000-000000000000"
        value={extractionId}
        onChange={(event) => setExtractionId(event.target.value)}
      />

      <label htmlFor="token">Session token (from your backend's mint endpoint)</label>
      <textarea
        id="token"
        rows={4}
        placeholder="eyJhbGciOiJIUzI1NiIs..."
        value={pastedToken}
        onChange={(event) => setPastedToken(event.target.value)}
      />

      <button
        type="button"
        onClick={mountVerification}
        disabled={pastedToken.trim().length === 0 || extractionId.trim().length === 0}
      >
        {session === null ? 'Mount verification' : 'Remount verification'}
      </button>

      {session !== null && (
        <div id="verification-slot">
          <GeminaVerification
            extractionId={session.extractionId}
            tokenManager={session.tokenManager}
            baseUrl={session.baseUrl}
            onComplete={(result) => {
              console.log('verification complete:', result);
              // eslint-disable-next-line no-alert
              window.alert(`Verification complete — accuracy: ${result.summary.accuracy}`);
            }}
            onError={(reason, detail) => {
              console.log('verification error:', reason, detail);
              // eslint-disable-next-line no-alert
              window.alert(`Verification error: ${reason}`);
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
