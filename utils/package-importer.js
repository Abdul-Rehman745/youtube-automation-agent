const fs = require('fs').promises;
const path = require('path');
const sharp = require('sharp');
const { getMediaDuration, runFFmpeg } = require('./ffmpeg');

function baseDir() {
  return process.env.DRIVE_IMAGES_PATH || null;
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function deriveTagsFromTitle(title = '') {
  const stopwords = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'for', 'with']);
  return String(title)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(word => word.length > 2 && !stopwords.has(word))
    .slice(0, 10);
}

// Folders that have already been imported or rejected are marked by renaming
// done.flag, so a re-scan never processes the same folder twice. Packages live
// under YouTube/data/incoming_DD_MM_YYYY_HHmm/, oldest processed first.
async function findReadyFolders() {
  const base = baseDir();
  if (!base) return [];

  const dataDir = path.join(base, 'data');
  let entries;
  try {
    entries = await fs.readdir(dataDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const ready = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^incoming_/i.test(entry.name)) continue;
    const dir = path.join(dataDir, entry.name);
    try {
      await fs.access(path.join(dir, 'done.flag'));
      const stat = await fs.stat(dir);
      ready.push({ dir, mtime: stat.mtimeMs });
    } catch {
      // not ready yet
    }
  }
  return ready.sort((a, b) => a.mtime - b.mtime).map(r => r.dir);
}

// When the external worker supplies only frames (Lumen owns script/audio/
// metadata), build production/final-video.mp4 ourselves from assets/frame_*.png
// + audio/voiceover.mp3, timed per manifest.frames[].timestamp. No-op if a
// final-video.mp4 already exists (the older "other AI builds everything" mode).
async function assembleFromFrames(dir) {
  const finalPath = path.join(dir, 'production', 'final-video.mp4');
  try {
    await fs.access(finalPath);
    return; // already assembled (or supplied ready-made)
  } catch {
    // needs assembling
  }

  const manifest = JSON.parse(await fs.readFile(path.join(dir, 'production', 'manifest.json'), 'utf8'));
  const audioPath = path.join(dir, 'audio', 'voiceover.mp3');
  const totalDuration = (await getMediaDuration(audioPath)) || manifest.targetDurationSeconds || 180;

  const frames = (manifest.frames || []).slice().sort((a, b) => a.timestamp - b.timestamp);
  const listPath = path.join(dir, 'production', 'frames_list.txt');
  const lines = [];
  for (let i = 0; i < frames.length; i++) {
    const framePath = path.join(dir, 'assets', frames[i].file);
    try {
      await fs.access(framePath);
    } catch {
      continue; // missing frame — skip it rather than fail the whole video
    }
    const next = frames[i + 1] ? frames[i + 1].timestamp : totalDuration;
    const duration = Math.max(0.1, next - frames[i].timestamp);
    lines.push(`file '${framePath.replace(/'/g, "'\\''")}'`, `duration ${duration.toFixed(3)}`);
  }
  if (!lines.length) throw new Error('No usable frame images found to assemble');
  lines.push(lines[lines.length - 2]); // repeat last file (required by concat demuxer to honor its duration)
  await fs.writeFile(listPath, lines.join('\n'));

  const visualPath = path.join(dir, 'production', 'visual.mp4');
  await runFFmpeg([
    '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
    '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,fps=30,format=yuv420p',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', visualPath
  ]);
  await runFFmpeg([
    '-y', '-i', visualPath, '-i', audioPath,
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-shortest', finalPath
  ]);
  await fs.unlink(listPath).catch(() => {});
  await fs.unlink(visualPath).catch(() => {});
}

