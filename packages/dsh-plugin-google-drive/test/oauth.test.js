import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  base64url,
  buildAuthUrl,
  createPkce,
  exchangeCode,
  loopbackRedirectUri,
  parseClientJson,
  randomState,
  refreshAccessToken,
  revokeToken,
  startCallbackServer,
} from '../oauth.js';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('the downloaded client JSON is accepted in every shape Google emits', () => {
  const installed = parseClientJson(
    JSON.stringify({
      installed: {
        client_id: 'abc.apps.googleusercontent.com',
        client_secret: 'secret-value',
        redirect_uris: ['http://localhost'],
      },
    }),
  );
  assert.equal(installed.clientId, 'abc.apps.googleusercontent.com');
  assert.equal(installed.clientSecret, 'secret-value');

  const web = parseClientJson(
    JSON.stringify({ web: { client_id: 'web-id', client_secret: 'web-secret' } }),
  );
  assert.equal(web.clientId, 'web-id');
  assert.equal(web.clientSecret, 'web-secret');

  const bare = parseClientJson(JSON.stringify({ client_id: 'bare-id' }));
  assert.equal(bare.clientId, 'bare-id');
  assert.equal(bare.clientSecret, '');

  assert.throws(() => parseClientJson('ikke json'), (error) => error.code === 'KLIENTFIL');
  assert.throws(
    () => parseClientJson(JSON.stringify({ installed: {} })),
    (error) => error.code === 'KLIENTFIL' && /client_id/.test(error.message),
  );
});

test('PKCE verifier and challenge follow RFC 7636', () => {
  const { verifier, challenge } = createPkce();
  assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/);
  const expected = base64url(createHash('sha256').update(verifier).digest());
  assert.equal(challenge, expected);
  assert.notEqual(createPkce().verifier, verifier);
});

test('state is unguessable and URL-safe', () => {
  const state = randomState();
  assert.match(state, /^[A-Za-z0-9_-]{20,}$/);
  assert.notEqual(randomState(), state);
});

test('auth URL carries the loopback redirect, PKCE and offline access', () => {
  const url = new URL(
    buildAuthUrl({
      clientId: 'client.apps.googleusercontent.com',
      redirectUri: loopbackRedirectUri(45813),
      challenge: 'challenge-value',
      state: 'state-value',
    }),
  );
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('client_id'), 'client.apps.googleusercontent.com');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:45813/oauth2callback');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), 'challenge-value');
  assert.equal(url.searchParams.get('state'), 'state-value');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(
    url.searchParams.get('scope'),
    'https://www.googleapis.com/auth/drive.file',
  );
  assert.equal(loopbackRedirectUri(), 'http://127.0.0.1:45813/oauth2callback');
});

test('code exchange sends the verifier and keeps the refresh token', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return jsonResponse({
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      expires_in: 3600,
      scope: 'https://www.googleapis.com/auth/drive.file',
    });
  };

  const tokens = await exchangeCode({
    clientId: 'client',
    code: 'the-code',
    verifier: 'the-verifier',
    redirectUri: 'http://127.0.0.1:45813/oauth2callback',
    fetchImpl,
  });

  assert.equal(calls.length, 1);
  const body = new URLSearchParams(calls[0].init.body);
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('code'), 'the-code');
  assert.equal(body.get('code_verifier'), 'the-verifier');
  assert.equal(body.get('redirect_uri'), 'http://127.0.0.1:45813/oauth2callback');
  assert.equal(body.get('client_id'), 'client');
  assert.equal(body.get('client_secret'), null);
  assert.equal(tokens.accessToken, 'access-1');
  assert.equal(tokens.refreshToken, 'refresh-1');
  assert.ok(tokens.expiresAt > Date.now());
});

