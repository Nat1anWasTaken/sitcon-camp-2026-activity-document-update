import { readFile, writeFile } from 'node:fs/promises';

const HACKMD_API_BASE = process.env.HACKMD_API_BASE ?? 'https://api.hackmd.io/v1';
const HACKMD_TEAM_PATH = process.env.HACKMD_TEAM_PATH ?? 'SITCON';
const DEFAULT_HACKMD_FOLDER_REFERENCE = 'AR1yLLpMhRw7Z9yOz7o3T';
const DEFAULT_HACKMD_BOOK_NOTE_REFERENCE = '12lshlVaTGmaEG1RIKkuYw';
const README_PATH = process.env.README_PATH ?? 'README.md';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL ?? 'openai/gpt-4.1-mini';
const OPENROUTER_API_BASE = process.env.OPENROUTER_API_BASE ?? 'https://openrouter.ai/api/v1';
const OPENROUTER_SITE_URL = process.env.OPENROUTER_SITE_URL ?? process.env.GITHUB_SERVER_URL;
const OPENROUTER_APP_NAME = process.env.OPENROUTER_APP_NAME ?? process.env.GITHUB_REPOSITORY ?? 'hackmd-book-updater';

const dryRun = process.argv.includes('--dry-run');

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});

async function main() {
  requireEnv('HACKMD_API_TOKEN');

  const teamNotes = await listTeamNotes();
  const { folderId: HACKMD_FOLDER_ID, noteId: HACKMD_BOOK_NOTE_ID } = resolveConfiguredHackmdReferences(teamNotes);
  const bookNote = await getTeamNote(HACKMD_BOOK_NOTE_ID);

  const bookContent = ensureString(bookNote.content, `HackMD book note ${HACKMD_BOOK_NOTE_ID} has no content field`);
  const book = parseBook(bookContent);
  const existingIds = collectExistingHackmdIds(book);

  const folderNotes = teamNotes
    .filter((note) => note.id !== HACKMD_BOOK_NOTE_ID)
    .filter((note) => note.folderPaths?.some((folder) => folder.id === HACKMD_FOLDER_ID))
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));

  const missingNotes = folderNotes.filter((note) => !noteMatchIdentifiers(note).some((id) => existingIds.has(id)));

  console.log(`Found ${folderNotes.length} notes in folder ${HACKMD_FOLDER_ID}.`);
  console.log(`Found ${missingNotes.length} notes missing from book ${HACKMD_BOOK_NOTE_ID}.`);

  if (missingNotes.length === 0) {
    await syncReadme(bookContent);
    console.log('Book is already up to date.');
    return;
  }

  const detailedMissingNotes = await mapWithConcurrency(missingNotes, 4, async (note) => {
    const detail = await getTeamNote(note.id);
    const linkId = note.shortId ?? detail.shortId ?? note.id;
    return {
      id: note.id,
      shortId: linkId,
      title: note.title || detail.title || note.id,
      link: `/${linkId}`,
      description: note.description ?? '',
      tags: note.tags ?? [],
      createdAt: note.createdAt,
      lastChangedAt: note.lastChangedAt,
      excerpt: summarizeMarkdown(ensureString(detail.content ?? '', '')),
    };
  });

  const placements = await requestPlacements(book, detailedMissingNotes);
  const updatedContent = renderBook(applyPlacements(book, detailedMissingNotes, placements));

  if (updatedContent === bookContent) {
    await syncReadme(updatedContent);
    console.log('OpenRouter returned placements, but the rendered book did not change.');
    return;
  }

  if (dryRun) {
    console.log('Dry run enabled; not updating HackMD.');
    console.log(updatedContent);
    return;
  }

  await updateTeamNote(HACKMD_BOOK_NOTE_ID, updatedContent);
  await syncReadme(updatedContent);
  console.log(`Updated HackMD book note ${HACKMD_BOOK_NOTE_ID}.`);
}

