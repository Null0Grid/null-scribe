'use strict';

/**
 * Summary templates: the sections the AI writes. Built-ins plus the user's own (stored in settings).
 *
 * A template's `format` is appended to the final summary request. Custom templates hold the user's
 * own instructions, which are wrapped so the model still returns clean Markdown.
 */

const TAIL = 'Write "None" under any heading that has nothing. Output only the Markdown, no preamble.';

const BUILTIN = [
  {
    id: 'meeting',
    name: 'Meeting',
    format: `Write the summary in Markdown with exactly these sections:

## Overview
2–4 sentences: what the conversation was about and how it ended.

## Key points
Bullet list of the important points, each with its [mm:ss] timestamp when known.

## Decisions
Bullet list of anything agreed or decided.

## Action items
Checklist lines like "- [ ] Who — what (by when, if said)". Use "Unassigned" when no owner was named.

## Open questions
Bullet list of unresolved questions or follow-ups.

${TAIL}`,
  },
  {
    id: 'lecture',
    name: 'Lecture / class',
    format: `Write study notes in Markdown with exactly these sections:

## Overview
2–3 sentences: the subject of the lecture and what it covered.

## Main topics
Bullet list of the topics in the order they were taught, each with its [mm:ss] timestamp when known.

## Key concepts and definitions
Bullet list of "**Term** — explanation" lines, using the speaker's own explanations.

## Examples
Bullet list of the examples, demonstrations or worked problems that were given.

## To review
Bullet list of anything the speaker stressed, said would be on a test, or assigned as homework or reading.

${TAIL}`,
  },
  {
    id: 'interview',
    name: 'Interview',
    format: `Write the summary in Markdown with exactly these sections:

## Overview
2–3 sentences: who was interviewed (if said), about what, and the overall impression.

## Main answers
Bullet list of the main questions and the answer given to each, with [mm:ss] timestamps when known.

## Notable quotes
Up to 5 short quotes worth keeping, word for word from the transcript, each with its [mm:ss] timestamp.

## Follow-up questions
Bullet list of things that were left unclear or worth asking next time.

${TAIL}`,
  },
  {
    id: 'standup',
    name: 'Stand-up',
    format: `Write a stand-up summary in Markdown with exactly these sections:

## Done
Bullet list of what each person finished, as "Who — what".

## Doing
Bullet list of what each person is working on next, as "Who — what".

## Blocked
Bullet list of blockers, as "Who — what is blocking them".

## Action items
Checklist lines like "- [ ] Who — what (by when, if said)".

${TAIL}`,
  },
  {
    id: 'one-on-one',
    name: '1:1',
    format: `Write the summary of this one-on-one in Markdown with exactly these sections:

## Topics discussed
Bullet list of the topics, each with its [mm:ss] timestamp when known.

## Feedback
Bullet list of feedback given in either direction, as "From → to: feedback".

## Agreed next steps
Checklist lines like "- [ ] Who — what (by when, if said)".

## To bring up next time
Bullet list of things deferred to a later conversation.

${TAIL}`,
  },
];

const DEFAULT_TEMPLATE = 'meeting';
const MAX_CUSTOM = 50;

function cleanCustom(list) {
  const out = [];
  const seen = new Set(BUILTIN.map((t) => t.id));
  for (const t of Array.isArray(list) ? list : []) {
    const name = String(t?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const instructions = String(t?.instructions ?? '').trim().slice(0, 4000);
    let id = String(t?.id ?? '').trim();
    if (!name || !instructions) continue;
    if (!/^custom-[a-z0-9-]{1,40}$/.test(id) || seen.has(id)) id = `custom-${Date.now().toString(36)}-${out.length}`;
    seen.add(id);
    out.push({ id, name, instructions });
    if (out.length >= MAX_CUSTOM) break;
  }
  return out;
}

function customFormat(instructions) {
  return `Write the summary in Markdown, following these instructions from the user:

${instructions}

Use "## " headings for the sections. ${TAIL}`;
}

/** All templates for the UI: [{ id, name, builtin, instructions? }] */
function listTemplates(custom) {
  return [
    ...BUILTIN.map((t) => ({ id: t.id, name: t.name, builtin: true })),
    ...cleanCustom(custom).map((t) => ({ id: t.id, name: t.name, builtin: false, instructions: t.instructions })),
  ];
}

/** Resolve a template id to { id, name, format }. Unknown ids fall back to Meeting. */
function resolveTemplate(id, custom) {
  const b = BUILTIN.find((t) => t.id === id);
  if (b) return { id: b.id, name: b.name, format: b.format };
  const c = cleanCustom(custom).find((t) => t.id === id);
  if (c) return { id: c.id, name: c.name, format: customFormat(c.instructions) };
  const m = BUILTIN[0];
  return { id: m.id, name: m.name, format: m.format };
}

module.exports = { BUILTIN, DEFAULT_TEMPLATE, listTemplates, resolveTemplate, cleanCustom };
