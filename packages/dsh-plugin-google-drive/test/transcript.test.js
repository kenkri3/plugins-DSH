import assert from 'node:assert/strict';
import test from 'node:test';

import {
  blockText,
  buildManifest,
  buildTranscripts,
  isHumanUserMessage,
  messageText,
  sessionToMarkdown,
  transcriptFileName,
} from '../transcript.js';

const HEADER = {
  id: 'session-abc12345-0000-0000-0000-000000000000',
  createdAt: Date.UTC(2026, 9, 17, 7, 5),
  cwd: 'C:\\Users\\glosl\\prosjekt',
  agentPreset: 'standard',
};

const EVENTS = [
  {
    type: 'user/message',
    seq: 1,
    time: 1,
    data: { message: { role: 'user', content: [{ type: 'text', text: 'Lag en forside med hero.' }] } },
  },
  {
    type: 'assistant/message',
    seq: 2,
    time: 2,
    data: {
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'Skjult resonnement som ikke skal med.' },
          { type: 'text', text: 'Jeg lager heroen og bruker nøkkelen sk-abcdefghijklmnopqrstuvwxyz012345 i testen.' },
        ],
      },
      usage: { inputTokens: 10, outputTokens: 20 },
    },
  },
  { type: 'tool/call', seq: 3, time: 3, data: { callId: 'c1', name: 'read', arguments: '{"file_path":"README.md"}' } },
  {
    type: 'tool/result',
    seq: 4,
    time: 4,
    data: {
      message: {
        role: 'tool',
        toolCallId: 'c1',
        content: [{ type: 'text', text: '# README\n\nProsjektbeskrivelse.' }],
      },
    },
  },
  { type: 'request/header', seq: 5, time: 5, data: { header: { config: { provider: 'x', model: 'y' } }, reason: 'initial' } },
  { type: 'turn/error', seq: 6, time: 6, data: { error: { message: 'Nettverket sviktet', code: 'NET' } } },
  { type: 'turn/max-tokens', seq: 7, time: 7, data: {} },
];