function requireEnv(name) {
  if (!process.env[name]) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

function resolveConfiguredHackmdReferences(teamNotes) {
  const folderReference = process.env.HACKMD_FOLDER_URL ?? process.env.HACKMD_FOLDER_ID ?? DEFAULT_HACKMD_FOLDER_REFERENCE;
  const noteReference = process.env.HACKMD_BOOK_DOCS_URL ?? process.env.HACKMD_BOOK_NOTE_ID ?? DEFAULT_HACKMD_BOOK_NOTE_REFERENCE;

  return {
    folderId: resolveFolderReference(folderReference, teamNotes, 'HACKMD_FOLDER_URL/HACKMD_FOLDER_ID'),
    noteId: resolveNoteReference(noteReference, teamNotes, 'HACKMD_BOOK_DOCS_URL/HACKMD_BOOK_NOTE_ID'),
  };
}

function resolveFolderReference(reference, teamNotes, envName) {
  if (typeof reference !== 'string' || reference.trim() === '') {
    throw new Error(`Missing HackMD folder reference in ${envName}`);
  }

  const candidateIds = extractHackmdFolderCandidates(reference.trim());
  const folders = collectFolders(teamNotes);

  for (const candidateId of candidateIds) {
    const folder = folders.find((item) => item.id === candidateId || item.clientId === candidateId);
    if (folder) return folder.id;
  }

  throw new Error(`Unable to resolve a HackMD folder id from ${envName}: ${reference}`);
}

function resolveNoteReference(reference, teamNotes, envName) {
  if (typeof reference !== 'string' || reference.trim() === '') {
    throw new Error(`Missing HackMD note reference in ${envName}`);
  }

  const candidateIds = extractHackmdNoteCandidates(reference.trim());

  for (const candidateId of candidateIds) {
    const note = teamNotes.find((item) => noteIdentifiers(item).includes(candidateId) || noteAliasIdentifiers(item).includes(candidateId));
    if (note) return note.id;
  }

  throw new Error(`Unable to resolve a HackMD note id from ${envName}: ${reference}`);
}

async function hackmdFetch(path, options = {}) {
  const response = await fetch(`${HACKMD_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.HACKMD_API_TOKEN}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    throw new Error(`HackMD API ${options.method ?? 'GET'} ${path} failed: ${response.status} ${await response.text()}`);
  }

  if (response.status === 204) return null;

  const contentType = response.headers.get('content-type') ?? '';
  const body = await response.text();
  if (body.trim() === '') return null;

  if (contentType.includes('application/json')) {
    return JSON.parse(body);
  }

  return body;
}

function listTeamNotes() {
  return hackmdFetch(`/teams/${encodeURIComponent(HACKMD_TEAM_PATH)}/notes`);
}

function getTeamNote(noteId) {
  return hackmdFetch(`/teams/${encodeURIComponent(HACKMD_TEAM_PATH)}/notes/${encodeURIComponent(noteId)}`);
}

function updateTeamNote(noteId, content) {
  return hackmdFetch(`/teams/${encodeURIComponent(HACKMD_TEAM_PATH)}/notes/${encodeURIComponent(noteId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ content }),
  });
}

async function syncReadme(content) {
  if (dryRun) {
    console.log(`Dry run enabled; not updating ${README_PATH}.`);
    return;
  }

  const existing = await readFile(README_PATH, 'utf8').catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });

  if (existing === content) {
    console.log(`${README_PATH} already matches the HackMD book content.`);
    return;
  }

  await writeFile(README_PATH, content, 'utf8');
  console.log(`Updated ${README_PATH}.`);
}

function parseBook(content) {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const preface = [];
  const sections = [];
  let currentSection = null;

  for (const line of lines) {
    const heading = /^(#{2,6})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      currentSection = {
        level: heading[1].length,
        title: heading[2],
        items: [],
        otherLines: [],
      };
      sections.push(currentSection);
      continue;
    }

    const item = /^(\s*)-\s+\[([^\]]+)]\(([^)]+)\)\s*$/.exec(line);
    if (item && currentSection) {
      currentSection.items.push({
        indent: item[1],
        title: item[2],
        href: item[3],
        raw: line,
        noteId: extractHackmdNoteCandidates(item[3])[0] ?? null,
      });
      continue;
    }

    if (currentSection) {
      currentSection.otherLines.push(line);
    } else {
      preface.push(line);
    }
  }

  return { preface, sections };
}

