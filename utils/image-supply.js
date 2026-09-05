const fs = require('fs').promises;
const path = require('path');

function baseDir() {
  return process.env.DRIVE_IMAGES_PATH || null;
}

function todayFolder(date = new Date()) {
  const base = baseDir();
  if (!base) return null;
  return path.join(base, 'incoming', date.toISOString().slice(0, 10));
}

async function writePrompts(scenePrompts, thumbnailPrompt, spec = {}, date = new Date()) {
  const dir = todayFolder(date);
  if (!dir) return null;

  await fs.mkdir(dir, { recursive: true });
  const payload = {
    date: date.toISOString().slice(0, 10),
    aspectRatio: spec.aspectRatio || '16:9',
    resolution: spec.resolution || '1920x1080',
    style: spec.style || '',
    audience: spec.audience || '',
    avoid: spec.avoid || [],
    scenes: scenePrompts.map((prompt, i) => ({ file: `scene_${i + 1}.png`, prompt })),
    thumbnail: { file: 'thumbnail.png', prompt: thumbnailPrompt }
  };
  await fs.writeFile(path.join(dir, 'prompts.json'), JSON.stringify(payload, null, 2));
  return dir;
}

async function isReady(date = new Date()) {
  const dir = todayFolder(date);
  if (!dir) return false;
  try {
    await fs.access(path.join(dir, 'done.flag'));
    return true;
  } catch {
    return false;
  }
}

// Returns the next unconsumed scene_N.png (lowest number first) and moves it
// into a .consumed subfolder so a later call in the same run doesn't reuse it.
async function takeNextScene(date = new Date()) {
  const dir = todayFolder(date);
  if (!dir || !(await isReady(date))) return null;

  let files;
  try {
    files = await fs.readdir(dir);
  } catch {
    return null;
  }

  const sceneFiles = files
    .filter(f => /^scene_\d+\.png$/i.test(f))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));

  if (!sceneFiles.length) return null;

  const chosen = sceneFiles[0];
  const consumedDir = path.join(dir, '.consumed');
  await fs.mkdir(consumedDir, { recursive: true });
  const destPath = path.join(consumedDir, chosen);
  await fs.rename(path.join(dir, chosen), destPath);
  return destPath;
}

async function takeThumbnail(date = new Date()) {
  const dir = todayFolder(date);
  if (!dir || !(await isReady(date))) return null;

  const src = path.join(dir, 'thumbnail.png');
  try {
    await fs.access(src);
  } catch {
    return null;
  }

  const consumedDir = path.join(dir, '.consumed');
  await fs.mkdir(consumedDir, { recursive: true });
  const dest = path.join(consumedDir, 'thumbnail.png');
  await fs.rename(src, dest);
  return dest;
}

module.exports = { writePrompts, isReady, takeNextScene, takeThumbnail, todayFolder };