test('blockText renders text, attachments and omits reasoning', () => {
  assert.equal(blockText({ type: 'text', text: 'hei' }), 'hei');
  assert.equal(blockText({ type: 'reasoning', text: 'skjult' }), '');
  assert.equal(blockText({ type: 'image', attachment: { name: 'skjerm.png' } }), '[bilde: skjerm.png]');
  assert.equal(blockText({ type: 'file', attachment: { name: 'a.pdf', bytes: 10 } }), '[fil: a.pdf, 10 byte]');
  assert.match(blockText({ type: 'tool-call', arguments: '{"a":1}' }), /```json/);
  assert.equal(blockText(null), '');
  assert.equal(blockText({ type: 'ukjent' }), '');
});

test('messageText joins readable blocks and can drop duplicated tool calls', () => {
  assert.equal(
    messageText({ content: [{ type: 'text', text: 'a' }, { type: 'reasoning', text: 'b' }, { type: 'text', text: 'c' }] }),
    'a\n\nc',
  );
  assert.equal(
    messageText(
      { content: [{ type: 'text', text: 'a' }, { type: 'tool-call', arguments: '{"x":1}' }] },
      { includeToolCalls: false },
    ),
    'a',
  );
  assert.equal(messageText({ text: 'bare tekst' }), 'bare tekst');
  assert.equal(messageText({}), '');
});

test('injected session context is not a user message', () => {
  assert.equal(isHumanUserMessage({ source: { kind: 'user' } }), true);
  assert.equal(isHumanUserMessage({}), true);
  assert.equal(isHumanUserMessage({ source: { kind: 'runtime-context' } }), false);
  assert.equal(isHumanUserMessage({ source: { kind: 'system-reminder' } }), false);
  assert.equal(isHumanUserMessage({ source: { kind: 'time-context' } }), false);
  assert.equal(isHumanUserMessage({ source: { kind: 'goal-round' } }), false);
});

test('runtime context is skipped and a goal round is noted, not quoted', () => {
  const events = [
    {
      type: 'user/message',
      seq: 1,
      data: { role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'RUNTIME-SNAPSHOT-TEKST' }] },
    },
    {
      type: 'user/message',
      seq: 2,
      data: { role: 'user', source: { kind: 'system-reminder' }, content: [{ type: 'text', text: 'SYSTEM-REMINDER-TEKST' }] },
    },
    {
      type: 'user/message',
      seq: 3,
      data: { role: 'user', source: { kind: 'goal-round' }, content: [{ type: 'text', text: 'MÅLRUNDE-TEKST' }] },
    },
    {
      type: 'user/message',
      seq: 4,
      data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Ekte melding fra meg.' }] },
    },
  ];

  const { markdown, userMessages } = sessionToMarkdown({ session: HEADER, events }, { title: 'Test' });
  assert.equal(userMessages, 1);
  assert.match(markdown, /Ekte melding fra meg\./);
  assert.equal(markdown.includes('RUNTIME-SNAPSHOT-TEKST'), false);
  assert.equal(markdown.includes('SYSTEM-REMINDER-TEKST'), false);
  assert.equal(markdown.includes('MÅLRUNDE-TEKST'), false);
  assert.match(markdown, /Automatisk målrunde/);
});

test('sessionToMarkdown includes the conversation, the tools and the failure', () => {
  const { markdown, userMessages, assistantMessages, toolCalls } = sessionToMarkdown(
    { session: HEADER, events: EVENTS },
    { title: 'Forside med hero' },
    { now: new Date(Date.UTC(2026, 9, 17, 8, 0)) },
  );

  assert.match(markdown, /^# Forside med hero/);
  assert.match(markdown, /## Bruker/);
  assert.match(markdown, /Lag en forside med hero\./);
  assert.match(markdown, /## Assistent/);
  assert.match(markdown, /Jeg lager heroen/);
  assert.match(markdown, /Verktøy:\*\* `read`/);
  assert.match(markdown, /Verktøysvar:\*\* `read`/);
  assert.match(markdown, /# README/);
  assert.match(markdown, /Feil i runden/);
  assert.match(markdown, /token-grensen/);
  assert.match(markdown, /\| Prosjekt \| `C:\\Users\\glosl\\prosjekt` \|/);
  assert.equal(markdown.includes('Skjult resonnement'), false);
  assert.equal(markdown.includes('abcdefghijklmnopqrstuvwxyz012345'), false);
  assert.match(markdown, /sk-\*\*\*/);
  assert.equal(userMessages, 1);
  assert.equal(assistantMessages, 1);
  assert.equal(toolCalls, 1);
});

test('sessionToMarkdown survives an empty or unknown log', () => {
  const { markdown } = sessionToMarkdown({ session: { id: 'session-tom' }, events: [{ type: 'ukjent/hendelse' }] }, undefined);
  assert.match(markdown, /Samtale uten tittel/);
  assert.match(markdown, /ingen bruker- eller assistentmeldinger/);
  assert.equal(sessionToMarkdown({}).markdown.includes('# Samtale uten tittel'), true);
});

test('transcriptFileName is stable and avoids Norwegian characters', () => {
  const name = transcriptFileName(HEADER, { title: 'Første samtale' }, new Date(Date.UTC(2026, 9, 17)));
  assert.equal(name, 'DSH-samtaler/2026-10-17-forste-samtale-abc12345.md');
  const fallback = transcriptFileName({ id: 'session-x' }, undefined, new Date(Date.UTC(2026, 9, 17)));
  assert.equal(fallback, 'DSH-samtaler/2026-10-17-samtale-x.md');
});

test('buildTranscripts produces one file per session plus an index', () => {
  const sessions = [
    { id: HEADER.id, snapshot: { session: HEADER, events: EVENTS }, title: { title: 'Første samtale' } },
    {
      id: 'session-def67890',
      snapshot: { session: { ...HEADER, id: 'session-def67890', createdAt: Date.UTC(2026, 9, 16) }, events: EVENTS.slice(0, 2) },
      title: undefined,
    },
  ];

  const { extras, index, failures } = buildTranscripts(sessions, { now: new Date(Date.UTC(2026, 9, 17)) });
  assert.equal(failures.length, 0);
  assert.equal(index.length, 2);
  const names = extras.map((entry) => entry.name);
  assert.ok(names.includes('DSH-samtaler/oversikt.md'));
  assert.ok(names.some((name) => name.startsWith('DSH-samtaler/2026-10-17-forste-samtale-')));
  assert.ok(names.some((name) => name.startsWith('DSH-samtaler/2026-10-16-samtale-')));

  const oversikt = extras.find((entry) => entry.name === 'DSH-samtaler/oversikt.md');
  assert.match(oversikt.data, /Første samtale/);
  assert.match(oversikt.data, /# DSH-samtaler/);
});

test('buildTranscripts records unreadable sessions instead of failing', () => {
  const { extras, index, failures } = buildTranscripts([{ id: 'session-ødelagt', error: 'kunne ikke leses' }], {});
  assert.equal(index.length, 0);
  assert.equal(extras.length, 0);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].sessionId, 'session-ødelagt');
});

test('buildManifest is valid JSON carrying the save facts', () => {
  const text = buildManifest({
    version: '0.1.0',
    savedAt: '2026-10-17T09:05:00.000Z',
    projectTitle: 'Vikingpilot',
    projectPath: 'G:\\Min disk\\GitHub\\Vikingpilot',
    fileCount: 42,
    uncompressed: 1024,
    transcriptCount: 2,
    transcripts: ['DSH-samtaler/a.md'],
    transcriptFailures: [],
    skipped: [{ path: 'node_modules', reason: 'ekskludert' }],
    excludes: ['node_modules'],
  });
  const parsed = JSON.parse(text);
  assert.equal(parsed.plugin, 'dsh-plugin-google-drive');
  assert.equal(parsed.prosjekt.navn, 'Vikingpilot');
  assert.equal(parsed.innhold.filer, 42);
  assert.equal(parsed.samtaler.antall, 2);
  assert.equal(parsed.utelatteAntall, 1);
  assert.deepEqual(parsed.utelatt, [{ sti: 'node_modules', grunn: 'ekskludert' }]);
});
