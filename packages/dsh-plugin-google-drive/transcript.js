/**
 * The transcript half of a backup: one Session log becomes one Markdown file.
 *
 * The point is that a project saved to Google Disk can be understood without
 * the Harness UI. What a person needs is the conversation, the tools that ran,
 * and what they answered — not the request headers, token accounting, or the
 * reasoning stream, which are large, noisy, and irrelevant months later.
 *
 * This module is pure: it takes a `SessionLogSnapshot`-shaped object
 * (`{ session, events }`), the optional title snapshot, and returns Markdown.
 * Nothing here reads the filesystem or the network.
 */

import {
  MAX_TOOL_TEXT,
  MAX_TRANSCRIPT_BYTES,
  isoDay,
  redactSecrets,
  slugify,
  truncate,
} from './logic.js';

/** Render one content block; reasoning is deliberately omitted. */
export function blockText(block) {
  switch (block?.type) {
    case 'text':
      return String(block.text ?? '');
    case 'image': {
      const name = block.attachment?.name ?? block.attachment?.mediaType ?? 'uten navn';
      return `[bilde: ${name}]`;
    }
    case 'file': {
      const name = block.attachment?.name ?? 'uten navn';
      const bytes = Number(block.attachment?.bytes ?? 0);
      return `[fil: ${name}${bytes > 0 ? `, ${bytes} byte` : ''}]`;
    }
    case 'tool-call': {
      const args = truncate(String(block.arguments ?? '').trim(), MAX_TOOL_TEXT);
      return `\`\`\`json\n${args === '' ? '{}' : args}\n\`\`\``;
    }
    default:
      return '';
  }
}

/**
 * Concatenate the readable blocks of one message.
 *
 * `includeToolCalls: false` is used for assistant messages and tool results:
 * the session log also carries each call as its own `tool/call` event, and a
 * transcript that printed both would show every command twice.
 */
export function messageText(message, options = {}) {
  const includeToolCalls = options.includeToolCalls !== false;
  const content = message?.content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (block?.type === 'tool-call' && !includeToolCalls ? '' : blockText(block)))
      .filter((text) => text !== '')
      .join('\n\n');
  }
  if (typeof message?.text === 'string') return message.text;
  return '';
}

/**
 * The session log stores injected context — the runtime snapshot, the time
 * stamp, the skill catalog, goal-round instructions — as `user/message` events
 * too. They are not messages a person wrote, and copying them into a backup
 * would bury the conversation under prompt plumbing.
 */
export function isHumanUserMessage(data) {
  const kind = data?.source?.kind;
  return kind === undefined || kind === 'user';
}

/** A short, human label for a tool call's result. */
function toolNameFor(callNames, message) {
  const callId = message?.toolCallId ?? message?.source?.callId;
  return callNames.get(String(callId ?? '')) ?? 'verktøy';
}

/**
 * Fold one session into Markdown.
 *
 * Every branch tolerates a missing field: older and newer session formats both
 * reach this function, and a transcript that renders slightly less detail is far
 * better than a backup that fails because one event shape changed.
 */
