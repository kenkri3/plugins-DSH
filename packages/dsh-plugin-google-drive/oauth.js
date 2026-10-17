/**
 * Google OAuth 2.0 for an installed application, without any dependency.
 *
 * The flow is the one Google documents for desktop apps: PKCE (S256), a
 * loopback redirect on `127.0.0.1`, and the system browser. A loopback address
 * matters twice here: Google rejects embedded user agents (`disallowed_useragent`),
 * so the consent page must open outside the Harness window, and a loopback
 * listener is the only redirect a locally running plugin can receive.
 *
 * `fetchImpl` is a parameter everywhere so the token logic can be unit-tested
 * against a fake fetch rather than the network.
 */

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';

import { CALLBACK_PATH, DEFAULT_PORT, DRIVE_SCOPE } from './logic.js';

export const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';

/** base64url without padding, the encoding PKCE and OAuth state use. */
export function base64url(value) {
  return Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/** The PKCE pair: a high-entropy verifier and its SHA-256 challenge. */
export function createPkce() {
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** An unguessable `state`, so a forged callback cannot complete the flow. */
export function randomState() {
  return base64url(randomBytes(24));
}

/** The exact redirect URI the OAuth client must be allowed to use. */
export function loopbackRedirectUri(port = DEFAULT_PORT) {
  return `http://127.0.0.1:${Number(port)}${CALLBACK_PATH}`;
}

/**
 * Read the JSON file Google Cloud lets a person download for an OAuth client.
 *
 * That file wraps the credentials in `installed` (Desktop app) or `web`; some
 * exports are the bare object. Accepting it removes a copy-paste step and one
 * class of typo, and `client_id` is public either way.
 */
export function parseClientJson(text) {
  let data;
  try {
    data = JSON.parse(String(text ?? ''));
  } catch (error) {
    throw Object.assign(new Error(`Klientfilen er ikke gyldig JSON: ${error?.message ?? error}`), {
      code: 'KLIENTFIL',
    });
  }
  const spec = data?.installed ?? data?.web ?? data;
  const clientId = String(spec?.client_id ?? '').trim();
  const clientSecret = String(spec?.client_secret ?? '').trim();
  if (clientId === '') {
    throw Object.assign(
      new Error(
        'Fant ingen client_id i filen. Last ned JSON-filen på nytt fra Google Cloud, ' +
          'eller lim inn Client ID direkte.',
      ),
      { code: 'KLIENTFIL' },
    );
  }
  return { clientId, clientSecret };
}

/** The consent URL the browser is sent to. */
export function buildAuthUrl(input) {
  const params = new URLSearchParams({
    client_id: String(input.clientId ?? ''),
    redirect_uri: String(input.redirectUri ?? ''),
    response_type: 'code',
    scope: String(input.scope ?? DRIVE_SCOPE),
    state: String(input.state ?? ''),
    code_challenge: String(input.challenge ?? ''),
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
  });
  if (input.loginHint) params.set('login_hint', String(input.loginHint));
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

function callbackPage(title, body) {
  return `<!doctype html><html lang="no"><head><meta charset="utf-8">
<title>${title}</title>
<style>
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#0f172a;color:#e2e8f0;
display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
main{max-width:32rem;padding:2rem;text-align:center}
h1{font-size:1.25rem;margin:0 0 .75rem}
p{margin:.5rem 0;color:#94a3b8;line-height:1.5}
</style></head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;
}

/**
 * Start the loopback listener that receives the authorization code.
 *
 * The listener binds `127.0.0.1` only, rejects a callback whose `state` does not
 * match, and answers the browser with a page a person can act on. It closes on
 * the first valid callback, on timeout, on abort, and through `close()`.
 *
 * @returns {{port: number, result: Promise<string>, close: () => void}}
 */
export function startCallbackServer(options = {}) {
  const port = Number(options.port ?? DEFAULT_PORT);
  const expectedPath = String(options.expectedPath ?? CALLBACK_PATH);
  const expectedState = options.state === undefined ? undefined : String(options.state);
  const timeoutMs = Number(options.timeoutMs ?? 300000);

  let server;
  let timer;
  let settled = false;
  let resolveResult;
  let rejectResult;
  let resolveReady;
  let rejectReady;
  let resolveClosed;

  const result = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  /** Resolves once the listener actually accepts connections. */
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  ready.catch(() => {});

  /** Resolves once the port is free again, so a retry can rebind it. */
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });

  const settle = (fn, value) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    try {
      if (server?.listening) {
        server.close(() => resolveClosed());
      } else {
        resolveClosed();
      }
    } catch {
      resolveClosed();
    }
    fn(value);
  };

  const handler = (request, response) => {
    let url;
    try {
      url = new URL(String(request.url ?? '/'), 'http://127.0.0.1');
    } catch {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Ugyldig forespørsel.');
      return;
    }

    if (url.pathname !== expectedPath) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Ikke funnet.');
      return;
    }

    const finish = (status, body) => {
      response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(body);
    };

    const state = url.searchParams.get('state');
    if (expectedState !== undefined && state !== expectedState) {
      finish(400, callbackPage('Feil tilbakeringing', 'Sikkerhetskontrollen (state) stemte ikke. Lukk vinduet og prøv igjen fra DeepSeek Harness.'));
      settle(rejectResult, Object.assign(new Error('Tilbakeringingen hadde feil state; prøv /drive koble på nytt.'), { code: 'STATE' }));
      return;
    }

    const error = url.searchParams.get('error');
    if (error) {
      finish(
        200,
        callbackPage(
          'Tilkoblingen ble avbrutt',
          `Google svarte «${error}». Lukk vinduet, og kjør /drive koble igjen hvis du vil prøve på nytt.`,
        ),
      );
      settle(
        rejectResult,
        Object.assign(new Error(`Google avbrøt tilkoblingen (${error}).`), { code: error === 'access_denied' ? 'AVBRUTT' : 'OAUTH' }),
      );
      return;
    }

    const code = url.searchParams.get('code');
    if (!code) {
      finish(400, callbackPage('Mangler kode', 'Google sendte ingen autorisasjonskode. Prøv igjen fra DeepSeek Harness.'));
      settle(rejectResult, Object.assign(new Error('Google sendte ingen autorisasjonskode.'), { code: 'OAUTH' }));
      return;
    }

    finish(
      200,
      callbackPage(
        'Ferdig – du kan lukke vinduet',
        'DeepSeek Harness har fått tilgang. Gå tilbake til appen og skriv /drive for å se status.',
      ),
    );
    settle(resolveResult, code);
  };

  server = http.createServer(handler);
  const handle = {
    port,
    ready,
    result,
    closed,
    close() {
      settle(rejectResult, Object.assign(new Error('Tilkoblingen ble avbrutt.'), { code: 'AVBRUTT' }));
    },
  };
  server.on('listening', () => {
    // `port` may be 0, which asks the OS for a free port; the tests need the real one.
    const address = server.address();
    if (address && typeof address === 'object' && Number.isInteger(address.port)) {
      handle.port = address.port;
    }
    resolveReady(true);
  });
  server.on('error', (error) => {
    try {
      rejectReady(error instanceof Error ? error : new Error(String(error)));
    } catch {
      // The ready promise only carries the first failure.
    }
    const message =
      error?.code === 'EADDRINUSE'
        ? `Port ${port} er opptatt. Steng det andre programmet, eller sett DSH_GOOGLE_DRIVE_PORT til en annen port og legg den URI-en inn i OAuth-klienten.`
        : `Kunne ikke lytte på 127.0.0.1:${port}: ${error?.message ?? error}`;
    settle(rejectResult, Object.assign(new Error(message), { code: 'PORT' }));
  });

  timer = setTimeout(() => {
    settle(
      rejectResult,
      Object.assign(
        new Error(`Ventet i ${Math.round(timeoutMs / 1000)} sekunder på godkjenning uten svar. Kjør /drive koble på nytt.`),
        { code: 'TIMEOUT' },
      ),
    );
  }, timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();

  server.listen(port, '127.0.0.1');

  return handle;
}

/**
 * Open a URL in the user's default browser, not in the Harness window.
 *
 * `cmd /c start` is deliberately avoided: Node does not quote an argument just
 * because it contains `&`, and cmd then splits the authorization URL at its
 * first query separator. Google receives a URL without `response_type` and
 * answers `invalid_request`. `explorer.exe` takes the URL as one opaque
 * argument, so nothing in it is interpreted by a shell.
 */
export function openBrowser(url) {
  const target = String(url ?? '');
  if (target === '') return false;

  if (process.platform === 'win32') {
    try {
      const child = spawn('explorer.exe', [target], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      return true;
    } catch {
      // Fall through to the quoted cmd form below.
    }
    try {
      const child = spawn('cmd', ['/c', 'start', '', `"${target.replace(/"/g, '')}"`], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      return true;
    } catch {
      return false;
    }
  }

  try {
    const child = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [target], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function postForm(url, form, fetchImpl) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { error: 'invalid_response', error_description: text.slice(0, 500) };
  }
  return { ok: response.ok, status: response.status, payload };
}