async function validatePackage(dir) {
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(dir, 'production', 'manifest.json'), 'utf8'));
  } catch {
    return { valid: false, reason: 'production/manifest.json is missing or not valid JSON' };
  }

  if (!manifest.title) {
    return { valid: false, reason: 'manifest.json has no title' };
  }

  const videoPath = path.join(dir, 'production', 'final-video.mp4');
  let videoStat;
  try {
    videoStat = await fs.stat(videoPath);
  } catch {
    return { valid: false, reason: 'production/final-video.mp4 is missing' };
  }
  if (videoStat.size === 0) {
    return { valid: false, reason: 'final-video.mp4 is zero bytes' };
  }

  const duration = await getMediaDuration(videoPath);
  if (!duration) {
    return { valid: false, reason: 'final-video.mp4 is not a playable video' };
  }

  const target = Number(manifest.targetDurationSeconds) || 180;
  if (Math.abs(duration - target) > 20) {
    return { valid: false, reason: `video duration ${Math.round(duration)}s is far from the ${target}s target` };
  }

  const thumbPath = path.join(dir, 'thumbnail-templates', 'thumbnail.png');
  let thumbDims = null;
  try {
    const meta = await sharp(thumbPath).metadata();
    thumbDims = { width: meta.width, height: meta.height };
  } catch {
    // Video is what actually matters — a missing/bad thumbnail degrades
    // gracefully rather than blocking the whole video.
  }

  // final-video.mp4 already has narration muxed in. Prefer the standalone
  // voiceover file if present, otherwise the video itself still satisfies
  // "narration exists and is audible" for the publishing gate.
  const voiceoverPath = path.join(dir, 'audio', 'voiceover.mp3');
  let audioPath = videoPath;
  try {
    const stat = await fs.stat(voiceoverPath);
    if (stat.size > 0) audioPath = voiceoverPath;
  } catch {
    // fall back to videoPath
  }

  return {
    valid: true,
    dir,
    manifest,
    videoPath,
    videoDuration: duration,
    videoSize: videoStat.size,
    thumbPath: thumbDims ? thumbPath : null,
    thumbDims,
    audioPath
  };
}

// Keeps the external AI's title/description/tags when they're already solid;
// only fills what's missing/weak, and always adds hashtags (never supplied by
// the manifest contract) via the existing SEO agent — one Gemini call per import.
async function ensureMetadataComplete(agents, manifest, logger) {
  const suppliedTags = Array.isArray(manifest.tags) ? manifest.tags : [];
  const seedTags = suppliedTags.length ? suppliedTags : deriveTagsFromTitle(manifest.title);
  const strategy = { topic: manifest.title, keywords: seedTags, targetAudience: manifest.audience || '', contentType: 'Story' };

  let seo = null;
  try {
    seo = await agents.seoOptimizer.optimize({ title: manifest.title }, strategy);
  } catch (error) {
    logger.warn(`SEO completion failed, using manifest metadata as-is: ${error.message}`);
  }

  const title = manifest.title && manifest.title.length <= 100
    ? manifest.title
    : (seo?.title || manifest.title || '').slice(0, 100);

  let description = manifest.description?.trim() || seo?.description || manifest.title;
  if (seo?.hashtags?.length) description = `${description}\n\n${seo.hashtags.join(' ')}`;

  const tags = suppliedTags.length >= 3 ? suppliedTags : (seo?.tags?.length ? seo.tags : seedTags);

  return { title, description, tags };
}

// The external worker may also drop a fuller production/youtube-metadata.json
// (title/description/tags/hashtags/category/language/madeForKids/privacyStatus)
// — when present it's more complete than manifest.json, so it wins outright.
async function readYouTubeMetadata(dir) {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, 'production', 'youtube-metadata.json'), 'utf8'));
  } catch {
    return null;
  }
}

