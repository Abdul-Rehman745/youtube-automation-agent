const fs = require('fs').promises;
const path = require('path');
const { getMediaDuration } = require('./ffmpeg');

const FRAME_COUNT = 100;

function pad2(n) { return String(n).padStart(2, '0'); }

function folderName(date) {
  return `incoming_${pad2(date.getDate())}_${pad2(date.getMonth() + 1)}_${date.getFullYear()}_0800`;
}

function deriveTagsFromTitle(title = '') {
  const stopwords = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'for', 'with']);
  return String(title).toLowerCase().split(/[^a-z0-9]+/)
    .filter(w => w.length > 2 && !stopwords.has(w)).slice(0, 10);
}

// One Gemini call asking for all 100 timed, visually-distinct frame prompts.
// Falls back to a simple interpolation over existing script sections if the
// model output doesn't parse cleanly — the pipeline should never hard-fail
// here just because an LLM response was malformed.
async function buildFramePrompts(aiTextService, script, style, totalDuration) {
  if (aiTextService.isAvailable()) {
    const prompt = `You are planning the visuals for a ${Math.round(totalDuration)}-second animated children's video titled "${script.title}".
Return ONLY a JSON array of exactly ${FRAME_COUNT} objects, evenly spaced across the video, each:
{"timestamp": number (seconds, 0 to ${Math.round(totalDuration)}), "prompt": "short visual scene description, ${style}"}
Keep character appearance and setting consistent across frames. Show visual progression matching this story outline:
${JSON.stringify((script.mainContent?.sections || []).map(s => s.title || s.content).slice(0, 20))}
Return only the JSON array, no other text.`;

    try {
      const response = await aiTextService.generateText(prompt, { maxTokens: 6000, temperature: 0.7 });
      const match = response.match(/\[[\s\S]*\]/);
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed) && parsed.length >= FRAME_COUNT * 0.9) {
        return parsed.slice(0, FRAME_COUNT).map((f, i) => ({
          file: `frame_${String(i + 1).padStart(4, '0')}.png`,
          timestamp: Number(f.timestamp) || (i / FRAME_COUNT) * totalDuration,
          prompt: String(f.prompt || script.title).slice(0, 500)
        }));
      }
    } catch {
      // fall through to algorithmic fallback below
    }
  }

  const sections = (script.mainContent?.sections || []).map(s => s.title || s.content).filter(Boolean);
  const base = sections.length ? sections : [script.title];
  return Array.from({ length: FRAME_COUNT }, (_, i) => ({
    file: `frame_${String(i + 1).padStart(4, '0')}.png`,
    timestamp: (i / FRAME_COUNT) * totalDuration,
    prompt: `${base[i % base.length]}, ${style}`
  }));
}

async function prepareNextProduction(agents, db, logger) {
  const base = process.env.DRIVE_IMAGES_PATH;
  if (!base) return null;

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dir = path.join(base, 'data', folderName(tomorrow));

  try {
    await fs.access(path.join(dir, 'production', 'manifest.json'));
    logger.info(`Next production already prepared: ${dir}`);
    return dir;
  } catch {
    // doesn't exist yet, continue
  }

  logger.info('Preparing next production (script, narration, metadata)...');
  const profile = (db.getChannelProfile && await db.getChannelProfile()) || {};
  const style = profile.visual_style || 'bright, colorful, friendly, consistent characters';

  const strategy = await agents.strategy.generateContentStrategy();
  const script = await agents.scriptWriter.generateScript(strategy);
  const ttsText = agents.production.formatScriptForTTS(script);

  await fs.mkdir(path.join(dir, 'audio'), { recursive: true });
  await fs.mkdir(path.join(dir, 'scripts'), { recursive: true });
  await fs.mkdir(path.join(dir, 'production'), { recursive: true });
  await fs.mkdir(path.join(dir, 'assets'), { recursive: true });
  await fs.mkdir(path.join(dir, 'thumbnail-templates'), { recursive: true });

  const audioPath = path.join(dir, 'audio', 'voiceover.mp3');
  await agents.production.aiVideoGenerator.generateTTSAudio(ttsText, audioPath);
  const duration = (await getMediaDuration(audioPath)) || 180;

  await fs.writeFile(path.join(dir, 'scripts', 'story.txt'), ttsText);
  await fs.writeFile(path.join(dir, 'scripts', 'narration.txt'), ttsText);

  const frames = await buildFramePrompts(agents.strategy.aiTextService, script, style, duration);
  const tags = deriveTagsFromTitle(script.title);

  await fs.writeFile(path.join(dir, 'production', 'manifest.json'), JSON.stringify({
    title: script.title,
    targetDurationSeconds: Math.round(duration),
    aspectRatio: '16:9',
    resolution: '1920x1080',
    style,
    audience: profile.target_audience || '',
    avoid: profile.bannedTopics || [],
    callToAction: profile.call_to_action || '',
    frames,
    thumbnailPrompt: `${script.title}, YouTube thumbnail, bold text-safe composition, ${style}`
  }, null, 2));

  await fs.writeFile(path.join(dir, 'production', 'youtube-metadata.json'), JSON.stringify({
    title: script.title.slice(0, 100),
    description: `${script.title}\n\n${profile.call_to_action || ''}`.trim(),
    tags,
    hashtags: tags.slice(0, 5).map(t => `#${t.replace(/\s+/g, '')}`),
    category: 'Film & Animation',
    categoryId: '1',
    language: 'en',
    defaultAudioLanguage: 'en',
    audience: { madeForKids: true },
    privacyStatus: process.env.DEFAULT_PRIVACY_STATUS || 'private',
    license: 'youtube',
    embeddable: true,
    publicStatsViewable: true
  }, null, 2));

  logger.success(`Next production prepared: ${script.title} -> ${dir}`);
  return dir;
}

module.exports = { prepareNextProduction, buildFramePrompts, folderName, FRAME_COUNT };