function tokenResult(payload, fallbackRefresh) {
  const expiresIn = Number(payload?.expires_in);
  return {
    accessToken: String(payload?.access_token ?? ''),
    refreshToken: String(payload?.refresh_token ?? fallbackRefresh ?? ''),
    expiresAt: Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000,
    scope: String(payload?.scope ?? ''),
  };
}

/**
 * Exchange the authorization code for tokens.
 *
 * `client_secret` is optional for installed applications, which is why the
 * plugin can work with only a Client ID. It is still sent when the user supplied
 * one, because some Google Cloud client configurations require it.
 */
export async function exchangeCode(input) {
  const fetchImpl = input.fetchImpl ?? fetch;
  const form = new URLSearchParams({
    client_id: String(input.clientId ?? ''),
    code: String(input.code ?? ''),
    code_verifier: String(input.verifier ?? ''),
    grant_type: 'authorization_code',
    redirect_uri: String(input.redirectUri ?? ''),
  });
  if (input.clientSecret) form.set('client_secret', String(input.clientSecret));

  const { ok, status, payload } = await postForm(TOKEN_ENDPOINT, form, fetchImpl);
  if (!ok || !payload?.access_token) {
    const error = Object.assign(
      new Error(
        `Google godtok ikke innloggingen (${status}): ` +
          `${payload?.error ?? 'ukjent feil'}${payload?.error_description ? ` – ${payload.error_description}` : ''}. ` +
          (payload?.error === 'redirect_uri_mismatch'
            ? 'Legg til http://127.0.0.1:45813/oauth2callback i OAuth-klienten.'
            : 'Sjekk Client ID (og eventuell secret), og prøv /drive koble på nytt.'),
      ),
      { code: 'TOKEN', status, payload },
    );
    throw error;
  }
  return tokenResult(payload);
}