async function importPackage(db, agents, logger, v) {
  const id = `pkg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const manifest = v.manifest;
  const ytMeta = await readYouTubeMetadata(v.dir);

  let metadata;
  if (ytMeta?.title) {
    let description = ytMeta.description || manifest.description || ytMeta.title;
    if (ytMeta.hashtags?.length && !ytMeta.description?.includes(ytMeta.hashtags[0])) {
      description = `${description}\n\n${ytMeta.hashtags.join(' ')}`;
    }
    metadata = {
      title: ytMeta.title.slice(0, 100),
      description,
      tags: ytMeta.tags?.length ? ytMeta.tags : deriveTagsFromTitle(ytMeta.title),
      categoryId: ytMeta.categoryId,
      defaultLanguage: ytMeta.language,
      madeForKids: ytMeta.audience?.madeForKids === true,
      privacyStatus: ytMeta.privacyStatus
    };
  } else {
    metadata = await ensureMetadataComplete(agents, manifest, logger);
  }

  const thumbnailAsset = v.thumbPath ? {
    path: v.thumbPath,
    dimensions: v.thumbDims,
    fileSize: (await fs.stat(v.thumbPath)).size,
    generatedWith: 'AI'
  } : null;

  const audioAsset = v.audioPath ? {
    path: v.audioPath,
    duration: formatDuration(v.videoDuration),
    format: 'mp3',
    status: 'ready',
    simulated: false,
    provider: 'external',
    model: 'external-production-worker',
    generatedAt: new Date().toISOString()
  } : { path: null, simulated: true };

  const finalVideoAsset = {
    path: v.videoPath,
    duration: formatDuration(v.videoDuration),
    format: 'mp4',
    resolution: manifest.resolution || '1920x1080',
    generatedWith: 'AI',
    simulated: false,
    fileSize: v.videoSize
  };

  const productionData = {
    id,
    status: 'processing',
    script: { title: metadata.title },
    strategy: { topic: metadata.title, targetAudience: manifest.audience || '' },
    seo: metadata,
    assets: {
      thumbnail: thumbnailAsset,
      audio: audioAsset,
      video: {
        visualAssets: [],
        duration: formatDuration(v.videoDuration),
        format: 'mp4',
        resolution: manifest.resolution || '1920x1080',
        generatedWith: 'AI'
      },
      finalVideo: finalVideoAsset,
      captions: null
    },
    timeline: { created: new Date().toISOString(), readyForUpload: new Date().toISOString() },
    scheduledPublishTime: new Date().toISOString(),
    priority: 60,
    estimatedDuration: formatDuration(v.videoDuration),
    privacyStatus: metadata.privacyStatus || process.env.DEFAULT_PRIVACY_STATUS || 'private',
    contentType: 'long_form',
    containsSyntheticMedia: false,
    madeForKids: metadata.madeForKids === true
  };

  await db.saveProductionData(productionData);
  await db.saveProductionSnapshot(productionData);
  await db.saveContentReview(id, {
    status: 'approved',
    qualityChecks: [{ id: 'external_package_import', label: 'External production package validated', passed: true }],
    reviewNotes: 'Auto-approved: complete package imported from the external production worker.',
    reviewedAt: new Date().toISOString()
  });

  const scheduleEntry = await agents.publishing.scheduleContent(productionData);
  if (scheduleEntry) {
    await db.updateProductionStatus(id, 'scheduled');
    logger.success(`Imported and scheduled: ${manifest.title} (${id})`);
  } else {
    await db.updateProductionStatus(id, 'needs_attention');
    logger.warn(`Imported but NOT scheduled (publishing agent rejected it): ${manifest.title} (${id})`);
  }

  return { id, scheduled: Boolean(scheduleEntry), title: manifest.title };
}

async function runImport(db, agents, logger) {
  const folders = await findReadyFolders();
  const results = { imported: [], rejected: [] };

  for (const dir of folders) {
    // Atomic claim: rename wins for exactly one concurrent caller. If a second
    // runImport (e.g. the cron and a manual dashboard click landing at the same
    // moment) reaches this folder after, done.flag is already gone and it skips.
    const claimed = path.join(dir, 'done.processing');
    try {
      await fs.rename(path.join(dir, 'done.flag'), claimed);
    } catch {
      continue; // already claimed by another run, or no longer ready
    }

    try {
      await assembleFromFrames(dir);
    } catch (error) {
      logger.error(`Frame assembly failed at ${dir}: ${error.message}`);
      await fs.rename(claimed, path.join(dir, 'done.invalid')).catch(() => {});
      results.rejected.push({ dir, reason: `assembly failed: ${error.message}` });
      continue;
    }

    const validation = await validatePackage(dir);
    if (!validation.valid) {
      logger.error(`Rejecting incomplete package at ${dir}: ${validation.reason}`);
      await fs.rename(claimed, path.join(dir, 'done.invalid')).catch(() => {});
      results.rejected.push({ dir, reason: validation.reason });
      continue;
    }

    try {
      const outcome = await importPackage(db, agents, logger, validation);
      await fs.rename(claimed, path.join(dir, 'done.imported')).catch(() => {});
      results.imported.push({ dir, ...outcome });
    } catch (error) {
      logger.error(`Failed to import package at ${dir}:`, error);
      await fs.rename(claimed, path.join(dir, 'done.invalid')).catch(() => {});
      results.rejected.push({ dir, reason: error.message });
    }
  }

  return results;
}

module.exports = { runImport, findReadyFolders, validatePackage };
