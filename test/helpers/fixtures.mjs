// 撮影用と同じく、テスト素材はその場で ffmpeg で作る。
// 実素材（testdata/）は git 管理外なので、それに依存させない。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
export const DIR = join(ROOT, 'test/.fixtures');
const ff = (args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);

/** @returns {{video:string, audio:string, image:string}} ルートからの相対パス（URL に使う） */
export function ensureFixtures() {
  mkdirSync(DIR, { recursive: true });
  const rel = (n) => `test/.fixtures/${n}`;
  const video = join(DIR, 'clip.mp4');
  if (!existsSync(video)) {
    ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=20',
        '-f', 'lavfi', '-i', 'sine=frequency=300:duration=20',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video]);
  }
  const audio = join(DIR, 'se.mp3');
  if (!existsSync(audio)) {
    ff(['-f', 'lavfi', '-i', 'sine=frequency=880:duration=1', '-c:a', 'libmp3lame', audio]);
  }
  const image = join(DIR, 'logo.png');
  if (!existsSync(image)) {
    ff(['-f', 'lavfi', '-i', 'color=c=0x2f6fd0@1:size=400x120,format=rgba', '-frames:v', '1', image]);
  }
  return { video: rel('clip.mp4'), audio: rel('se.mp3'), image: rel('logo.png') };
}

export function haveFfmpeg() {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; }
}