function renderBook(book) {
  const lines = [...trimTrailingBlankLines(book.preface)];

  for (const section of book.sections) {
    if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
    lines.push(`${'#'.repeat(section.level)} ${section.title}`);
    lines.push('');

    for (const item of section.items) {
      lines.push(`${item.indent ?? ''}- [${item.title}](${item.href})`);
    }

    const otherLines = trimOuterBlankLines(section.otherLines);
    if (otherLines.length > 0) {
      if (section.items.length > 0) lines.push('');
      lines.push(...otherLines);
    }
  }

  return `${trimTrailingBlankLines(lines).join('\n')}\n`;
}

function collectExistingHackmdIds(book) {
  const ids = new Set();
  for (const section of book.sections) {
    for (const item of section.items) {
      for (const id of extractHackmdNoteCandidates(item.href)) {
        ids.add(id);
      }
    }
  }
  return ids;
}

function extractHackmdNoteCandidates(href) {
  try {
    const url = href.startsWith('http') ? new URL(href) : new URL(href, 'https://hackmd.io');
    if (url.hostname !== 'hackmd.io') return [];

    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length === 1 && !segments[0].startsWith('@')) return [decodeURIComponent(segments[0])];
    if (segments.length >= 2 && segments[0].startsWith('@')) return [decodeURIComponent(segments[1])];
    return [];
  } catch {
    return [];
  }
}

function extractHackmdFolderCandidates(href) {
  try {
    const url = href.startsWith('http') ? new URL(href) : new URL(href, 'https://hackmd.io');
    if (url.hostname !== 'hackmd.io') return [];
    const candidates = [];

    for (const paramName of ['folderId', 'folder_id', 'id']) {
      const param = url.searchParams.get(paramName);
      if (param) candidates.push(decodeURIComponent(param));
    }

    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length === 0) return candidates;
    const terminalMarkers = new Set(['edit', 'view', 'share']);
    const candidate = [...segments].reverse().find((segment) => {
      return !terminalMarkers.has(segment) && !['s', 'folder', 'folders'].includes(segment);
    });

    if (candidate) candidates.push(decodeURIComponent(candidate));
    return [...new Set(candidates)];
  } catch {
    return [];
  }
}

function collectFolders(teamNotes) {
  const folders = new Map();

  for (const note of teamNotes) {
    for (const folder of note.folderPaths ?? []) {
      if (!folder?.id) continue;
      folders.set(folder.id, folder);
    }
  }

  return [...folders.values()];
}

