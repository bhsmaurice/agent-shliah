'use strict';
// Local inputs only; no shell interpolation or remote-media execution.
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
async function renderClip(image, audio, output, start = 0) {
  if (!Number.isFinite(Number(start)) || Number(start) < 0) throw new Error('Début audio invalide');
  const ffmpeg = process.env.FFMPEG_PATH || require('ffmpeg-static');
  await promisify(execFile)(ffmpeg, ['-nostdin', '-y', '-loop', '1', '-i', path.resolve(image), '-ss', String(start), '-i', path.resolve(audio), '-map', '0:v:0', '-map', '1:a:0', '-t', '15', '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:white,setsar=1', '-c:v', 'libx264', '-preset', 'veryfast', '-threads', '1', '-tune', 'stillimage', '-r', '25', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-af', 'afade=t=in:st=0:d=0.5,afade=t=out:st=13:d=2', '-movflags', '+faststart', '-shortest', path.resolve(output)], { timeout: 120000, maxBuffer: 1024 * 1024 });
}
if (require.main === module) {
  const [image, audio, output, start = 0] = process.argv.slice(2);
  if (!image || !audio || !output) { console.error('Usage: node render-clip.js image audio sortie.mp4 [début_secondes]'); process.exitCode = 1; }
  else renderClip(image, audio, output, Number(start)).catch(() => { console.error('Création du clip impossible. Vérifier les fichiers et FFmpeg.'); process.exitCode = 1; });
}
module.exports = { renderClip };