export function sessionToMarkdown(snapshot, title, options = {}) {
  const header = snapshot?.session ?? snapshot?.header ?? {};
  const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
  const now = options.now instanceof Date ? options.now : new Date();
  const projectPath = String(header?.cwd ?? options.projectPath ?? '');
  const sessionTitle = String(title?.title ?? '').trim();
  const created = new Date(Number(header?.createdAt ?? now.getTime()));

  const lines = [];
  lines.push(`# ${redactSecrets(sessionTitle === '' ? 'Samtale uten tittel' : sessionTitle)}`);
  lines.push('');
  lines.push('| | |');
  lines.push('| --- | --- |');
  lines.push(`| Prosjekt | \`${projectPath.replace(/\|/g, '\\|')}\` |`);
  lines.push(`| Økt | \`${String(header?.id ?? 'ukjent')}\` |`);
  lines.push(`| Opprettet | ${created.toISOString()} |`);
  lines.push(`| Eksportert | ${now.toISOString()} |`);
  if (title?.source?.kind) lines.push(`| Tittel fra | ${title.source.kind} |`);
  lines.push('');

  const callNames = new Map();
  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;

  for (const event of events) {
    const data = event?.data ?? {};

    switch (event?.type) {
      case 'user/message': {
        if (!isHumanUserMessage(data)) {
          if (data?.source?.kind === 'goal-round') {
            lines.push('> **Automatisk målrunde** (systemgenerert instruks, ikke gengitt i sin helhet).');
            lines.push('');
          }
          break;
        }
        const text = messageText(data.message ?? data);
        if (text.trim() === '') break;
        userMessages += 1;
        lines.push('## Bruker');
        lines.push('');
        lines.push(redactSecrets(text).trim());
        lines.push('');
        break;
      }

      case 'assistant/message': {
        const text = messageText(data.message ?? data, { includeToolCalls: false });
        if (text.trim() === '') break;
        assistantMessages += 1;
        lines.push('## Assistent');
        lines.push('');
        lines.push(redactSecrets(text).trim());
        if (data?.interrupted === true) {
          lines.push('');
          lines.push('_(svaret ble avbrutt)_');
        }
        lines.push('');
        break;
      }

      case 'tool/call': {
        toolCalls += 1;
        const name = String(data?.name ?? 'verktøy');
        callNames.set(String(data?.callId ?? ''), name);
        const args = truncate(redactSecrets(String(data?.arguments ?? '')), MAX_TOOL_TEXT);
        lines.push(`> **Verktøy:** \`${name}\``);
        if (args.trim() !== '') {
          lines.push('>');
          for (const line of args.split(/\r?\n/)) lines.push(`> ${line}`);
        }
        lines.push('');
        break;
      }

      case 'tool/result': {
        const message = data?.message ?? {};
        const name = toolNameFor(callNames, message);
        const text = truncate(redactSecrets(messageText(message, { includeToolCalls: false })), MAX_TOOL_TEXT);
        const label = data?.error ? `**Verktøysvar (feil):** \`${name}\`` : `**Verktøysvar:** \`${name}\``;
        lines.push(`> ${label}`);
        if (text.trim() !== '') {
          lines.push('>');
          for (const line of text.split(/\r?\n/)) lines.push(`> ${line}`);
        }
        lines.push('');
        break;
      }

      case 'turn/error': {
        const failure = data?.error ?? data?.failure ?? {};
        const message = String(failure?.message ?? '').trim();
        lines.push(`> **Feil i runden:** ${redactSecrets(message === '' ? 'ukjent feil' : message)}`);
        lines.push('');
        break;
      }

      case 'turn/max-tokens': {
        lines.push('> **Merk:** runden stoppet fordi modellen nådde token-grensen.');
        lines.push('');
        break;
      }

      default:
        break;
    }
  }

  if (userMessages === 0 && assistantMessages === 0) {
    lines.push('_Samtalen inneholder ingen bruker- eller assistentmeldinger i denne loggen._');
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push(
    `**Oppsummering:** ${userMessages} brukermelding(er), ${assistantMessages} assistentsvar, ` +
      `${toolCalls} verktøykall, ${events.length} hendelser totalt.`,
  );
  lines.push('');
  lines.push('_Eksportert av dsh-plugin-google-drive. Reasoning-strøm og systemprompt er utelatt; verktøysvar er avkortet._');
  lines.push('');

  let markdown = lines.join('\n');
  if (markdown.length > MAX_TRANSCRIPT_BYTES) {
    markdown = `${markdown.slice(0, MAX_TRANSCRIPT_BYTES)}\n\n… (samtalen er avkortet ved grensen på ${MAX_TRANSCRIPT_BYTES} tegn)\n`;
  }
  return { markdown, userMessages, assistantMessages, toolCalls, events: events.length };
}

/** File name inside the archive for one transcript. */
export function transcriptFileName(header, title, date = new Date()) {
  const created = Number(header?.createdAt);
  const stampDate = Number.isFinite(created) && created > 0 ? new Date(created) : date;
  const slug = slugify(String(title?.title ?? '').trim() === '' ? 'samtale' : String(title.title));
  const shortId = String(header?.id ?? '')
    .replace(/^session-/, '')
    .slice(0, 8);
  return `DSH-samtaler/${isoDay(stampDate)}-${slug}-${shortId}.md`;
}

/**
 * Build the transcript entries for a whole project: one file per session plus
 * an index. Sessions arrive newest first from the query service; the index keeps
 * that order so the most recent conversation is the first row.
 */
export function buildTranscripts(sessions, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const extras = [];
  const index = [];
  const failures = [];

  for (const entry of Array.isArray(sessions) ? sessions : []) {
    const snapshot = entry?.snapshot;
    if (!snapshot) {
      failures.push({ sessionId: String(entry?.id ?? 'ukjent'), reason: String(entry?.error ?? 'kunne ikke leses') });
      continue;
    }
    const header = snapshot.session ?? snapshot.header ?? {};
    const title = entry?.title;
    let built;
    try {
      built = sessionToMarkdown(snapshot, title, { now, projectPath: options.projectPath });
    } catch (error) {
      failures.push({ sessionId: String(header?.id ?? entry?.id ?? 'ukjent'), reason: String(error?.message ?? error) });
      continue;
    }
    const fileName = transcriptFileName(header, title, now);
    extras.push({ name: fileName, data: built.markdown });
    index.push({
      file: fileName,
      title: String(title?.title ?? '').trim() === '' ? 'Samtale uten tittel' : String(title.title),
      sessionId: String(header?.id ?? ''),
      createdAt: new Date(Number(header?.createdAt ?? now.getTime())).toISOString(),
      userMessages: built.userMessages,
      assistantMessages: built.assistantMessages,
      toolCalls: built.toolCalls,
    });
  }

  if (index.length > 0) {
    const lines = ['# DSH-samtaler', '', 'Sortert nyeste først.', '', '| Dato | Samtale | Meldinger | Fil |', '| --- | --- | --- | --- |'];
    for (const row of index) {
      const day = row.createdAt.slice(0, 10);
      const messages = `${row.userMessages} / ${row.assistantMessages}`;
      lines.push(`| ${day} | ${row.title.replace(/\|/g, '\\|')} | ${messages} | \`${row.file.replace('DSH-samtaler/', '')}\` |`);
    }
    lines.push('');
    extras.push({ name: 'DSH-samtaler/oversikt.md', data: lines.join('\n') });
  }

  return { extras, index, failures };
}

/** The archive manifest: what was saved, when, and what was left out. */
export function buildManifest(input) {
  const payload = {
    plugin: 'dsh-plugin-google-drive',
    version: String(input?.version ?? 'ukjent'),
    lagret: String(input?.savedAt ?? new Date().toISOString()),
    prosjekt: {
      navn: String(input?.projectTitle ?? ''),
      sti: String(input?.projectPath ?? ''),
    },
    innhold: {
      filer: Number(input?.fileCount ?? 0),
      bytesFoerKomprimering: Number(input?.uncompressed ?? 0),
    },
    samtaler: {
      antall: Number(input?.transcriptCount ?? 0),
      filer: Array.isArray(input?.transcripts) ? input.transcripts : [],
      feil: Array.isArray(input?.transcriptFailures) ? input.transcriptFailures : [],
    },
    utelatt: Array.isArray(input?.skipped)
      ? input.skipped.slice(0, 2000).map((item) => ({ sti: String(item?.path ?? ''), grunn: String(item?.reason ?? '') }))
      : [],
    utelatteAntall: Array.isArray(input?.skipped) ? input.skipped.length : 0,
    ekskluderinger: Array.isArray(input?.excludes) ? input.excludes : [],
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}