function summarizeMarkdown(markdown) {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/!\[[^\]]*]\([^)]+\)/g, ' ')
    .replace(/\[[^\]]+]\([^)]+\)/g, (match) => match.replace(/^\[|\]\([^)]+\)$/g, ''))
    .replace(/[#>*_`~\-[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1600);
}

async function requestPlacements(book, missingNotes) {
  requireEnv('OPENROUTER_API_KEY');

  const currentStructure = book.sections.map((section) => ({
    section: section.title,
    items: section.items.map((item) => ({
      title: item.title,
      id: item.noteId,
      href: item.href,
    })),
  }));

  const prompt = [
    'You update a HackMD book-mode table of contents for SITCON Camp 2026 activity-team documents.',
    'Book mode uses Markdown headings as sections and bullet links as pages.',
    'Place each missing HackMD note into the most appropriate existing section. Create a new section only when none of the existing sections fit.',
    'CRITICAL: Your output placements array MUST include an entry for EVERY note in the Missing notes list. The array length must match the number of missing notes exactly. Do not omit any.',
    'Keep meeting notes in chronological order when titles indicate meeting sequence. Keep long-lived references under 長期, recruiting under 招募, and broad discussion under 其他討論.',
    'For each missing note, also choose a concise hyperlink title for the book entry.',
    'The hyperlink title must be based on the original document title, and must still clearly refer to that original document.',
    'Match the naming style already used in the current book structure whenever possible.',
    'Trim broad ownership or project prefixes when they are redundant in the book context, such as "SITCON Camp 2026 課活組", but keep the specific identifying part of the title.',
    'Do not invent a new topic name that is not supported by the original title or note content.',
    'For placement.id, copy the exact value from each missing note\'s "id" field. Do not use shortId, publishLink ids, or URL segments for placement.id.',
    'Return only valid JSON with this exact shape:',
    '{"placements":[{"id":"note id","section":"section title","afterId":"existing or newly placed note id, or null to append to section","linkTitle":"hyperlink title to render in the book"}]}',
    '',
    `Current book structure:\n${JSON.stringify(currentStructure, null, 2)}`,
    '',
    `Missing notes:\n${JSON.stringify(missingNotes, null, 2)}`,
  ].join('\n');

  const headers = {
    Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    'Content-Type': 'application/json',
    ...(OPENROUTER_SITE_URL ? { 'HTTP-Referer': OPENROUTER_SITE_URL } : {}),
    ...(OPENROUTER_APP_NAME ? { 'X-Title': OPENROUTER_APP_NAME } : {}),
  };

  const systemMessage = {
    role: 'system',
    content: 'You classify markdown documents into a HackMD book-mode outline. You must place every single missing note provided. Return strict JSON only.',
  };

  const MAX_ROUNDS = 10;
  let lastError;
  const feedbacks = [];

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    let userContent = prompt;
    if (feedbacks.length > 0) {
      userContent = prompt + '\n\n' + feedbacks.join('\n\n');
    }
    const messages = [systemMessage, { role: 'user', content: userContent }];

    const response = await fetch(`${OPENROUTER_API_BASE}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages,
        response_format: { type: 'json_object' },
        temperature: 0.1,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      lastError = new Error(`OpenRouter API failed: ${response.status} ${text}`);
      if (round === MAX_ROUNDS) break;
      feedbacks.push(`Previous API request failed with status ${response.status}. Please retry and return the complete valid JSON placements for all missing notes. The full context and data are included above.`);
      continue;
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      lastError = new Error('OpenRouter response did not include message content');
      if (round === MAX_ROUNDS) break;
      feedbacks.push('The previous response had no message content. Please return only the exact required JSON object with placements for every missing note. The full context is provided above.');
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      lastError = new Error(`OpenRouter returned invalid JSON: ${content}`, { cause: error });
      if (round === MAX_ROUNDS) break;
      feedbacks.push(`The previous output was not valid JSON. Please return only the JSON object in the exact shape specified, with one placement per missing note using their exact "id" values from the data above.`);
      continue;
    }

    try {
      return validatePlacements(parsed.placements, missingNotes);
    } catch (error) {
      lastError = error;
      if (round === MAX_ROUNDS) break;
      const errorMsg = String(error.message || error);
      let feedback;
      if (errorMsg.includes('did not place all notes')) {
        const missing = errorMsg.split(': ').pop() || 'some notes';
        feedback = `WARNING: Your previous JSON did not place all notes. Specifically missing these IDs: ${missing}.

The full task context, current book structure, and complete "Missing notes" list (with all their "id" values) are provided in the first part of this message above.

You MUST output a complete "placements" array that contains an entry for EVERY one of those missing note IDs (using the exact "id" strings from the data above). Do not omit any again.`;
      } else {
        feedback = `Placements validation error: ${errorMsg}. The full context and data are above. Correct the issues and ensure there is a valid placement for each and every missing note ID listed.`;
      }
      feedbacks.push(feedback);
      continue;
    }
  }

  throw lastError || new Error(`Failed after ${MAX_ROUNDS} attempts to get complete placements from OpenRouter`);
}

function validatePlacements(placements, missingNotes) {
  if (!Array.isArray(placements)) {
    throw new Error('OpenRouter JSON must contain a placements array');
  }

  const missingIds = new Set(missingNotes.map((note) => note.id));
  const aliasToCanonicalId = new Map();
  for (const note of missingNotes) {
    for (const id of noteMatchIdentifiers(note)) {
      if (typeof id === 'string' && id.trim() !== '') {
        aliasToCanonicalId.set(id, note.id);
      }
    }
  }

  const seen = new Set();
  const normalizedPlacements = [];

  for (const placement of placements) {
    if (!placement || typeof placement !== 'object') throw new Error('Each placement must be an object');
    const normalizedId = normalizeMissingPlacementId(placement.id, aliasToCanonicalId);
    if (!normalizedId) throw new Error(`Unknown placement id: ${placement.id}`);
    if (seen.has(normalizedId)) throw new Error(`Duplicate placement id: ${normalizedId}`);
    if (typeof placement.section !== 'string' || placement.section.trim() === '') {
      throw new Error(`Placement for ${normalizedId} is missing a section`);
    }
    if (placement.afterId !== null && typeof placement.afterId !== 'string') {
      throw new Error(`Placement afterId for ${normalizedId} must be a string or null`);
    }
    if (typeof placement.linkTitle !== 'string' || placement.linkTitle.trim() === '') {
      throw new Error(`Placement for ${normalizedId} is missing a linkTitle`);
    }
    seen.add(normalizedId);
    normalizedPlacements.push({
      ...placement,
      id: normalizedId,
      section: placement.section.trim(),
      afterId: typeof placement.afterId === 'string' ? placement.afterId.trim() : null,
      linkTitle: placement.linkTitle.trim(),
    });
  }

  const missingPlacementIds = [...missingIds].filter((id) => !seen.has(id));
  if (missingPlacementIds.length > 0) {
    throw new Error(`OpenRouter did not place all notes: ${missingPlacementIds.join(', ')}`);
  }

  return normalizedPlacements;
}

function normalizeMissingPlacementId(value, aliasToCanonicalId) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (normalized === '') return null;
  return aliasToCanonicalId.get(normalized) ?? null;
}

function applyPlacements(book, missingNotes, placements) {
  const nextBook = structuredClone(book);
  const notesById = new Map(missingNotes.map((note) => [note.id, note]));
  const knownIds = collectExistingHackmdIds(nextBook);

  for (const placement of placements) {
    const note = notesById.get(placement.id);
    if (!note || knownIds.has(note.id)) continue;

    let section = nextBook.sections.find((candidate) => candidate.title === placement.section);
    if (!section) {
      section = { level: 2, title: placement.section, items: [], otherLines: [] };
      nextBook.sections.push(section);
    }

    const item = {
      indent: '',
      title: placement.linkTitle.trim() || note.title,
      href: note.link,
      raw: `- [${placement.linkTitle.trim() || note.title}](${note.link})`,
      noteId: note.shortId ?? note.id,
      canonicalNoteId: note.id,
    };

    const afterIndex = placement.afterId
      ? section.items.findIndex((candidate) => candidate.noteId === placement.afterId || candidate.canonicalNoteId === placement.afterId)
      : -1;

    if (afterIndex >= 0) {
      section.items.splice(afterIndex + 1, 0, item);
    } else {
      section.items.push(item);
    }

    knownIds.add(note.id);
    if (note.shortId) knownIds.add(note.shortId);
    for (const id of noteAliasIdentifiers(note)) {
      knownIds.add(id);
    }
  }

  return nextBook;
}

function noteIdentifiers(note) {
  return [note.id, note.shortId].filter(Boolean);
}

function noteAliasIdentifiers(note) {
  const ids = [];

  if (typeof note.publishLink === 'string') {
    ids.push(...extractHackmdNoteCandidates(note.publishLink));
  }

  return [...new Set(ids)];
}

function noteMatchIdentifiers(note) {
  return [...new Set([...noteIdentifiers(note), ...noteAliasIdentifiers(note)])];
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

function ensureString(value, message) {
  if (typeof value !== 'string') throw new Error(message);
  return value;
}

function trimTrailingBlankLines(lines) {
  const next = [...lines];
  while (next.length > 0 && next[next.length - 1] === '') next.pop();
  return next;
}

function trimOuterBlankLines(lines) {
  const next = [...lines];
  while (next.length > 0 && next[0] === '') next.shift();
  while (next.length > 0 && next[next.length - 1] === '') next.pop();
  return next;
}