test('a redirect_uri_mismatch explains the exact fix', async () => {
  const fetchImpl = async () =>
    jsonResponse({ error: 'redirect_uri_mismatch', error_description: 'Bad Request' }, 400);

  await assert.rejects(
    exchangeCode({
      clientId: 'client',
      code: 'code',
      verifier: 'verifier',
      redirectUri: 'http://127.0.0.1:45813/oauth2callback',
      fetchImpl,
    }),
    (error) => {
      assert.equal(error.code, 'TOKEN');
      assert.match(error.message, /redirect_uri_mismatch/);
      assert.match(error.message, /127\.0\.0\.1:45813\/oauth2callback/);
      return true;
    },
  );
});

test('refresh keeps the previous refresh token when Google omits it', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return jsonResponse({ access_token: 'access-2', expires_in: 1800 });
  };

  const tokens = await refreshAccessToken({
    clientId: 'client',
    refreshToken: 'refresh-1',
    fetchImpl,
  });

  const body = new URLSearchParams(calls[0].init.body);
  assert.equal(body.get('grant_type'), 'refresh_token');
  assert.equal(body.get('refresh_token'), 'refresh-1');
  assert.equal(tokens.accessToken, 'access-2');
  assert.equal(tokens.refreshToken, 'refresh-1');
});

test('invalid_grant asks for a new sign-in and names the testing-mode cause', async () => {
  const fetchImpl = async () => jsonResponse({ error: 'invalid_grant' }, 400);
  await assert.rejects(
    refreshAccessToken({ clientId: 'client', refreshToken: 'old', fetchImpl }),
    (error) => {
      assert.equal(error.code, 'INVALID_GRANT');
      assert.match(error.message, /\/drive koble/);
      assert.match(error.message, /7 dager/);
      return true;
    },
  );
});

test('the loopback listener accepts the callback and returns the code', async () => {
  const server = startCallbackServer({ port: 0, state: 'the-state', timeoutMs: 5000 });
  server.result.catch(() => {});
  try {
    await server.ready;
    assert.ok(server.port > 0);

    const response = await fetch(
      `http://127.0.0.1:${server.port}/oauth2callback?code=returned-code&state=the-state`,
    );
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Ferdig/);
    assert.equal(await server.result, 'returned-code');
  } finally {
    server.close();
  }
});

test('a callback with the wrong state is refused', async () => {
  const server = startCallbackServer({ port: 0, state: 'right', timeoutMs: 5000 });
  server.result.catch(() => {});
  try {
    await server.ready;
    const response = await fetch(`http://127.0.0.1:${server.port}/oauth2callback?code=x&state=wrong`);
    assert.equal(response.status, 400);
    await assert.rejects(server.result, (error) => error.code === 'STATE');
  } finally {
    server.close();
  }
});

test('a denied consent becomes an explained cancellation', async () => {
  const server = startCallbackServer({ port: 0, state: 's', timeoutMs: 5000 });
  server.result.catch(() => {});
  try {
    await server.ready;
    const response = await fetch(`http://127.0.0.1:${server.port}/oauth2callback?error=access_denied&state=s`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /avbrutt/i);
    await assert.rejects(server.result, (error) => error.code === 'AVBRUTT');
  } finally {
    server.close();
  }
});

test('waiting too long ends with a timeout a person can act on', async () => {
  const server = startCallbackServer({ port: 0, state: 's', timeoutMs: 40 });
  server.result.catch(() => {});
  try {
    await server.ready;
    await assert.rejects(server.result, (error) => {
      assert.equal(error.code, 'TIMEOUT');
      assert.match(error.message, /\/drive koble/);
      return true;
    });
  } finally {
    server.close();
  }
});

test('revoke reports success or failure without throwing', async () => {
  const ok = await revokeToken('token', async () => new Response('', { status: 200 }));
  assert.equal(ok, true);
  const failed = await revokeToken('token', async () => {
    throw new Error('offline');
  });
  assert.equal(failed, false);
  assert.equal(await revokeToken(''), false);
});