/** Refresh an access token from the stored refresh token. */
export async function refreshAccessToken(input) {
  const fetchImpl = input.fetchImpl ?? fetch;
  const form = new URLSearchParams({
    client_id: String(input.clientId ?? ''),
    refresh_token: String(input.refreshToken ?? ''),
    grant_type: 'refresh_token',
  });
  if (input.clientSecret) form.set('client_secret', String(input.clientSecret));

  const { ok, status, payload } = await postForm(TOKEN_ENDPOINT, form, fetchImpl);
  if (!ok || !payload?.access_token) {
    const invalid = payload?.error === 'invalid_grant';
    const error = Object.assign(
      new Error(
        invalid
          ? 'Refresh-tokenet er ikke lenger gyldig. Kjør /drive koble på nytt. ' +
            '(En OAuth-app som står i «Testing» gir refresh-tokens som utløper etter 7 dager; ' +
            'publiser appen til «In production» for varig tilgang.)'
          : `Kunne ikke fornye Google-tilgangen (${status}): ${payload?.error ?? 'ukjent feil'}.`,
      ),
      { code: invalid ? 'INVALID_GRANT' : 'REFRESH', status, payload },
    );
    throw error;
  }
  return tokenResult(payload, input.refreshToken);
}

/** Revoke the grant at Google, so "frakoble" also removes the consent. */
export async function revokeToken(token, fetchImpl = fetch) {
  if (!token) return false;
  try {
    const response = await fetchImpl(`${REVOKE_ENDPOINT}?token=${encodeURIComponent(String(token))}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    return response.ok;
  } catch {
    return false;
  }
}
