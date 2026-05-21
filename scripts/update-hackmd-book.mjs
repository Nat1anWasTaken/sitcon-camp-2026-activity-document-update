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
  return response.json();
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
    'Keep meeting notes in chronological order when titles indicate meeting sequence. Keep long-lived references under 長期, recruiting under 招募, and broad discussion under 其他討論.',
    'Return only valid JSON with this exact shape:',
    '{"placements":[{"id":"note id","section":"section title","afterId":"existing or newly placed note id, or null to append to section"}]}',
    '',
    `Current book structure:\n${JSON.stringify(currentStructure, null, 2)}`,
    '',
    `Missing notes:\n${JSON.stringify(missingNotes, null, 2)}`,
  ].join('\n');

  const response = await fetch(`${OPENROUTER_API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      ...(OPENROUTER_SITE_URL ? { 'HTTP-Referer': OPENROUTER_SITE_URL } : {}),
      ...(OPENROUTER_APP_NAME ? { 'X-Title': OPENROUTER_APP_NAME } : {}),
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages: [
        {
          role: 'system',
          content: 'You classify markdown documents into a HackMD book-mode outline. Return strict JSON only.',
        },
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenRouter API failed: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenRouter response did not include message content');

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`OpenRouter returned invalid JSON: ${content}`, { cause: error });
  }

  return validatePlacements(parsed.placements, missingNotes);
}

function validatePlacements(placements, missingNotes) {
  if (!Array.isArray(placements)) {
    throw new Error('OpenRouter JSON must contain a placements array');
  }

  const missingIds = new Set(missingNotes.map((note) => note.id));
  const seen = new Set();

  for (const placement of placements) {
    if (!placement || typeof placement !== 'object') throw new Error('Each placement must be an object');
    if (!missingIds.has(placement.id)) throw new Error(`Unknown placement id: ${placement.id}`);
    if (seen.has(placement.id)) throw new Error(`Duplicate placement id: ${placement.id}`);
    if (typeof placement.section !== 'string' || placement.section.trim() === '') {
      throw new Error(`Placement for ${placement.id} is missing a section`);
    }
    if (placement.afterId !== null && typeof placement.afterId !== 'string') {
      throw new Error(`Placement afterId for ${placement.id} must be a string or null`);
    }
    seen.add(placement.id);
  }

  const missingPlacementIds = [...missingIds].filter((id) => !seen.has(id));
  if (missingPlacementIds.length > 0) {
    throw new Error(`OpenRouter did not place all notes: ${missingPlacementIds.join(', ')}`);
  }

  return placements;
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
      title: note.title,
      href: note.link,
      raw: `- [${note.title}](${note.link})`,
      noteId: note.id,
    };

    const afterIndex = placement.afterId
      ? section.items.findIndex((candidate) => candidate.noteId === placement.afterId)
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
